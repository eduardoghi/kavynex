use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tokio::{
    io::{AsyncRead, AsyncReadExt, BufReader},
    process::Command,
    time::timeout,
};

use crate::models::yt_dlp::{
    YtDlpComment, YtDlpCommentMetadata, YtDlpFormatOption, YtDlpFormatsResult, YtDlpMetadata,
};
use crate::services::binaries::resolve_yt_dlp_binary_async;
use crate::services::yt_dlp_cookies::append_auth_args;
use crate::services::yt_dlp_registry::{register_download_run, DownloadRunReleaseGuard};
use crate::services::yt_dlp_url::{is_allowed_youtube_url, youtube_ref_for_log};
use crate::utils::format::{codec_is_present, normalize_yt_dlp_upload_date};
use crate::utils::io::{read_lossy_line, read_lossy_line_capped, MAX_PROGRESS_LINE_BYTES};
use crate::utils::process::hide_console_async;
use crate::{AppError, AppErrorCode, AppResult};

const YT_DLP_METADATA_TIMEOUT_SECS: u64 = 60;
const YT_DLP_COMMENTS_TIMEOUT_SECS: u64 = 180;
// Cap on how much yt-dlp stdout is buffered. `--dump-single-json` (with `--write-comments`)
// emits the whole payload as one line, so an extreme video could otherwise allocate GBs.
// Generous: even very large comment sets fit well under this.
const MAX_YT_DLP_JSON_BYTES: u64 = 128 * 1024 * 1024; // 128 MiB

// Cap on the stderr log lines kept from a metadata/comments/format run and handed to the frontend
// as `terminal_logs`. `-v` is always passed, so a chatty failure can emit thousands of lines;
// keep only the most recent, matching yt_dlp_download's stderr ring buffer.
const MAX_CAPTURED_STDERR_LINES: usize = 100;

/// Reads yt-dlp stdout, keeping the JSON payload line and the useful log lines, but never
/// buffering more than `max_bytes`. Returns `(json_payload, log_lines, overflowed)`, where
/// `overflowed` means the output exceeded the cap (and the payload may be truncated).
async fn read_capped_json_stdout<R>(reader: R, max_bytes: u64) -> (String, Vec<String>, bool)
where
    R: AsyncRead + Unpin,
{
    // `+ 1` so reading exactly `max_bytes + 1` reveals the real output exceeded the cap.
    let mut reader = BufReader::new(reader.take(max_bytes + 1));
    let mut line_buf: Vec<u8> = Vec::new();
    let mut json_payload = String::new();
    let mut log_lines: Vec<String> = Vec::new();
    let mut total_bytes: u64 = 0;

    while let Some(line_value) = read_lossy_line(&mut reader, &mut line_buf).await {
        total_bytes += line_value.len() as u64 + 1;

        let line = line_value.trim_end().to_string();

        if line.trim().is_empty() {
            continue;
        }

        if is_json_payload_line(&line) {
            json_payload = line;
        } else if should_keep_terminal_line(&line) {
            log_lines.push(line);
        }
    }

    (json_payload, log_lines, total_bytes > max_bytes)
}

type NormalizedDownloadMetadata = (String, String, String, Option<String>, Option<String>);

pub fn sanitize_filename_component(value: &str) -> String {
    let sanitized: String = value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();

    let compact = sanitized
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_");

    if compact.is_empty() {
        return "media".to_string();
    }

    // yt-dlp reads a leading '-' as an option, so a component that sanitizes to one starting with
    // '-' is prefixed with '_'. Rare (extractor/id come from yt-dlp's own extractor, not free-form
    // text), but this mirrors the leading-dash guard in yt_dlp_download::is_valid_format_id and
    // keeps the value safe wherever the resulting file_prefix feeds an argv position.
    let guarded = if compact.starts_with('-') {
        format!("_{compact}")
    } else {
        compact
    };

    // A component that sanitizes to a Windows reserved device name (CON, NUL, COM1, ...) would make
    // the resulting file unusable on Windows. In practice the download filename joins three such
    // components as extractor_id_formatid, so a bare reserved stem is not normally reachable, but
    // prefix it with '_' as defense in depth - mirroring the leading-dash guard above and the
    // reserved-name rejection in utils::path::sanitize_relative_path_strict.
    if crate::utils::path::is_windows_reserved_name(&guarded) {
        format!("_{guarded}")
    } else {
        guarded
    }
}

/// Sanitizes the value that identifies the downloaded media (the video id) for use in a
/// filename, disambiguating collisions. `sanitize_filename_component` maps every character
/// outside `[A-Za-z0-9._-]` to `_` and collapses runs of `_`, so two distinct ids can map to the
/// same string (e.g. `a__b` and `a_b` both become `a_b`, or a future non-YouTube id containing
/// `:`/`/`). The download filename is derived from this and `place_downloaded_file` never
/// overwrites an existing destination, so a collision would silently discard the second video.
///
/// When sanitization actually changes the value, a short hash of the ORIGINAL is appended so
/// distinct ids get distinct filenames. A value that survives sanitization unchanged - the
/// overwhelming majority of YouTube ids - keeps its exact name, so filenames of already
/// downloaded media are unaffected.
pub fn sanitize_identifier_component(value: &str) -> String {
    let trimmed = value.trim();
    let sanitized = sanitize_filename_component(trimmed);

    if trimmed.is_empty() || sanitized == trimmed {
        return sanitized;
    }

    format!("{sanitized}_{}", short_identifier_hash(trimmed))
}

/// First 10 lowercase-hex chars (40 bits) of the SHA-256 of `value` - enough to disambiguate the
/// handful of ids that could share a sanitized form, without bloating the filename.
fn short_identifier_hash(value: &str) -> String {
    use sha2::{Digest, Sha256};

    Sha256::digest(value.as_bytes())
        .iter()
        .take(5)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn is_json_payload_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with('{') || trimmed.starts_with('[')
}

