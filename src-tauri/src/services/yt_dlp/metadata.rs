use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Runtime};
use tokio::{
    io::{AsyncRead, AsyncReadExt, BufReader},
    process::Command,
    time::timeout,
};

use crate::models::yt_dlp::{
    YtDlpComment, YtDlpCommentMetadata, YtDlpFormatOption, YtDlpFormatsResult, YtDlpMetadata,
};
use crate::services::binaries::resolve_yt_dlp_binary_async;
use crate::services::yt_dlp::cookies::{
    append_auth_args, normalize_cookies_browser, redact_cookies_browser_selector,
};
use crate::services::yt_dlp::registry::{register_download_run, DownloadRunReleaseGuard};
use crate::services::yt_dlp::url::{is_allowed_youtube_url, youtube_ref_for_log};
use crate::utils::bounded_semaphore::BoundedSemaphore;
use crate::utils::format::{codec_is_present, normalize_yt_dlp_upload_date};
use crate::utils::io::{read_lossy_line, read_lossy_line_capped, MAX_PROGRESS_LINE_BYTES};
use crate::utils::process::hide_console_async;
use crate::{AppError, AppErrorCode, AppResult};

const YT_DLP_METADATA_TIMEOUT_SECS: u64 = 60;
const YT_DLP_COMMENTS_TIMEOUT_SECS: u64 = 180;

// Bounds how many standalone yt-dlp JSON runs (metadata, format listing, comments) execute at once.
// Each buffers up to MAX_YT_DLP_JSON_BYTES of stdout and spawns its own yt-dlp/ffmpeg process tree,
// so without a cap a compromised or buggy frontend firing these in a tight loop could exhaust memory
// and process handles. The main download path does not go through here (it has its own spawn and is
// bounded by the per-run registry), so gating this shared choke point does not throttle real
// downloads, only the metadata-style probes. Generous enough that normal interactive use (loading
// formats for a video, fetching its comments) never queues.
const MAX_CONCURRENT_STANDALONE_RUNS: usize = 4;
// Ceiling on how many standalone runs may be in flight (running or queued) at once. The concurrency
// cap above bounds only how many spawn together; this bounds the queue behind it so a burst of IPC
// calls cannot pile up an unbounded backlog (see BoundedSemaphore). Set well above real interactive
// use. Loading formats and comments for a video never approaches it.
const MAX_STANDALONE_RUNS_IN_FLIGHT: usize = 32;

// A single process-wide gate. There is one app, and unlike the pool it holds no state a test needs to
// inject.
static STANDALONE_RUN_SEMAPHORE: BoundedSemaphore = BoundedSemaphore::new(
    MAX_CONCURRENT_STANDALONE_RUNS,
    MAX_STANDALONE_RUNS_IN_FLIGHT,
);
// Cap on how much yt-dlp stdout is buffered. `--dump-single-json` (with `--write-comments`)
// emits the whole payload as one line, so an extreme video could otherwise allocate GBs.
// Generous. Even very large comment sets fit well under this.
const MAX_YT_DLP_JSON_BYTES: u64 = 128 * 1024 * 1024; // 128 MiB

// Cap on the stderr log lines kept from a metadata/comments/format run and handed to the frontend
// as `terminal_logs`. `-v` is always passed, so a chatty failure can emit thousands of lines;
// keep only the most recent, matching yt_dlp::download's stderr ring buffer.
const MAX_CAPTURED_STDERR_LINES: usize = 100;