fn should_keep_terminal_line(line: &str) -> bool {
    let trimmed = line.trim();

    if trimmed.is_empty() {
        return false;
    }

    if is_json_payload_line(trimmed) {
        return false;
    }

    true
}

/// Substrings yt-dlp emits when a video requires age verification. Shared by the friendly-hint
/// detection and the error-detail preference so both recognize the same signal from one list.
const AGE_RESTRICTION_MARKERS: [&str; 4] = [
    "sign in to confirm your age",
    "this video is age-restricted",
    "age-restricted",
    "login_required",
];

fn contains_age_restriction_marker(normalized_line: &str) -> bool {
    AGE_RESTRICTION_MARKERS
        .iter()
        .any(|marker| normalized_line.contains(marker))
}

fn is_age_restriction_error_line(line: &str) -> bool {
    let normalized = line.trim().to_lowercase();

    contains_age_restriction_marker(&normalized)
        || normalized.contains("may be inappropriate for some users")
}

fn build_friendly_terminal_hints(stdout_logs: &[String], stderr_logs: &[String]) -> Vec<String> {
    let has_age_restriction = stdout_logs
        .iter()
        .chain(stderr_logs.iter())
        .any(|line| is_age_restriction_error_line(line));

    let mut hints = Vec::new();

    if has_age_restriction {
        hints.push("INFO: This YouTube video requires age verification.".to_string());
        hints.push(
            "INFO: Use cookies from a logged-in account that has already completed age verification."
                .to_string(),
        );
        hints.push(
            "INFO: In Authentication, choose a browser already logged into YouTube or provide a cookies.txt file from a verified account."
                .to_string(),
        );
    }

    hints
}

/// Redacts a cookies file path from a yt-dlp log line before it can surface to the frontend.
///
/// yt-dlp is run with `-v`, and its captured stdout/stderr reaches the frontend on two paths:
/// as the `terminal_logs` of `list_yt_dlp_formats_async` on success, and as the error
/// `details` built from `select_best_error_detail` on failure (which is also written to the
/// file log). yt-dlp's verbose mode prints a `[debug] Command-line config: [...]` line that
/// echoes the full argv verbatim, including the value passed to `--cookies`. That local
/// filesystem path can reveal the user's OS username/profile layout, and such a line may end
/// up pasted into a public bug report, so any occurrence of the path is replaced regardless of
/// which line it shows up in (the `Command-line config` echo, or any other yt-dlp message that
/// happens to mention it).
///
/// The match is not a bare substring compare. yt-dlp's argv echo prints the path verbatim, but
/// another message could print it with the separators swapped (yt-dlp normalizes to `/` internally
/// on Windows) or with a different ASCII casing (Windows paths are case-insensitive). Each of those
/// full-path forms is redacted. The bare filename is deliberately left alone: it is generic
/// ("cookies.txt"), appears in benign hint text, and does not reveal the user's profile layout - it
/// is the directory portion that does.
pub(crate) fn redact_cookies_path_from_line(line: &str, cookies_path: Option<&str>) -> String {
    let Some(path) = cookies_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return line.to_string();
    };

    // The plausible representations of the same full path: verbatim, and with either separator
    // convention. Case is handled by the ASCII-insensitive matcher below.
    let variants = [
        path.to_string(),
        path.replace('\\', "/"),
        path.replace('/', "\\"),
    ];

    let mut result = line.to_string();
    for variant in variants {
        result = replace_ascii_case_insensitive(&result, &variant, "<redacted>");
    }
    result
}

/// Sanitizes a yt-dlp `-v` log line before it reaches the frontend/file log: redacts the cookies
/// file path (see [`redact_cookies_path_from_line`]) and reduces the full pasted URL to the same
/// privacy-preserving reference the download flow logs (`youtube_ref_for_log`), so playlist and
/// tracking parameters do not survive into a log a user might paste into a public issue.
pub(crate) fn redact_sensitive_from_line(
    line: &str,
    cookies_path: Option<&str>,
    url: &str,
) -> String {
    let redacted = redact_cookies_path_from_line(line, cookies_path);
    let url = url.trim();

    if url.is_empty() {
        return redacted;
    }

    redacted.replace(url, &youtube_ref_for_log(url))
}

/// Replaces every ASCII-case-insensitive occurrence of `needle` in `haystack`. Uses
/// `to_ascii_lowercase`, which only folds ASCII `A-Z` and so is byte-length preserving: an offset
/// found in the lowercased copy indexes the original correctly even when the path carries non-ASCII
/// bytes (a Unicode username), so this never slices a UTF-8 char boundary.
fn replace_ascii_case_insensitive(haystack: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return haystack.to_string();
    }

    let haystack_lower = haystack.to_ascii_lowercase();
    let needle_lower = needle.to_ascii_lowercase();

    let mut result = String::with_capacity(haystack.len());
    let mut cursor = 0;
    while let Some(offset) = haystack_lower[cursor..].find(&needle_lower) {
        let start = cursor + offset;
        result.push_str(&haystack[cursor..start]);
        result.push_str(replacement);
        cursor = start + needle.len();
    }
    result.push_str(&haystack[cursor..]);
    result
}

/// Extracts the value passed to `--cookies` in an argv, so a failure `detail` built from
/// yt-dlp's verbose output can have that local path redacted even though the caller only hands
/// this function the fully-built args. `--cookies-from-browser` is not returned: it carries a
/// browser name, not a filesystem path.
fn cookies_path_from_args(args: &[String]) -> Option<&str> {
    args.iter()
        .position(|arg| arg == "--cookies")
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

fn is_traceback_noise(line: &str) -> bool {
    let trimmed = line.trim();
    let normalized = trimmed.to_lowercase();

    trimmed.starts_with("File \"")
        || normalized.starts_with("traceback")
        || normalized.starts_with("during handling of the above exception")
        || normalized.contains(" in raise_no_formats")
}

fn is_preferred_error_detail(line: &str) -> bool {
    let normalized = line.trim().to_lowercase();

    contains_age_restriction_marker(&normalized) || normalized.starts_with("error:")
}

fn select_best_error_detail(
    stdout_logs: &[String],
    stderr_logs: &[String],
    failed_message: &str,
) -> String {
    if let Some(line) = stderr_logs
        .iter()
        .rev()
        .find(|line| is_preferred_error_detail(line))
    {
        return line.clone();
    }

    if let Some(line) = stdout_logs
        .iter()
        .rev()
        .find(|line| is_preferred_error_detail(line))
    {
        return line.clone();
    }

    if let Some(line) = stderr_logs
        .iter()
        .rev()
        .find(|line| !line.trim().is_empty() && !is_traceback_noise(line))
    {
        return line.clone();
    }

    if let Some(line) = stdout_logs
        .iter()
        .rev()
        .find(|line| !line.trim().is_empty() && !is_traceback_noise(line))
    {
        return line.clone();
    }

    stderr_logs
        .iter()
        .rev()
        .find(|line| !line.trim().is_empty())
        .cloned()
        .or_else(|| {
            stdout_logs
                .iter()
                .rev()
                .find(|line| !line.trim().is_empty())
                .cloned()
        })
        .unwrap_or_else(|| failed_message.to_string())
}

#[allow(clippy::too_many_arguments)]
async fn run_yt_dlp_and_capture_json(
    yt_dlp: &str,
    args: &[String],
    timeout_secs: u64,
    timeout_code: AppErrorCode,
    exec_code: AppErrorCode,
    failed_code: AppErrorCode,
    timeout_message: &str,
    exec_message: &str,
    failed_message: &str,
    cancel: Option<Arc<AtomicBool>>,
) -> AppResult<(String, Vec<String>, Vec<String>)> {
    let mut command = Command::new(yt_dlp);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Any early return below (timeout, pipe capture failure) must not leave yt-dlp
        // running unsupervised in the background.
        .kill_on_drop(true);
    hide_console_async(&mut command);
    // yt-dlp can spawn an ffmpeg child (e.g. `-x`/`--convert-*`); put it in its own process
    // group so a timeout can terminate the whole tree, not just the direct child.
    crate::utils::process::configure_process_group(&mut command);

    let mut child = command
        .spawn()
        .map_err(|e| AppError::from_code(exec_code, format!("{exec_message}: {e}")))?;
    let child_pid = child.id();
    // Track this yt-dlp child (metadata/comments/format listing) globally so the app-exit
    // handler tree-kills it too; the per-download registry only knows the main download child,
    // which spawns after this phase. Unregisters when this function returns.
    let _tracked_child = crate::services::process_registry::TrackedChildGuard::register(child_pid);

    let stdout = child.stdout.take().ok_or_else(|| {
        AppError::from_code(
            AppErrorCode::YtDlpStdoutCaptureFailed,
            "failed to capture yt-dlp stdout",
        )
    })?;

    let stderr = child.stderr.take().ok_or_else(|| {
        AppError::from_code(
            AppErrorCode::YtDlpStderrCaptureFailed,
            "failed to capture yt-dlp stderr",
        )
    })?;

    let stdout_task =
        tauri::async_runtime::spawn(read_capped_json_stdout(stdout, MAX_YT_DLP_JSON_BYTES));

    let stderr_task = tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line_buf: Vec<u8> = Vec::new();
        let mut log_lines: Vec<String> = Vec::new();

        // stderr carries short log lines only (the JSON payload comes on stdout), so cap each line
        // tightly: without it a single unterminated line could balloon far past the ring buffer's
        // intended bound (see MAX_PROGRESS_LINE_BYTES).
        while let Some(line_value) =
            read_lossy_line_capped(&mut reader, &mut line_buf, MAX_PROGRESS_LINE_BYTES).await
        {
            let line = line_value.trim_end().to_string();

            if should_keep_terminal_line(&line) {
                // Bound memory (and the IPC payload these lines become in `terminal_logs`) on a
                // chatty failure - retry storms, throttling notices - since `-v` is always passed
                // here. Keep the most recent lines, the same ring-buffer cap the download flow's
                // stderr uses (yt_dlp_download::MAX_CAPTURED_STDERR_LINES).
                if log_lines.len() >= MAX_CAPTURED_STDERR_LINES {
                    log_lines.remove(0);
                }

                log_lines.push(line);
            }
        }

        log_lines
    });

    let status = tokio::select! {
        wait_result = timeout(Duration::from_secs(timeout_secs), child.wait()) => match wait_result {
            Ok(status) => status
                .map_err(|e| AppError::from_code(exec_code, format!("{exec_message}: {e}")))?,
            Err(_) => {
                // Kill the whole tree (yt-dlp and any ffmpeg grandchild), not just the direct
                // child, so a hung conversion cannot outlive the timeout as an orphan.
                if let Some(pid) = child_pid {
                    crate::utils::process::kill_process_tree(pid).await;
                }
                let _ = child.kill().await;
                return Err(AppError::from_code(timeout_code, timeout_message));
            }
        },
        _ = crate::utils::process::wait_for_cancel(cancel.as_deref()) => {
            // The caller signalled cancellation: kill the whole tree immediately instead of
            // waiting out the remaining timeout (previously up to a minute of an unresponsive
            // "cancel"), and report it as a cancellation. Only ever reached when a cancel flag
            // is supplied (the download flow); other callers pass None, so this branch pends
            // forever and the wait above drives the result.
            if let Some(pid) = child_pid {
                crate::utils::process::kill_process_tree(pid).await;
            }
            let _ = child.kill().await;
            return Err(AppError::from_code(
                AppErrorCode::YtDlpDownloadCancelled,
                "yt-dlp download cancelled",
            ));
        }
    };

    let (json_payload, stdout_logs, stdout_overflowed) = stdout_task.await.map_err(|e| {
        AppError::from_code(
            AppErrorCode::YtDlpStdoutCaptureFailed,
            format!("failed to read yt-dlp stdout: {e}"),
        )
    })?;

    let stderr_logs = stderr_task.await.map_err(|e| {
        AppError::from_code(
            AppErrorCode::YtDlpStderrCaptureFailed,
            format!("failed to read yt-dlp stderr: {e}"),
        )
    })?;

    if !status.success() {
        let detail = select_best_error_detail(&stdout_logs, &stderr_logs, failed_message);
        // The detail is embedded in the returned AppError, which is serialized to the frontend
        // and written to the file log; redact the cookies path so a cookie-related failure
        // cannot leak it (the success path redacts the same way before returning terminal_logs).
        let detail = redact_cookies_path_from_line(&detail, cookies_path_from_args(args));

        return Err(AppError::from_code_with_details(
            failed_code,
            failed_message,
            format!("{failed_message}: {detail}"),
        ));
    }

    if stdout_overflowed {
        return Err(AppError::from_code_with_details(
            AppErrorCode::YtDlpMetadataParseFailed,
            "yt-dlp returned more data than can be processed for this URL.",
            format!("yt-dlp output exceeded the {MAX_YT_DLP_JSON_BYTES}-byte limit"),
        ));
    }

    if json_payload.trim().is_empty() {
        return Err(AppError::from_code_with_details(
            AppErrorCode::YtDlpMetadataParseFailed,
            "yt-dlp returned invalid media information for this URL.",
            "yt-dlp metadata parse failed: JSON payload not found".to_string(),
        ));
    }

    Ok((json_payload, stdout_logs, stderr_logs))
}