/// Reads yt-dlp stdout, keeping the JSON payload line and the useful log lines, but never
/// buffering more than `max_bytes`. Returns `(json_payload, log_lines, overflowed)`, where
/// `overflowed` means the output exceeded the cap (and the payload may be truncated).
async fn read_capped_json_stdout<R>(reader: R, max_bytes: u64) -> (String, Vec<String>, bool)
where
    R: AsyncRead + Unpin,
{
    // `+ 1` so a stream that reaches exactly `max_bytes + 1` bytes reveals the real output exceeded
    // the cap.
    let mut reader = BufReader::new(reader.take(max_bytes + 1));
    let mut line_buf: Vec<u8> = Vec::new();
    let mut json_payload = String::new();
    let mut log_lines: Vec<String> = Vec::new();

    while let Some(line_value) = read_lossy_line(&mut reader, &mut line_buf).await {
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

    // The `Take` limit hits 0 exactly when the stream delivered all `max_bytes + 1` allowed bytes,
    // i.e. the real output exceeded `max_bytes`. This is an exact signal, unlike summing decoded
    // line lengths, which drifts from the raw byte count on CRLF line endings or on invalid UTF-8
    // replaced by the (multi-byte) U+FFFD.
    let overflowed = reader.get_ref().limit() == 0;

    (json_payload, log_lines, overflowed)
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

    // A component made only of dots ('.', '..', ...) is path-significant. As a bare path segment it
    // means the current/parent directory. Every current call site concatenates this into a longer
    // string rather than using it as a lone `Path` component, so no traversal is reachable today,
    // but returning it verbatim would make any future `dir.join(sanitize_filename_component(x))` a
    // traversal. Map it to the same neutral placeholder as the empty case. Defense in depth,
    // mirroring the leading-dash and reserved-name guards below.
    if compact.chars().all(|ch| ch == '.') {
        return "media".to_string();
    }

    // yt-dlp reads a leading '-' as an option, so a component that sanitizes to one starting with
    // '-' is prefixed with '_'. Rare (extractor/id come from yt-dlp's own extractor, not free-form
    // text), but this mirrors the leading-dash guard in yt_dlp::download::is_valid_format_id and
    // keeps the value safe wherever the resulting file_prefix feeds an argv position.
    let guarded = if compact.starts_with('-') {
        format!("_{compact}")
    } else {
        compact
    };

    // A component that sanitizes to a Windows reserved device name (CON, NUL, COM1, ...) would make
    // the resulting file unusable on Windows. In practice the download filename joins three such
    // components as extractor_id_formatid, so a bare reserved stem is not normally reachable, but
    // prefix it with '_' as defense in depth, mirroring the leading-dash guard above and the
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
/// distinct ids get distinct filenames. A value that survives sanitization unchanged (the
/// overwhelming majority of YouTube ids) keeps its exact name, so filenames of already
/// downloaded media are unaffected.
pub fn sanitize_identifier_component(value: &str) -> String {
    let trimmed = value.trim();
    let sanitized = sanitize_filename_component(trimmed);

    if trimmed.is_empty() || sanitized == trimmed {
        return sanitized;
    }

    format!("{sanitized}_{}", short_identifier_hash(trimmed))
}

/// First 10 lowercase-hex chars (40 bits) of the SHA-256 of `value`. Enough to disambiguate the
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
/// yt-dlp is run with `-v`, and its captured stdout/stderr reaches the frontend on two paths.
/// As the `terminal_logs` of `list_yt_dlp_formats_async` on success, and as the error
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
/// full-path forms is redacted. The bare filename is deliberately left alone. It is generic
/// ("cookies.txt"), appears in benign hint text, and does not reveal the user's profile layout. It
/// is the directory portion that does.
pub(crate) fn redact_cookies_path_from_line(line: &str, cookies_path: Option<&str>) -> String {
    let Some(path) = cookies_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return line.to_string();
    };

    // The plausible representations of the same full path. Verbatim, and with either separator
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

/// Sanitizes a yt-dlp `-v` log line before it reaches the frontend/file log. Redacts the cookies
/// file path (see [`redact_cookies_path_from_line`]), hides the profile and container of a
/// `--cookies-from-browser` selector (a profile is often a path under the user's home directory,
/// and the `[debug] Command-line config` echo prints the whole argv verbatim), and reduces the full
/// pasted URL to the same privacy-preserving reference the download flow logs
/// (`youtube_ref_for_log`), so playlist and tracking parameters do not survive into a log a user
/// might paste into a public issue.
pub(crate) fn redact_sensitive_from_line(
    line: &str,
    cookies_path: Option<&str>,
    cookies_browser: Option<&str>,
    url: &str,
) -> String {
    let mut redacted = redact_cookies_path_from_line(line, cookies_path);

    if let Some(selector) = cookies_browser
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let safe = redact_cookies_browser_selector(selector);

        // A bare browser name redacts to itself; replacing it with itself would be a no-op, and a
        // selector with a profile is the only case where the argv echo carries something to hide.
        if safe != selector {
            redacted = redacted.replace(selector, &safe);
        }
    }

    let url = url.trim();

    if url.is_empty() {
        return redacted;
    }

    redacted.replace(url, &youtube_ref_for_log(url))
}

/// Replaces every ASCII-case-insensitive occurrence of `needle` in `haystack`. Uses
/// `to_ascii_lowercase`, which only folds ASCII `A-Z` and so is byte-length preserving. An offset
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
/// this function the fully-built args. `--cookies-from-browser` is not returned. It carries a
/// browser name, not a filesystem path.
fn cookies_path_from_args(args: &[String]) -> Option<&str> {
    args.iter()
        .position(|arg| arg == "--cookies")
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

/// Extracts the value passed to `--cookies-from-browser` in an argv, for the same reason as
/// [`cookies_path_from_args`]. A profile in it can be a path under the user's home directory, and
/// yt-dlp's verbose echo prints it back.
fn cookies_browser_from_args(args: &[String]) -> Option<&str> {
    args.iter()
        .position(|arg| arg == "--cookies-from-browser")
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
    // Bound concurrent standalone runs (see STANDALONE_RUN_SEMAPHORE). Held for the whole function
    // (spawn through wait), so at most MAX_CONCURRENT_STANDALONE_RUNS run at once; excess callers
    // queue here rather than each spawning a process and buffering up to 128 MiB, and a queue
    // deeper than the in-flight ceiling is refused up front rather than enqueued without limit.
    let _permit = STANDALONE_RUN_SEMAPHORE
        .acquire(AppErrorCode::TooManyConcurrentYtDlpRuns)
        .await?;

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
        // tightly. Without it a single unterminated line could balloon far past the ring buffer's
        // intended bound (see MAX_PROGRESS_LINE_BYTES).
        while let Some(line_value) =
            read_lossy_line_capped(&mut reader, &mut line_buf, MAX_PROGRESS_LINE_BYTES).await
        {
            let line = line_value.trim_end().to_string();

            if should_keep_terminal_line(&line) {
                // Bound memory (and the IPC payload these lines become in `terminal_logs`) on a
                // chatty failure (retry storms, throttling notices), since `-v` is always passed
                // here. Keep the most recent lines, the same ring-buffer cap the download flow's
                // stderr uses (yt_dlp::download::MAX_CAPTURED_STDERR_LINES).
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
            // The caller signalled cancellation. Kill the whole tree immediately instead of
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
        // The detail is embedded in the returned AppError, which is serialized to the frontend and
        // written to the file log. yt-dlp's `-v` mode echoes the whole argv (the
        // `[debug] Command-line config: [...]` line), so besides the cookies path this line can
        // carry the full pasted URL with its playlist/tracking parameters. Redact both, matching the
        // success path's terminal_logs redaction. The `--` separator means the URL is always the
        // last argument.
        let url = args.last().map(String::as_str).unwrap_or_default();
        let detail = redact_sensitive_from_line(
            &detail,
            cookies_path_from_args(args),
            cookies_browser_from_args(args),
            url,
        );

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
/// but returned no comments while YouTube reports a positive `comment_count`, so the comments
/// exist and could not be retrieved (rate limiting, temporary unavailability). A `None`/`0`
/// reported count means comments are disabled or genuinely zero, which is not an error.
fn comments_extraction_looks_incomplete(reported_count: Option<i64>, extracted: usize) -> bool {
    extracted == 0 && reported_count.is_some_and(|count| count > 0)
}

pub async fn fetch_youtube_comments_async<R: Runtime>(
    app: &AppHandle<R>,
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

    // Register the run (when a run_id was supplied) so the frontend can cancel this comment backup
    // (which can run for up to YT_DLP_COMMENTS_TIMEOUT_SECS) promptly, instead of waiting it out.
    // The guard unregisters the run when this function returns.
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

pub async fn list_yt_dlp_formats_async<R: Runtime>(
    app: &AppHandle<R>,
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
    // The browser selector is redacted as it was *normalized* (the argv carries that form), so
    // the replacement matches the echoed value rather than whatever spacing the caller typed.
    let normalized_cookies_browser = normalize_cookies_browser(cookies_browser);

    for line in stdout_logs.iter_mut().chain(stderr_logs.iter_mut()) {
        *line = redact_sensitive_from_line(
            line,
            cookies_path,
            normalized_cookies_browser.as_deref(),
            &normalized_url,
        );
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
/// metadata fetch. The latter lets the frontend pre-check for an already-registered duplicate
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
mod tests;