/// Optionally registers a cancellable run so `cancel_media_download(run_id)` can abort a standalone
/// metadata/format/comment fetch, mirroring the download flow. Returns the cancel flag to hand to
/// `run_yt_dlp_and_capture_json` and a release guard that unregisters the run when dropped. An
/// empty/absent run_id means the caller opted out of cancellation, so the flag is `None` and the
/// fetch runs uninterruptibly to completion or timeout as before.
fn optional_cancellable_run(
    run_id: Option<&str>,
) -> AppResult<(Option<Arc<AtomicBool>>, Option<DownloadRunReleaseGuard>)> {
    match run_id.map(str::trim).filter(|value| !value.is_empty()) {
        Some(run_id) => {
            let flag = register_download_run(run_id)?;
            Ok((Some(flag), Some(DownloadRunReleaseGuard::new(run_id))))
        }
        None => Ok((None, None)),
    }
}

pub async fn fetch_yt_dlp_metadata(
    yt_dlp: &str,
    url: &str,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
    cancel: Option<Arc<AtomicBool>>,
) -> AppResult<YtDlpMetadata> {
    let mut args = vec![
        "-v".to_string(),
        "--ignore-config".to_string(),
        "--no-playlist".to_string(),
        "--dump-single-json".to_string(),
        "--no-warnings".to_string(),
    ];

    append_auth_args(&mut args, cookies_browser, cookies_path);
    args.push("--".to_string());
    args.push(url.to_string());

    let (json_payload, _stdout_logs, _stderr_logs) = run_yt_dlp_and_capture_json(
        yt_dlp,
        &args,
        YT_DLP_METADATA_TIMEOUT_SECS,
        AppErrorCode::YtDlpMetadataTimeout,
        AppErrorCode::YtDlpMetadataExecFailed,
        AppErrorCode::YtDlpMetadataFailed,
        "yt-dlp metadata request timed out",
        "failed to execute yt-dlp metadata command",
        "yt-dlp could not load media information for this URL.",
        cancel,
    )
    .await?;

    serde_json::from_str(&json_payload).map_err(|e| {
        AppError::from_code_with_details(
            AppErrorCode::YtDlpMetadataParseFailed,
            "yt-dlp returned invalid media information for this URL.",
            format!("yt-dlp metadata parse failed: {e}"),
        )
    })
}

async fn fetch_yt_dlp_metadata_with_comments(
    yt_dlp: &str,
    url: &str,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
    cancel: Option<Arc<AtomicBool>>,
) -> AppResult<YtDlpMetadata> {
    let mut args = vec![
        "-v".to_string(),
        "--ignore-config".to_string(),
        "--no-playlist".to_string(),
        "--skip-download".to_string(),
        "--dump-single-json".to_string(),
        "--write-comments".to_string(),
        "--no-warnings".to_string(),
        "--extractor-args".to_string(),
        "youtube:comment_sort=top".to_string(),
    ];

    append_auth_args(&mut args, cookies_browser, cookies_path);
    args.push("--".to_string());
    args.push(url.to_string());

    let (json_payload, _stdout_logs, _stderr_logs) = run_yt_dlp_and_capture_json(
        yt_dlp,
        &args,
        YT_DLP_COMMENTS_TIMEOUT_SECS,
        AppErrorCode::YtDlpCommentsTimeout,
        AppErrorCode::YtDlpCommentsExecFailed,
        AppErrorCode::YtDlpCommentsFailed,
        "yt-dlp comments request timed out",
        "failed to execute yt-dlp comments command",
        "yt-dlp could not load YouTube comments for this media.",
        cancel,
    )
    .await?;

    serde_json::from_str(&json_payload).map_err(|e| {
        AppError::from_code_with_details(
            AppErrorCode::YtDlpCommentsParseFailed,
            "yt-dlp returned invalid YouTube comments data.",
            format!("yt-dlp comments parse failed: {e}"),
        )
    })
}

fn normalize_comment_metadata(comment: YtDlpCommentMetadata) -> Option<YtDlpComment> {
    let text = comment.text.unwrap_or_default().trim().to_string();

    if text.is_empty() {
        return None;
    }

    let author_name = comment
        .author
        .unwrap_or_else(|| "Unknown author".to_string())
        .trim()
        .to_string();

    let author_name = if author_name.is_empty() {
        "Unknown author".to_string()
    } else {
        author_name
    };

    let author_handle = author_name.strip_prefix('@').map(|_| author_name.clone());

    Some(YtDlpComment {
        comment_id: comment
            .id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        parent_comment_id: comment
            .parent
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        author_name,
        author_handle,
        author_channel_id: comment
            .author_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        author_thumbnail: comment
            .author_thumbnail
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        text,
        like_count: comment.like_count.unwrap_or(0),
        reply_count: comment.reply_count.unwrap_or(0),
        is_author_uploader: comment.author_is_uploader.unwrap_or(false),
        is_favorited: comment.is_favorited.unwrap_or(false),
        is_pinned: comment.is_pinned.unwrap_or(false),
        is_edited: comment.is_edited.unwrap_or(false),
        time_text: comment
            .time_text
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        published_at: comment.timestamp.map(|value| value.to_string()),
    })
}

fn is_valid_youtube_video_id(value: &str) -> bool {
    value.len() == 11
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Decides whether an empty comment result means extraction *failed* rather than the video
/// genuinely having no comments. yt-dlp succeeded (a hard failure would already be an error),
/// but returned no comments while YouTube reports a positive `comment_count` - so the comments
/// exist and could not be retrieved (rate limiting, temporary unavailability). A `None`/`0`
/// reported count means comments are disabled or genuinely zero, which is not an error.
fn comments_extraction_looks_incomplete(reported_count: Option<i64>, extracted: usize) -> bool {
    extracted == 0 && reported_count.is_some_and(|count| count > 0)
}

pub async fn fetch_youtube_comments_async(
    app: &AppHandle,
    video_id: &str,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
    run_id: Option<&str>,
) -> AppResult<Vec<YtDlpComment>> {
    let normalized_video_id = video_id.trim();

    if normalized_video_id.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidYoutubeVideoId,
            "youtube video id is empty",
        ));
    }

    if !is_valid_youtube_video_id(normalized_video_id) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidYoutubeVideoId,
            format!("invalid youtube video id: \"{}\"", normalized_video_id),
        ));
    }

    let yt_dlp = resolve_yt_dlp_binary_async(app).await?;
    let url = format!("https://www.youtube.com/watch?v={}", normalized_video_id);

    // Register the run (when a run_id was supplied) so the frontend can cancel this comment backup -
    // which can run for up to YT_DLP_COMMENTS_TIMEOUT_SECS - promptly, instead of waiting it out. The
    // guard unregisters the run when this function returns.
    let (cancel_flag, _run_release_guard) = optional_cancellable_run(run_id)?;

    let metadata = fetch_yt_dlp_metadata_with_comments(
        &yt_dlp,
        &url,
        cookies_browser,
        cookies_path,
        cancel_flag,
    )
    .await?;

    let reported_comment_count = metadata.comment_count;

    let comments = metadata
        .comments
        .into_iter()
        .filter_map(normalize_comment_metadata)
        .collect::<Vec<_>>();

    // Distinguish "the video has no comments" (fine) from "the video has comments but none
    // could be retrieved" (a failure worth surfacing, so the caller does not report an empty
    // refresh as success). A genuine hard failure already returned an error above.
    if comments_extraction_looks_incomplete(reported_comment_count, comments.len()) {
        return Err(AppError::from_code(
            AppErrorCode::YtDlpCommentsIncomplete,
            "the video reports comments but none could be retrieved (they may be rate-limited or temporarily unavailable)",
        ));
    }

    Ok(comments)
}

pub async fn list_yt_dlp_formats_async(
    app: &AppHandle,
    url: &str,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
    run_id: Option<&str>,
) -> AppResult<YtDlpFormatsResult> {
    let normalized_url = url.trim().to_string();

    if normalized_url.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidUrl,
            "url is empty",
        ));
    }

    if !is_allowed_youtube_url(&normalized_url) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidUrl,
            "url must be an http(s) YouTube URL",
        ));
    }

    let yt_dlp = resolve_yt_dlp_binary_async(app).await?;

    // Register the run (when a run_id was supplied) so the frontend can cancel a slow format probe
    // promptly instead of waiting out YT_DLP_METADATA_TIMEOUT_SECS. The guard unregisters the run
    // when this function returns.
    let (cancel_flag, _run_release_guard) = optional_cancellable_run(run_id)?;

    let mut args = vec![
        "-v".to_string(),
        "--ignore-config".to_string(),
        "--no-playlist".to_string(),
        "--dump-single-json".to_string(),
        "--no-warnings".to_string(),
    ];

    append_auth_args(&mut args, cookies_browser, cookies_path);
    args.push("--".to_string());
    args.push(normalized_url.clone());

    let (json_payload, mut stdout_logs, mut stderr_logs) = run_yt_dlp_and_capture_json(
        &yt_dlp,
        &args,
        YT_DLP_METADATA_TIMEOUT_SECS,
        AppErrorCode::YtDlpMetadataTimeout,
        AppErrorCode::YtDlpMetadataExecFailed,
        AppErrorCode::YtDlpMetadataFailed,
        "yt-dlp metadata request timed out",
        "failed to execute yt-dlp metadata command",
        "yt-dlp could not load media information for this URL.",
        cancel_flag,
    )
    .await?;

    // These logs are returned to the frontend below (`terminal_logs`); neither the cookies file
    // path nor the full pasted URL may survive into them. yt-dlp's `-v` mode echoes the whole argv
    // (the `[debug] Command-line config: [...]` line), so the URL with its playlist/tracking
    // parameters would otherwise reach a log the user might paste into a public issue. Reduce it to
    // the same privacy-preserving reference the download flow logs (`youtube_ref_for_log`), matching
    // that flow's `redacted_args_for_log`.
    for line in stdout_logs.iter_mut().chain(stderr_logs.iter_mut()) {
        *line = redact_sensitive_from_line(line, cookies_path, &normalized_url);
    }

    let metadata: YtDlpMetadata = serde_json::from_str(&json_payload).map_err(|e| {
        AppError::from_code_with_details(
            AppErrorCode::YtDlpMetadataParseFailed,
            "yt-dlp returned invalid media information for this URL.",
            format!("yt-dlp metadata parse failed: {e}"),
        )
    })?;

    let suggested_title = metadata
        .title
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "Untitled".to_string());

    let youtube_video_id =
        resolve_youtube_video_id(metadata.id.as_deref(), metadata.extractor.as_deref());

    let formats: Vec<YtDlpFormatOption> = metadata
        .formats
        .into_iter()
        .filter_map(|format| {
            let format_id = format
                .format_id
                .as_ref()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())?;

            let has_video = codec_is_present(&format.vcodec);
            let has_audio = codec_is_present(&format.acodec);

            if !has_video && !has_audio {
                return None;
            }

            let media_type = if has_video {
                "video".to_string()
            } else {
                "audio".to_string()
            };

            let ext = format
                .ext
                .as_ref()
                .map(|v| v.trim().to_lowercase())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "bin".to_string());

            let filesize_bytes = format.filesize.or(format.filesize_approx);

            let protocol = format
                .protocol
                .as_ref()
                .map(|value| value.trim().to_lowercase())
                .filter(|value| !value.is_empty());

            Some(YtDlpFormatOption {
                format_id,
                ext,
                media_type,
                has_video,
                has_audio,
                filesize_bytes,
                height: format.height,
                abr: format.abr,
                tbr: format.tbr,
                vcodec: format
                    .vcodec
                    .as_ref()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                protocol,
            })
        })
        .collect();

    let friendly_hints = build_friendly_terminal_hints(&stdout_logs, &stderr_logs);

    if !friendly_hints.is_empty() {
        stdout_logs.push(String::new());
        stdout_logs.extend(friendly_hints);
    }

    let mut terminal_logs = Vec::new();
    terminal_logs.extend(stdout_logs);
    terminal_logs.extend(stderr_logs);

    Ok(YtDlpFormatsResult {
        suggested_title,
        youtube_video_id,
        formats,
        terminal_logs,
    })
}

/// True when yt-dlp's `extractor` field indicates the media came from YouTube. Shared by the
/// download flow (`normalize_download_metadata`) and the format-listing flow
/// (`list_yt_dlp_formats_async`) so both resolve the same youtube video id from the same
/// metadata fetch - the latter lets the frontend pre-check for an already-registered duplicate
/// before any download starts, instead of only after downloading the whole file.
fn resolve_youtube_video_id(id: Option<&str>, extractor: Option<&str>) -> Option<String> {
    let id = id.map(str::trim).filter(|value| !value.is_empty())?;
    let extractor = extractor.unwrap_or_default().to_lowercase();

    if extractor.contains("youtube") {
        Some(id.to_string())
    } else {
        None
    }
}

pub fn normalize_download_metadata(
    metadata: &YtDlpMetadata,
) -> AppResult<NormalizedDownloadMetadata> {
    let id = metadata
        .id
        .clone()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| {
            AppError::from_code(
                AppErrorCode::YtDlpInvalidMetadata,
                "yt-dlp did not return a media id",
            )
        })?;

    let extractor = metadata
        .extractor
        .clone()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "media".to_string());

    let suggested_title = metadata
        .title
        .clone()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "Untitled".to_string());

    let youtube_video_id = resolve_youtube_video_id(Some(&id), Some(&extractor));

    let published_at = normalize_yt_dlp_upload_date(metadata.upload_date.clone());

    Ok((
        id,
        extractor,
        suggested_title,
        youtube_video_id,
        published_at,
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        comments_extraction_looks_incomplete, cookies_path_from_args, is_valid_youtube_video_id,
        read_capped_json_stdout, redact_cookies_path_from_line, redact_sensitive_from_line,
        resolve_youtube_video_id, run_yt_dlp_and_capture_json, sanitize_filename_component,
        sanitize_identifier_component,
    };
    use crate::AppErrorCode;

    #[test]
    fn sanitize_identifier_component_keeps_unaltered_ids_unchanged() {
        // A normal YouTube id survives sanitization untouched, so its filename stays byte-for-byte
        // what earlier versions produced (no churn for already-downloaded media).
        for id in ["dQw4w9WgXcQ", "abc-123_XYZ", "a.b_c"] {
            assert_eq!(sanitize_identifier_component(id), id);
            assert_eq!(
                sanitize_identifier_component(id),
                sanitize_filename_component(id)
            );
        }
    }

    #[test]
    fn sanitize_filename_component_prefixes_windows_reserved_names() {
        // A component that sanitizes to a reserved device name is prefixed with '_' so the joined
        // filename is usable on Windows, with or without an extension.
        assert_eq!(sanitize_filename_component("CON"), "_CON");
        assert_eq!(sanitize_filename_component("nul"), "_nul");
        assert_eq!(sanitize_filename_component("com1"), "_com1");
        assert_eq!(sanitize_filename_component("LPT9.txt"), "_LPT9.txt");

        // A component that merely contains a reserved substring is a real name, left untouched.
        assert_eq!(sanitize_filename_component("console"), "console");
        assert_eq!(sanitize_filename_component("com10"), "com10");
    }

    #[test]
    fn sanitize_identifier_component_disambiguates_ids_that_share_a_sanitized_form() {
        // `a__b` and `a_b` both sanitize to `a_b`; the colliding one must get a distinct suffix so
        // one download can never silently overwrite the other, while the canonical `a_b` is kept.
        let canonical = sanitize_identifier_component("a_b");
        let collider = sanitize_identifier_component("a__b");
        let other_collider = sanitize_identifier_component("a:b");

        assert_eq!(canonical, "a_b");
        assert_ne!(collider, canonical);
        assert_ne!(other_collider, canonical);
        assert_ne!(collider, other_collider);
        // The disambiguated names still start with the sanitized form.
        assert!(collider.starts_with("a_b_"));
        assert!(other_collider.starts_with("a_b_"));
    }

    // Ignored on CI: this spawns a real child process (`sleep`) and exercises the kill path.
    // It passes locally, on macOS and on Windows, and in a plain Linux container - but on
    // GitHub's ubuntu-22.04 runner the kill/reap await never completes (even a tokio::time
    // timeout around it does not fire there), so the test hangs and wedges the whole run. The
    // behaviour is not reproducible off that runner. Run it deliberately with `--ignored`.
    #[tokio::test]
    #[ignore = "spawns a real child; hangs only on GitHub's ubuntu CI runner (run with --ignored)"]
    async fn run_and_capture_kills_the_child_and_reports_timeout_when_it_expires() {
        // A slow command that would outlive the 1s timeout by far; the call must come
        // back with the timeout error instead of waiting for it (the child is killed).
        let (binary, args): (&str, Vec<String>) = if cfg!(windows) {
            (
                "ping",
                vec!["-n".to_string(), "30".to_string(), "127.0.0.1".to_string()],
            )
        } else {
            ("sleep", vec!["30".to_string()])
        };

        let error = run_yt_dlp_and_capture_json(
            binary,
            &args,
            1,
            AppErrorCode::YtDlpMetadataTimeout,
            AppErrorCode::YtDlpMetadataExecFailed,
            AppErrorCode::YtDlpMetadataFailed,
            "timed out",
            "exec failed",
            "failed",
            None,
        )
        .await
        .unwrap_err();

        assert_eq!(error.code, AppErrorCode::YtDlpMetadataTimeout.as_str());
    }

    // Ignored on CI for the same reason as the timeout test above: it spawns a real child and
    // the kill/reap path hangs only on GitHub's ubuntu-22.04 runner. Run with `--ignored`.
    #[tokio::test]
    #[ignore = "spawns a real child; hangs only on GitHub's ubuntu CI runner (run with --ignored)"]
    async fn run_and_capture_kills_the_child_and_reports_cancellation_when_flagged() {
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;

        let (binary, args) = if cfg!(windows) {
            (
                "cmd",
                vec!["/C".to_string(), "ping -n 30 127.0.0.1 > NUL".to_string()],
            )
        } else {
            ("sleep", vec!["30".to_string()])
        };

        // Flag already set: the cancel branch wins immediately and the long-running child is
        // killed instead of the call blocking for the full timeout.
        let cancel = Arc::new(AtomicBool::new(true));

        let error = run_yt_dlp_and_capture_json(
            binary,
            &args,
            30,
            AppErrorCode::YtDlpMetadataTimeout,
            AppErrorCode::YtDlpMetadataExecFailed,
            AppErrorCode::YtDlpMetadataFailed,
            "timed out",
            "exec failed",
            "failed",
            Some(Arc::clone(&cancel)),
        )
        .await
        .unwrap_err();

        assert_eq!(error.code, AppErrorCode::YtDlpDownloadCancelled.as_str());
    }

    #[tokio::test]
    async fn read_capped_json_stdout_flags_overflow() {
        // A single JSON line larger than the cap is flagged as overflowed.
        let big = format!("{{\"x\":\"{}\"}}", "a".repeat(200));
        let (_json, _logs, overflowed) = read_capped_json_stdout(big.as_bytes(), 32).await;
        assert!(overflowed);
    }

    #[tokio::test]
    async fn read_capped_json_stdout_reads_normal_output() {
        let input = "{\"id\":\"abc\"}\nsome log line\n";
        let (json, logs, overflowed) = read_capped_json_stdout(input.as_bytes(), 4096).await;

        assert!(!overflowed);
        assert_eq!(json, "{\"id\":\"abc\"}");
        assert_eq!(logs, vec!["some log line".to_string()]);
    }

    #[test]
    fn accepts_standard_id() {
        assert!(is_valid_youtube_video_id("dQw4w9WgXcQ"));
    }

    #[test]
    fn accepts_id_with_dash_and_underscore() {
        assert!(is_valid_youtube_video_id("a-b_cDeFgHi"));
    }

    #[test]
    fn rejects_empty() {
        assert!(!is_valid_youtube_video_id(""));
    }

    #[test]
    fn rejects_10_chars() {
        assert!(!is_valid_youtube_video_id("dQw4w9WgXc"));
    }

    #[test]
    fn rejects_12_chars() {
        assert!(!is_valid_youtube_video_id("dQw4w9WgXcQQ"));
    }

    #[test]
    fn rejects_id_with_query_param() {
        assert!(!is_valid_youtube_video_id("dQw4w9W&list"));
    }

    #[test]
    fn rejects_id_with_fragment() {
        assert!(!is_valid_youtube_video_id("dQw4w9WgX#Q"));
    }

    #[test]
    fn rejects_unicode() {
        assert!(!is_valid_youtube_video_id("dQw4w9WgXcé"));
    }

    #[test]
    fn redact_cookies_path_strips_path_from_command_line_config_echo() {
        // This mirrors the line yt-dlp's `-v` flag prints, which echoes the full argv
        // (including `--cookies <path>`) verbatim.
        let line = "[debug] Command-line config: ['-v', '--cookies', '/home/user/.config/cookies.txt', '--', 'https://youtube.com/watch?v=x']";

        let redacted = redact_cookies_path_from_line(line, Some("/home/user/.config/cookies.txt"));

        assert!(!redacted.contains("/home/user/.config/cookies.txt"));
        assert!(redacted.contains("<redacted>"));
    }

    #[test]
    fn redact_cookies_path_leaves_unrelated_lines_untouched() {
        let line = "[youtube] Extracting URL: https://youtube.com/watch?v=x";

        assert_eq!(
            redact_cookies_path_from_line(line, Some("/home/user/.config/cookies.txt")),
            line
        );
    }

    #[test]
    fn redact_cookies_path_is_a_noop_when_no_cookies_path_was_used() {
        let line = "[debug] Command-line config: ['-v', '--cookies-from-browser', 'firefox']";

        assert_eq!(redact_cookies_path_from_line(line, None), line);
    }

    #[test]
    fn redact_cookies_path_catches_separator_and_case_variants() {
        // yt-dlp could print the same Windows path with forward slashes (its internal form) or a
        // different casing; the full path must be redacted in every such form, not only verbatim.
        let configured = r"C:\Users\Alice\AppData\cookies.txt";

        let forward_slashes = "[debug] loading cookies from C:/Users/Alice/AppData/cookies.txt";
        let redacted = redact_cookies_path_from_line(forward_slashes, Some(configured));
        assert!(!redacted.contains("Alice"));
        assert!(redacted.contains("<redacted>"));

        let lowercased = r"[debug] loading cookies from c:\users\alice\appdata\cookies.txt";
        let redacted = redact_cookies_path_from_line(lowercased, Some(configured));
        assert!(!redacted.contains("alice"));
        assert!(redacted.contains("<redacted>"));
    }

    #[test]
    fn redact_cookies_path_leaves_the_generic_filename_alone() {
        // The bare filename is generic and shows up in benign hint text; only the full path leaks
        // the profile layout, so a line mentioning just "cookies.txt" must survive untouched.
        let line = "provide a cookies.txt file from a verified account";

        assert_eq!(
            redact_cookies_path_from_line(line, Some(r"C:\Users\Alice\cookies.txt")),
            line
        );
    }

    #[test]
    fn redact_sensitive_reduces_the_full_url_to_a_video_reference() {
        // yt-dlp's -v echo prints the whole argv, including the pasted URL with its playlist and
        // tracking parameters. The sanitized line must keep only the video reference and still
        // redact the cookies path, matching the download flow's redaction.
        let line = "[debug] Command-line config: ['--cookies', 'C:\\Users\\Alice\\cookies.txt', '--', 'https://www.youtube.com/watch?v=abc123&list=PLxyz&t=42s']";

        let redacted = redact_sensitive_from_line(
            line,
            Some(r"C:\Users\Alice\cookies.txt"),
            "https://www.youtube.com/watch?v=abc123&list=PLxyz&t=42s",
        );

        assert!(
            redacted.contains("www.youtube.com?v=abc123"),
            "url should be reduced to its video reference: {redacted}"
        );
        assert!(
            !redacted.contains("list=PLxyz"),
            "playlist/tracking params must not survive: {redacted}"
        );
        assert!(
            !redacted.contains(r"C:\Users\Alice\cookies.txt"),
            "cookies path must still be redacted: {redacted}"
        );
    }

    #[test]
    fn cookies_path_from_args_finds_the_value_after_the_flag() {
        let args = vec![
            "-v".to_string(),
            "--cookies".to_string(),
            "/home/user/.config/cookies.txt".to_string(),
            "--".to_string(),
            "https://youtube.com/watch?v=x".to_string(),
        ];

        assert_eq!(
            cookies_path_from_args(&args),
            Some("/home/user/.config/cookies.txt")
        );
    }

    #[test]
    fn cookies_path_from_args_is_none_without_the_flag_or_a_trailing_value() {
        // `--cookies-from-browser` carries a browser name, not a path, and must not match.
        let browser = vec!["--cookies-from-browser".to_string(), "firefox".to_string()];
        assert_eq!(cookies_path_from_args(&browser), None);

        // A dangling `--cookies` with no following value yields None rather than panicking.
        let dangling = vec!["-v".to_string(), "--cookies".to_string()];
        assert_eq!(cookies_path_from_args(&dangling), None);
    }

    #[test]
    fn resolve_youtube_video_id_accepts_a_youtube_extractor() {
        assert_eq!(
            resolve_youtube_video_id(Some("abc123"), Some("Youtube")),
            Some("abc123".to_string())
        );
        assert_eq!(
            resolve_youtube_video_id(Some("abc123"), Some("youtube:tab")),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn resolve_youtube_video_id_rejects_a_non_youtube_extractor() {
        assert_eq!(
            resolve_youtube_video_id(Some("abc123"), Some("vimeo")),
            None
        );
        assert_eq!(resolve_youtube_video_id(Some("abc123"), None), None);
    }

    #[test]
    fn resolve_youtube_video_id_rejects_a_missing_or_blank_id() {
        assert_eq!(resolve_youtube_video_id(None, Some("youtube")), None);
        assert_eq!(resolve_youtube_video_id(Some("   "), Some("youtube")), None);
    }

    #[test]
    fn empty_comments_are_incomplete_only_when_a_positive_count_is_reported() {
        // Video reports comments but none came back -> extraction is incomplete (a failure).
        assert!(comments_extraction_looks_incomplete(Some(42), 0));

        // Genuinely zero, or comments disabled (None): not incomplete.
        assert!(!comments_extraction_looks_incomplete(Some(0), 0));
        assert!(!comments_extraction_looks_incomplete(None, 0));

        // Any comments were retrieved: never incomplete, regardless of the reported total.
        assert!(!comments_extraction_looks_incomplete(Some(42), 10));
        assert!(!comments_extraction_looks_incomplete(None, 5));
    }
}
