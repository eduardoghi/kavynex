use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::AppHandle;
use tokio::{io::BufReader, process::Command, sync::Mutex, time::timeout};

use crate::models::yt_dlp::{DownloadedMediaResult, YtDlpFormatMetadata};
use crate::services::binaries::{
    ffmpeg_location_argument, resolve_ffmpeg_binary_async, resolve_yt_dlp_binary_async,
};
use crate::services::filesystem::{
    clean_matching_files_in_dir, find_best_matching_file, replace_file_safely,
};
use crate::services::library_paths::ensure_library_dir;
use crate::services::logger;
use crate::services::temp_paths::yt_dlp_temp_dir;
use crate::services::thumbnail_download::download_thumbnail_for_media_async;
use crate::services::yt_dlp_cookies::{
    append_auth_args, normalize_cookies_browser, normalize_cookies_path,
};
use crate::services::yt_dlp_events::{
    emit_download_cancelled, emit_download_error, emit_download_finished, emit_download_log,
    emit_download_log_infallible,
};
use crate::services::yt_dlp_metadata::{
    fetch_yt_dlp_metadata, normalize_download_metadata, redact_cookies_path_from_line,
    sanitize_filename_component,
};
use crate::services::yt_dlp_registry::{
    register_download_run, set_download_pid, DownloadRunReleaseGuard,
};
use crate::services::yt_dlp_url::is_allowed_youtube_url;
use crate::utils::format::codec_is_present;
use crate::utils::io::read_lossy_line;
use crate::utils::path::{ensure_path_parent_inside_dir, relative_path_from_base};
use crate::utils::process::hide_console_async;
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

const YT_DLP_WAIT_POLL_MILLIS: u64 = 250;
const MAX_CAPTURED_STDERR_LINES: usize = 100;
// A download that produces no output AND whose temp files stop growing for this long is
// treated as hung (dead network, deadlocked ffmpeg) and killed. Output alone is not a
// sufficient liveness signal: a large ffmpeg merge/remux can run for minutes writing to the
// output file without printing a line, so file growth counts as activity too (see the stall
// check in the wait loop). This stays generous so a slow-but-progressing download or merge
// is never killed by mistake.
const YT_DLP_STALL_TIMEOUT_SECS: u64 = 300;

/// True when the child has produced no output for longer than the stall threshold.
fn download_is_stalled(now_ms: u64, last_activity_ms: u64, threshold_ms: u64) -> bool {
    now_ms.saturating_sub(last_activity_ms) > threshold_ms
}

/// Sums the byte sizes of the files in `dir` whose name starts with `prefix`. The stall
/// watchdog uses this to tell a silent-but-progressing ffmpeg merge (the output file keeps
/// growing) apart from a genuinely hung download. Best-effort: unreadable entries are skipped
/// and a missing/unreadable directory yields 0.
fn total_matching_file_size(dir: &Path, prefix: &str) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };

    entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .map(|name| name.starts_with(prefix))
                .unwrap_or(false)
        })
        .filter_map(|entry| entry.metadata().ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .sum()
}

fn unique_temp_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);

    format!("{}-{}", std::process::id(), nanos)
}

/// How the value following a flag must be redacted when building the log line.
enum PendingRedaction {
    None,
    /// Replace the whole value (used for `--cookies`).
    FullValue,
    /// Keep the `home:`/`temp:` scope prefix but drop the directory (used for `--paths`).
    PathsValue,
}

/// Redacts a `--paths` value, keeping its `SCOPE:` prefix but dropping the directory. The
/// directory sits under the per-user app cache (e.g. `C:\Users\<name>\AppData\...`), so it would
/// otherwise leak the OS username. `split_once(':')` splits on the scope separator even though a
/// Windows path also contains a drive colon, because the scope colon always comes first.
fn redact_paths_value(value: &str) -> String {
    match value.split_once(':') {
        Some((scope, _)) => format!("{scope}:<redacted>"),
        None => "<redacted>".to_string(),
    }
}

/// Joins yt-dlp args for display, redacting values that can leak local filesystem paths. The
/// value after `--cookies` reveals the cookies file location, and each `--paths` value carries
/// the temp directory under the user's app cache; both would expose the username/profile layout
/// in a log line that is shown in the app and may be pasted into a public bug report.
/// `--cookies-from-browser` (a browser name, not a path) is left intact.
fn redacted_args_for_log(args: &[String]) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(args.len());
    let mut pending = PendingRedaction::None;

    for arg in args {
        match pending {
            PendingRedaction::FullValue => {
                parts.push("<redacted>".to_string());
                pending = PendingRedaction::None;
                continue;
            }
            PendingRedaction::PathsValue => {
                parts.push(redact_paths_value(arg));
                pending = PendingRedaction::None;
                continue;
            }
            PendingRedaction::None => {}
        }

        if arg == "--cookies" {
            pending = PendingRedaction::FullValue;
        } else if arg == "--paths" {
            pending = PendingRedaction::PathsValue;
        }

        parts.push(arg.clone());
    }

    parts.join(" ")
}

/// Accepts only format ids built from the characters yt-dlp uses for concrete format ids
/// (ASCII alphanumerics plus `.`, `_`, `-`), optionally `+`-combined for a video+audio
/// selection such as `137+140`. Every part must be non-empty and must not start with `-`, so
/// the value placed after `-f` can never be parsed as a yt-dlp flag. This is defense in depth
/// on top of `resolve_format_has_video`, which additionally requires the id to match a real
/// format from the fetched metadata: since that metadata is attacker-influenced (it comes from
/// the video being downloaded), the id is filtered by character class before it is trusted.
fn is_valid_format_id(format_id: &str) -> bool {
    format_id.split('+').all(|part| {
        !part.is_empty()
            && !part.starts_with('-')
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    })
}

/// Resolves a (possibly `+`-combined) yt-dlp format selector against the fetched metadata
/// and returns whether the selection has a video track. Returns `None` if the selector - or
/// any part of a combined selector - is not a real format id from the metadata, which
/// rejects arbitrary selector syntax reaching yt-dlp's `-f` from a compromised frontend.
fn resolve_format_has_video(format_id: &str, formats: &[YtDlpFormatMetadata]) -> Option<bool> {
    let find = |id: &str| {
        formats.iter().find(|item| {
            item.format_id
                .as_deref()
                .map(|value| value.trim() == id)
                .unwrap_or(false)
        })
    };

    if let Some(format) = find(format_id) {
        return Some(codec_is_present(&format.vcodec));
    }

    if format_id.contains('+') {
        let mut has_video = false;

        for part in format_id.split('+').map(str::trim) {
            let format = find(part)?;

            if codec_is_present(&format.vcodec) {
                has_video = true;
            }
        }

        return Some(has_video);
    }

    None
}

/// Moves the freshly downloaded temp file into the media directory and returns its final
/// path. A download filename is deterministic for a given video+format, so a file already at
/// the destination is content that is already catalogued (and possibly shared with another
/// channel). It is never overwritten: re-downloading could replace the stored bytes with a
/// re-encoded variant, silently changing media already in the library. The existing file is
/// kept, and the caller's duplicate check decides what to do.
fn place_downloaded_file(
    downloaded_temp: &Path,
    media_dir: &Path,
    library_dir: &Path,
) -> AppResult<PathBuf> {
    let file_name = downloaded_temp.file_name().ok_or_else(|| {
        AppError::from_code(
            AppErrorCode::InvalidDownloadedFile,
            "downloaded file has no valid name",
        )
    })?;

    let final_destination = media_dir.join(file_name);
    ensure_path_parent_inside_dir(&final_destination, library_dir)?;

    if !final_destination.exists() {
        replace_file_safely(downloaded_temp, &final_destination)?;
    }

    Ok(final_destination)
}

/// Runs `place_downloaded_file` (a cross-device move can fall back to a full `fs::copy` of a
/// multi-GB video) on the blocking thread pool, so this heavy I/O never runs directly on an
/// async task.
async fn place_downloaded_file_async(
    downloaded_temp: PathBuf,
    media_dir: PathBuf,
    library_dir: PathBuf,
) -> AppResult<PathBuf> {
    run_blocking(move || place_downloaded_file(&downloaded_temp, &media_dir, &library_dir)).await
}

fn infer_is_live(metadata_live_status: Option<&str>, was_live: Option<bool>) -> bool {
    if was_live.unwrap_or(false) {
        return true;
    }

    let normalized = metadata_live_status.unwrap_or("").trim().to_lowercase();

    matches!(normalized.as_str(), "is_live" | "was_live" | "post_live")
}

fn find_live_chat_temp_file(temp_dir: &Path, file_prefix: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(temp_dir).ok()?;

    for entry in entries.flatten() {
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        let file_name = path.file_name()?.to_string_lossy().to_string();
        let normalized_name = file_name.to_lowercase();

        if normalized_name.starts_with(&file_prefix.to_lowercase())
            && normalized_name.contains("live_chat")
        {
            return Some(path);
        }
    }

    None
}

fn ensure_live_chat_dir(library_dir: &Path) -> AppResult<PathBuf> {
    let live_chat_dir = library_dir.join("live_chat");

    fs::create_dir_all(&live_chat_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateDirectoryFailed,
            format!("failed to create live chat directory: {e}"),
        )
    })?;

    Ok(live_chat_dir)
}

fn build_live_chat_relative_path(file_name: &Path) -> String {
    Path::new("live_chat")
        .join(file_name)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Cancels every active download and synchronously kills the process tree of each one
/// whose child has been spawned. Intended to run on app exit: it does not touch the async
/// runtime, so in-flight yt-dlp/ffmpeg children are terminated instead of being orphaned
/// when the window closes.
pub fn cancel_all_active_downloads_blocking() {
    let pids = crate::services::yt_dlp_registry::signal_cancel_all_and_collect_pids();

    for pid in pids {
        crate::utils::process::kill_process_tree_blocking(pid);
    }
}

#[derive(Debug)]
struct ValidatedDownloadInputs {
    url: String,
    run_id: String,
    format_id: String,
}

/// Validates and normalizes the download request coming from the frontend. Rejects empty
/// values and any URL that is not http(s). Cookies are handled separately since they
/// never produce an error (invalid values are simply ignored).
fn validate_download_inputs(
    url: &str,
    library_path: &str,
    run_id: &str,
    format_id: &str,
) -> AppResult<ValidatedDownloadInputs> {
    let url = url.trim().to_string();
    let run_id = run_id.trim().to_string();
    let format_id = format_id.trim().to_string();

    if url.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidUrl,
            "url is empty",
        ));
    }

    if !is_allowed_youtube_url(&url) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidUrl,
            "url must be an http(s) YouTube URL",
        ));
    }

    if library_path.trim().is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryPath,
            "library path is empty",
        ));
    }

    if run_id.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidRunId,
            "run_id is empty",
        ));
    }

    if format_id.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidFormatId,
            "format_id is empty",
        ));
    }

    if !is_valid_format_id(&format_id) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidFormatId,
            "format_id contains unexpected characters",
        ));
    }

    Ok(ValidatedDownloadInputs {
        url,
        run_id,
        format_id,
    })
}

/// Builds the yt-dlp argument vector for a media download.
///
/// Extracted as a pure function so the argv - the format selector after `-f`, the `--paths`
/// sandboxing that confines yt-dlp's writes to the run's temp directory, and the `--`
/// separator that keeps the URL from ever being reinterpreted as a flag - can be asserted in
/// tests without spawning a process. The URL is always last and always preceded by `--`.
#[allow(clippy::too_many_arguments)]
fn build_download_command_args(
    ffmpeg_location: &str,
    format_id: &str,
    download_live_chat: bool,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
    temp_dir: &Path,
    file_prefix: &str,
    url: &str,
) -> Vec<String> {
    let mut args = vec![
        "--ignore-config".to_string(),
        "--no-playlist".to_string(),
        "--restrict-filenames".to_string(),
        "--windows-filenames".to_string(),
        "--no-part".to_string(),
        "--newline".to_string(),
        "--progress".to_string(),
        "--no-warnings".to_string(),
        "--ffmpeg-location".to_string(),
        ffmpeg_location.to_string(),
        "-f".to_string(),
        format_id.to_string(),
    ];

    if download_live_chat {
        args.push("--write-subs".to_string());
        args.push("--sub-langs".to_string());
        args.push("live_chat".to_string());
    }

    append_auth_args(&mut args, cookies_browser, cookies_path);

    args.extend_from_slice(&[
        "--paths".to_string(),
        format!("home:{}", temp_dir.to_string_lossy()),
        "--paths".to_string(),
        format!("temp:{}", temp_dir.to_string_lossy()),
        "-o".to_string(),
        format!("{}.%(ext)s", file_prefix),
        // Separator so a URL can never be interpreted as a flag (defense in depth on
        // top of the http(s) scheme check).
        "--".to_string(),
        url.to_string(),
    ]);

    args
}

#[allow(clippy::too_many_arguments)]
pub async fn download_media_from_url_async(
    app: &AppHandle,
    url: &str,
    library_path: &str,
    run_id: &str,
    format_id: &str,
    download_live_chat: bool,
    skip_auto_thumbnail_download: bool,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
) -> AppResult<DownloadedMediaResult> {
    let validated = validate_download_inputs(url, library_path, run_id, format_id)?;
    let normalized_url = validated.url;
    let normalized_run_id = validated.run_id;
    let normalized_format_id = validated.format_id;
    let normalized_cookies_browser = normalize_cookies_browser(cookies_browser);
    let normalized_cookies_path = normalize_cookies_path(cookies_path);

    let cancel_flag = register_download_run(&normalized_run_id)?;
    // Release the registry entry on every exit path. The `?` operators below (binary
    // resolution, library dir, temp-dir creation) run before the main async block that used
    // to be the only place `unregister_download_run` was reached, so without this guard an
    // early failure there would leak the run_id in the process-global registry for good.
    let _run_release_guard = DownloadRunReleaseGuard::new(&normalized_run_id);
    let yt_dlp = resolve_yt_dlp_binary_async(app).await?;
    let ffmpeg = resolve_ffmpeg_binary_async(app).await?;
    let ffmpeg_location = ffmpeg_location_argument(&ffmpeg);

    let library_dir = ensure_library_dir(library_path)?;
    let temp_root_dir = yt_dlp_temp_dir(app)?;

    let unique_run_dir = format!(
        "{}-{}",
        sanitize_filename_component(&normalized_run_id),
        unique_temp_suffix()
    );
    let temp_dir = temp_root_dir.join(unique_run_dir);

    fs::create_dir_all(&temp_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateTempDirFailed,
            format!("failed to create temporary directory: {e}"),
        )
    })?;

    logger::info(
        "yt_dlp",
        format!(
            "download run started: run_id='{}', url='{}', format_id='{}', download_live_chat='{}', skip_auto_thumbnail_download='{}', cookies_browser='{}', cookies_path='{}'",
            normalized_run_id,
            normalized_url,
            normalized_format_id,
            download_live_chat,
            skip_auto_thumbnail_download,
            normalized_cookies_browser.clone().unwrap_or_default(),
            // Avoid writing the cookies file path to the log (it can end up in a public bug
            // report); record only whether one was provided.
            if normalized_cookies_path.is_some() {
                "<set>"
            } else {
                "<none>"
            }
        ),
    );

    let result = async {
        emit_download_log(
            app,
            &normalized_run_id,
            format!("Resolving metadata for: {}", normalized_url),
            "system",
        )?;

        if let Some(path) = normalized_cookies_path.as_ref() {
            // Show only the file name, never the full path: this line is rendered in the UI
            // terminal and may be pasted into a public bug report, and the directory reveals
            // the local username/profile layout.
            let file_name = Path::new(path)
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| "<set>".to_string());

            emit_download_log(
                app,
                &normalized_run_id,
                format!("Cookies file: {}", file_name),
                "system",
            )?;
        } else if let Some(browser) = normalized_cookies_browser.as_ref() {
            emit_download_log(
                app,
                &normalized_run_id,
                format!("Cookies from browser: {}", browser),
                "system",
            )?;
        }

        if download_live_chat {
            emit_download_log(
                app,
                &normalized_run_id,
                "Live chat replay: enabled",
                "system",
            )?;
        }

        if skip_auto_thumbnail_download {
            emit_download_log(
                app,
                &normalized_run_id,
                "Automatic thumbnail download: skipped (manual thumbnail provided)",
                "system",
            )?;
        }

        let metadata = match fetch_yt_dlp_metadata(
            &yt_dlp,
            &normalized_url,
            normalized_cookies_browser.as_deref(),
            normalized_cookies_path.as_deref(),
            Some(Arc::clone(&cancel_flag)),
        )
        .await
        {
            Ok(metadata) => metadata,
            Err(error) => {
                // The metadata phase now honors cancellation itself (killing the tree
                // promptly); surface that as a cancellation event rather than a generic error.
                if cancel_flag.load(Ordering::SeqCst) {
                    let message = "yt-dlp download cancelled";
                    emit_download_cancelled(app, &normalized_run_id, message);
                    return Err(AppError::from_code(
                        AppErrorCode::YtDlpDownloadCancelled,
                        message,
                    ));
                }

                emit_download_error(app, &normalized_run_id, error.message.clone());
                return Err(error);
            }
        };

        if cancel_flag.load(Ordering::SeqCst) {
            let message = "yt-dlp download cancelled";
            emit_download_cancelled(app, &normalized_run_id, message);

            return Err(AppError::from_code(
                AppErrorCode::YtDlpDownloadCancelled,
                message,
            ));
        }

        let thumbnail_path = if skip_auto_thumbnail_download {
            None
        } else {
            emit_download_log(
                app,
                &normalized_run_id,
                "Downloading thumbnail before media download",
                "system",
            )?;

            match download_thumbnail_for_media_async(
                app,
                &normalized_url,
                library_path,
                &metadata,
                normalized_cookies_browser.as_deref(),
                normalized_cookies_path.as_deref(),
                Some(Arc::clone(&cancel_flag)),
            )
            .await
            {
                Ok(path) => {
                    if path.is_some() {
                        emit_download_log(
                            app,
                            &normalized_run_id,
                            "Thumbnail downloaded successfully",
                            "system",
                        )?;
                    } else {
                        emit_download_log(
                            app,
                            &normalized_run_id,
                            "No thumbnail available for this media",
                            "system",
                        )?;
                    }

                    path
                }
                Err(error) => {
                    // The thumbnail phase now honors cancellation itself; report a cancel as a
                    // cancellation event instead of a thumbnail failure.
                    if cancel_flag.load(Ordering::SeqCst) {
                        let message = "yt-dlp download cancelled";
                        emit_download_cancelled(app, &normalized_run_id, message);
                        return Err(AppError::from_code(
                            AppErrorCode::YtDlpDownloadCancelled,
                            message,
                        ));
                    }

                    emit_download_error(
                        app,
                        &normalized_run_id,
                        format!(
                            "thumbnail download failed before media download: {}",
                            error.message
                        ),
                    );

                    return Err(error);
                }
            }
        };

        if cancel_flag.load(Ordering::SeqCst) {
            let message = "yt-dlp download cancelled";
            emit_download_cancelled(app, &normalized_run_id, message);

            return Err(AppError::from_code(
                AppErrorCode::YtDlpDownloadCancelled,
                message,
            ));
        }

        let selected_format = metadata
            .formats
            .iter()
            .find(|item| {
                item.format_id
                    .as_deref()
                    .map(|value| value.trim() == normalized_format_id)
                    .unwrap_or(false)
            })
            .cloned();

        let has_video = match resolve_format_has_video(&normalized_format_id, &metadata.formats) {
            Some(has_video) => has_video,
            None => {
                return Err(AppError::from_code(
                    AppErrorCode::YtDlpSelectedFormatNotFound,
                    "selected yt-dlp format was not found in metadata",
                ));
            }
        };

        let media_subdir = if has_video { "video" } else { "audio" };
        let media_dir = library_dir.join(media_subdir);

        fs::create_dir_all(&media_dir).map_err(|e| {
            AppError::from_code(
                AppErrorCode::CreateMediaDirFailed,
                format!("failed to create media directory: {e}"),
            )
        })?;

        let run_live_chat_dir = if download_live_chat {
            Some(ensure_live_chat_dir(&library_dir)?)
        } else {
            None
        };

        let (id, extractor, suggested_title, youtube_video_id, published_at) =
            normalize_download_metadata(&metadata)?;

        let is_live = infer_is_live(metadata.live_status.as_deref(), metadata.was_live);

        let thumbnail_url = metadata
            .thumbnail
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let safe_extractor = sanitize_filename_component(&extractor);
        let safe_id = sanitize_filename_component(&id);
        let safe_format_id = sanitize_filename_component(&normalized_format_id);

        let expected_ext = selected_format
            .as_ref()
            .and_then(|format| format.ext.as_ref())
            .map(|value| value.trim().trim_start_matches('.').to_lowercase())
            .filter(|value| !value.is_empty());

        let file_prefix = format!("{}_{}_{}", safe_extractor, safe_id, safe_format_id);
        let file_name_prefix = format!("{file_prefix}.");

        clean_matching_files_in_dir(&temp_dir, &file_name_prefix)?;

        emit_download_log(
            app,
            &normalized_run_id,
            format!(
                "Starting download: {} (format {})",
                suggested_title, normalized_format_id
            ),
            "system",
        )?;

        let args = build_download_command_args(
            &ffmpeg_location,
            &normalized_format_id,
            download_live_chat,
            normalized_cookies_browser.as_deref(),
            normalized_cookies_path.as_deref(),
            &temp_dir,
            &file_prefix,
            &normalized_url,
        );

        emit_download_log(
            app,
            &normalized_run_id,
            format!("yt-dlp args: {}", redacted_args_for_log(&args)),
            "system",
        )?;

        let mut command = Command::new(&yt_dlp);
        crate::utils::process::configure_process_group(&mut command);
        hide_console_async(&mut command);
        // If stdout/stderr capture fails below and the `?` returns early, the Child must not
        // be left running detached; mirrors the kill_on_drop used by every sibling yt-dlp
        // spawn (yt_dlp_metadata.rs, thumbnail_download.rs).
        command.kill_on_drop(true);

        let mut child = command
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                AppError::from_code(
                    AppErrorCode::YtDlpDownloadSpawnFailed,
                    format!("failed to start yt-dlp download: {e}"),
                )
            })?;

        let child_pid = child.id();

        // Record the pid so the whole yt-dlp/ffmpeg process tree can be killed if the app
        // exits before this download finishes.
        if let Some(pid) = child_pid {
            set_download_pid(&normalized_run_id, pid);
        }
        // Also track it in the process-wide registry so the exit handler's global sweep covers
        // it uniformly with the metadata/thumbnail children; killing a pid twice on exit (once
        // via the download registry, once via the global one) is harmless. Unregisters when
        // this download future completes.
        let _tracked_child =
            crate::services::process_registry::TrackedChildGuard::register(child_pid);

        // Stall detection: the reader tasks record the elapsed millis of the last line the
        // child produced; the wait loop kills the download if it goes silent for too long.
        let download_start = Instant::now();
        let last_activity_ms = Arc::new(AtomicU64::new(0));
        let last_activity_stdout = Arc::clone(&last_activity_ms);
        let last_activity_stderr = Arc::clone(&last_activity_ms);

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

        let app_stdout = app.clone();
        let app_stderr = app.clone();
        let run_id_stdout = normalized_run_id.clone();
        let run_id_stderr = normalized_run_id.clone();
        // The cookies file path can appear in a yt-dlp message (e.g. a "could not read cookies"
        // error) and would otherwise be streamed to the UI terminal and baked into the failure
        // message below. Redact it on both streams, mirroring the metadata flow, since that path
        // reveals the local username/profile and may be pasted into a public bug report.
        let cookies_path_stdout = normalized_cookies_path.clone();
        let cookies_path_stderr = normalized_cookies_path.clone();

        let stderr_buffer: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let stderr_buffer_reader = Arc::clone(&stderr_buffer);

        let stdout_task = tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut line_buf: Vec<u8> = Vec::new();

            while let Some(line) = read_lossy_line(&mut reader, &mut line_buf).await {
                last_activity_stdout.store(
                    download_start.elapsed().as_millis() as u64,
                    Ordering::Relaxed,
                );

                let line = redact_cookies_path_from_line(&line, cookies_path_stdout.as_deref());
                emit_download_log_infallible(&app_stdout, &run_id_stdout, line, "stdout");
            }
        });

        let stderr_task = tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line_buf: Vec<u8> = Vec::new();

            while let Some(line) = read_lossy_line(&mut reader, &mut line_buf).await {
                last_activity_stderr.store(
                    download_start.elapsed().as_millis() as u64,
                    Ordering::Relaxed,
                );

                // Redact before buffering so the failure message built from this buffer below is
                // redacted too, not just the live stream.
                let line = redact_cookies_path_from_line(&line, cookies_path_stderr.as_deref());

                let mut guard = stderr_buffer_reader.lock().await;

                if guard.len() >= MAX_CAPTURED_STDERR_LINES {
                    guard.remove(0);
                }

                guard.push(line.clone());
                drop(guard);

                emit_download_log_infallible(&app_stderr, &run_id_stderr, line, "stderr");
            }
        });

        let mut cancel_requested = false;
        let mut stalled = false;
        let mut last_observed_temp_size: u64 = 0;

        let status = loop {
            let user_cancelled = cancel_flag.load(Ordering::SeqCst);

            if !stalled
                && !user_cancelled
                && download_is_stalled(
                    download_start.elapsed().as_millis() as u64,
                    last_activity_ms.load(Ordering::Relaxed),
                    YT_DLP_STALL_TIMEOUT_SECS * 1000,
                )
            {
                // The child has gone silent past the threshold, but a large ffmpeg merge/remux
                // can run for minutes writing to the output file without printing a line. Before
                // killing it, check whether the temp files are still growing: if so it is
                // progressing, so record the growth as activity and keep waiting. Only a stretch
                // with neither output nor file growth is treated as a real stall.
                let current_temp_size = total_matching_file_size(&temp_dir, &file_prefix);

                if current_temp_size > last_observed_temp_size {
                    last_observed_temp_size = current_temp_size;
                    last_activity_ms.store(
                        download_start.elapsed().as_millis() as u64,
                        Ordering::Relaxed,
                    );
                } else {
                    stalled = true;
                }
            }

            if (user_cancelled || stalled) && !cancel_requested {
                cancel_requested = true;

                if let Some(pid) = child_pid {
                    crate::utils::process::kill_process_tree(pid).await;
                } else {
                    let _ = child.kill().await;
                }
            }

            match timeout(Duration::from_millis(YT_DLP_WAIT_POLL_MILLIS), child.wait()).await {
                Ok(wait_result) => {
                    break wait_result.map_err(|e| {
                        AppError::from_code(
                            AppErrorCode::YtDlpWaitFailed,
                            format!("failed while waiting for yt-dlp: {e}"),
                        )
                    })?;
                }
                Err(_) => {
                    continue;
                }
            }
        };

        if let Err(e) = stdout_task.await {
            logger::warn("yt_dlp", format!("yt-dlp stdout task failed: {e}"));
        }

        if let Err(e) = stderr_task.await {
            logger::warn("yt_dlp", format!("yt-dlp stderr task failed: {e}"));
        }

        if stalled {
            let message = "yt-dlp download stalled with no progress and was stopped";
            emit_download_error(app, &normalized_run_id, message);

            return Err(AppError::from_code(
                AppErrorCode::YtDlpDownloadTimeout,
                message,
            ));
        }

        if cancel_requested {
            let message = "yt-dlp download cancelled";
            emit_download_cancelled(app, &normalized_run_id, message);

            return Err(AppError::from_code(
                AppErrorCode::YtDlpDownloadCancelled,
                message,
            ));
        }

        if !status.success() {
            let stderr_message = {
                let guard = stderr_buffer.lock().await;

                if guard.is_empty() {
                    "yt-dlp failed".to_string()
                } else {
                    guard.join("\n")
                }
            };

            let message = if stderr_message.trim().is_empty() {
                "yt-dlp download failed".to_string()
            } else {
                format!("yt-dlp download failed: {}", stderr_message.trim())
            };

            emit_download_error(app, &normalized_run_id, message.clone());

            return Err(AppError::from_code(
                AppErrorCode::YtDlpDownloadFailed,
                message,
            ));
        }

        let downloaded_temp =
            find_best_matching_file(&temp_dir, &file_name_prefix, expected_ext.as_deref())
                .map_err(|_| {
                    AppError::from_code(
                        AppErrorCode::YtDlpDownloadedFileNotFound,
                        "download completed but the final file was not found",
                    )
                })?;

        let final_destination =
            place_downloaded_file_async(downloaded_temp, media_dir, library_dir.clone()).await?;

        let live_chat_file_path = if download_live_chat {
            if let Some(temp_live_chat_file) = find_live_chat_temp_file(&temp_dir, &file_prefix) {
                let live_chat_file_name = temp_live_chat_file.file_name().ok_or_else(|| {
                    AppError::from_code(
                        AppErrorCode::InvalidDownloadedFile,
                        "live chat file has no valid name",
                    )
                })?;

                let live_chat_dir = run_live_chat_dir.as_ref().ok_or_else(|| {
                    AppError::from_code(
                        AppErrorCode::DataDirectoryResolveFailed,
                        "app live chat directory was not initialized",
                    )
                })?;

                let final_live_chat_destination = live_chat_dir.join(live_chat_file_name);

                // Store live chat replays gzip-compressed to save disk; the frontend reader
                // transparently decompresses them.
                crate::services::live_chat_storage::compress_file_to(
                    &temp_live_chat_file,
                    &final_live_chat_destination,
                )?;

                Some(build_live_chat_relative_path(Path::new(
                    live_chat_file_name,
                )))
            } else {
                None
            }
        } else {
            None
        };

        let result = DownloadedMediaResult {
            file_path: relative_path_from_base(&library_dir, &final_destination)?,
            suggested_title: suggested_title.clone(),
            youtube_video_id,
            published_at,
            media_type: media_subdir.to_string(),
            thumbnail_url,
            thumbnail_path,
            is_live,
            live_chat_file_path,
        };

        emit_download_finished(
            app,
            &normalized_run_id,
            result.file_path.clone(),
            result.suggested_title.clone(),
        );

        logger::info(
            "yt_dlp",
            format!(
                "download run finished successfully: run_id='{}', file='{}', live_chat='{}'",
                normalized_run_id,
                result.file_path,
                result.live_chat_file_path.clone().unwrap_or_default()
            ),
        );

        Ok(result)
    }
    .await;

    let _ = fs::remove_dir_all(&temp_dir);
    // The registry entry is released by `_run_release_guard` when this function returns.

    if let Err(error) = &result {
        logger::error(
            "yt_dlp",
            format!(
                "download run failed: run_id='{}', error='{}'",
                normalized_run_id, error
            ),
        );
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(suffix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        std::env::temp_dir().join(format!(
            "kavynex-download-test-{}-{}-{}",
            std::process::id(),
            nanos,
            suffix
        ))
    }

    #[test]
    fn build_download_command_args_places_url_last_after_a_separator() {
        let temp = PathBuf::from(if cfg!(windows) {
            "C:\\tmp\\run"
        } else {
            "/tmp/run"
        });

        let args = build_download_command_args(
            "/opt/ffmpeg",
            "137+140",
            false,
            None,
            None,
            &temp,
            "yt_abc_137",
            "https://www.youtube.com/watch?v=abc",
        );

        // The URL is always the final argument and always immediately preceded by `--`, so
        // yt-dlp can never reinterpret it as a flag.
        assert_eq!(args.last().unwrap(), "https://www.youtube.com/watch?v=abc");
        assert_eq!(args[args.len() - 2], "--");

        // The chosen format follows `-f` verbatim.
        let format_index = args.iter().position(|arg| arg == "-f").unwrap();
        assert_eq!(args[format_index + 1], "137+140");

        // ffmpeg is pinned to the resolved binary.
        let ffmpeg_index = args.iter().position(|arg| arg == "--ffmpeg-location").unwrap();
        assert_eq!(args[ffmpeg_index + 1], "/opt/ffmpeg");

        // Output template and both `--paths` entries confine yt-dlp's writes to the run's dir.
        assert!(args.iter().any(|arg| arg == "yt_abc_137.%(ext)s"));
        assert!(args
            .iter()
            .any(|arg| arg == &format!("home:{}", temp.to_string_lossy())));
        assert!(args
            .iter()
            .any(|arg| arg == &format!("temp:{}", temp.to_string_lossy())));

        // Nothing live-chat or cookie related is added when not requested.
        assert!(!args.iter().any(|arg| arg == "--write-subs"));
        assert!(!args.iter().any(|arg| arg == "--cookies"));
        assert!(!args.iter().any(|arg| arg == "--cookies-from-browser"));
    }

    #[test]
    fn build_download_command_args_adds_live_chat_and_browser_cookies() {
        let temp = PathBuf::from(if cfg!(windows) {
            "C:\\tmp\\run"
        } else {
            "/tmp/run"
        });

        let args = build_download_command_args(
            "ffmpeg",
            "best",
            true,
            Some("firefox"),
            None,
            &temp,
            "prefix",
            "https://youtu.be/x",
        );

        // Live chat is requested as a subtitle track.
        let subs_index = args.iter().position(|arg| arg == "--write-subs").unwrap();
        assert_eq!(args[subs_index + 1], "--sub-langs");
        assert_eq!(args[subs_index + 2], "live_chat");

        // The browser cookie source is passed through.
        let cookies_index = args
            .iter()
            .position(|arg| arg == "--cookies-from-browser")
            .unwrap();
        assert_eq!(args[cookies_index + 1], "firefox");

        // The `--` separator + URL invariant still holds with the extra flags present.
        assert_eq!(args.last().unwrap(), "https://youtu.be/x");
        assert_eq!(args[args.len() - 2], "--");
    }

    #[test]
    fn place_downloaded_file_moves_when_destination_is_free() {
        let base = unique_temp_dir("place-move");
        let media_dir = base.join("video");
        fs::create_dir_all(&media_dir).unwrap();

        let temp_file = base.join("source.mp4");
        fs::write(&temp_file, b"fresh-download").unwrap();

        let final_path = place_downloaded_file(&temp_file, &media_dir, &base).unwrap();

        assert_eq!(final_path, media_dir.join("source.mp4"));
        assert_eq!(fs::read(&final_path).unwrap(), b"fresh-download");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn place_downloaded_file_never_overwrites_an_existing_destination() {
        let base = unique_temp_dir("place-keep");
        let media_dir = base.join("video");
        fs::create_dir_all(&media_dir).unwrap();

        // An already-catalogued file (e.g. the same video shared with another channel).
        let existing = media_dir.join("source.mp4");
        fs::write(&existing, b"already-catalogued").unwrap();

        // A fresh download of the same video+format lands in temp with the same name.
        let temp_file = base.join("source.mp4");
        fs::write(&temp_file, b"re-encoded-variant").unwrap();

        let final_path = place_downloaded_file(&temp_file, &media_dir, &base).unwrap();

        assert_eq!(final_path, existing);
        // The stored bytes must be untouched; the fresh download is discarded.
        assert_eq!(fs::read(&existing).unwrap(), b"already-catalogued");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn validate_download_inputs_accepts_and_trims_valid_request() {
        let validated = validate_download_inputs(
            "  https://www.youtube.com/watch?v=x  ",
            "/library",
            "  run-1 ",
            " 137+140 ",
        )
        .unwrap();

        assert_eq!(validated.url, "https://www.youtube.com/watch?v=x");
        assert_eq!(validated.run_id, "run-1");
        assert_eq!(validated.format_id, "137+140");
    }

    #[test]
    fn validate_download_inputs_rejects_empty_url() {
        let error = validate_download_inputs("   ", "/library", "run", "137").unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidUrl.as_str());
    }

    #[test]
    fn validate_download_inputs_rejects_non_youtube_url() {
        for url in [
            "file:///etc/passwd",
            "ftp://host/x",
            "javascript:alert(1)",
            "https://attacker.example/watch?v=x",
            "https://youtube.com.evil.com/watch?v=x",
        ] {
            let error = validate_download_inputs(url, "/library", "run", "137").unwrap_err();
            assert_eq!(error.code, AppErrorCode::InvalidUrl.as_str(), "url: {url}");
        }
    }

    #[test]
    fn validate_download_inputs_rejects_empty_library_run_and_format() {
        assert_eq!(
            validate_download_inputs("https://youtube.com/watch?v=x", "  ", "run", "137")
                .unwrap_err()
                .code,
            AppErrorCode::InvalidLibraryPath.as_str()
        );
        assert_eq!(
            validate_download_inputs("https://youtube.com/watch?v=x", "/lib", "  ", "137")
                .unwrap_err()
                .code,
            AppErrorCode::InvalidRunId.as_str()
        );
        assert_eq!(
            validate_download_inputs("https://youtube.com/watch?v=x", "/lib", "run", "  ")
                .unwrap_err()
                .code,
            AppErrorCode::InvalidFormatId.as_str()
        );
    }

    #[test]
    fn validate_download_inputs_rejects_format_id_with_unexpected_characters() {
        // A leading `-` (would be read as a flag after `-f`), selector syntax and shell
        // metacharacters must all be rejected before the request is dispatched.
        for format_id in [
            "-x",
            "137+-140",
            "bestvideo[height<=720]",
            "137;rm -rf",
            "137 140",
            "13$7",
        ] {
            let error =
                validate_download_inputs("https://youtube.com/watch?v=x", "/lib", "run", format_id)
                    .unwrap_err();
            assert_eq!(
                error.code,
                AppErrorCode::InvalidFormatId.as_str(),
                "format_id: {format_id}"
            );
        }
    }

    #[test]
    fn is_valid_format_id_accepts_real_ids_and_rejects_selectors() {
        // Concrete yt-dlp format ids, including hyphenated and `+`-combined ones.
        for id in ["137", "140", "137+140", "233-drc", "sb0", "hls_1080"] {
            assert!(is_valid_format_id(id), "should accept: {id}");
        }

        // Empty parts, a leading `-`, and anything outside the safe class are rejected.
        for id in ["", "-x", "137+", "+140", "137++140", "137 140", "a|b", "$(x)"] {
            assert!(!is_valid_format_id(id), "should reject: {id}");
        }
    }

    #[test]
    fn resolve_format_has_video_validates_single_and_combined_selectors() {
        let formats = vec![
            YtDlpFormatMetadata {
                format_id: Some("137".to_string()),
                vcodec: Some("avc1.640028".to_string()),
                ..Default::default()
            },
            YtDlpFormatMetadata {
                format_id: Some("140".to_string()),
                vcodec: Some("none".to_string()),
                ..Default::default()
            },
        ];

        // Single formats present in the metadata.
        assert_eq!(resolve_format_has_video("137", &formats), Some(true));
        assert_eq!(resolve_format_has_video("140", &formats), Some(false));

        // Combined video+audio: has video, both parts exist.
        assert_eq!(resolve_format_has_video("137+140", &formats), Some(true));

        // Unknown single format and a combined selector with an unknown part are rejected.
        assert_eq!(resolve_format_has_video("999", &formats), None);
        assert_eq!(resolve_format_has_video("137+999", &formats), None);

        // Arbitrary yt-dlp selector syntax never matches a metadata format id.
        assert_eq!(
            resolve_format_has_video("bestvideo[height<=720]+bestaudio", &formats),
            None
        );
    }

    #[test]
    fn download_is_stalled_only_after_threshold_of_silence() {
        let threshold = YT_DLP_STALL_TIMEOUT_SECS * 1000;

        // No output for longer than the threshold -> stalled.
        assert!(download_is_stalled(threshold + 1, 0, threshold));
        // Recent activity -> not stalled.
        assert!(!download_is_stalled(threshold + 1, threshold, threshold));
        // Exactly at the threshold -> not yet stalled.
        assert!(!download_is_stalled(threshold, 0, threshold));
    }

    #[test]
    fn total_matching_file_size_sums_only_prefixed_files() {
        let dir = unique_temp_dir("stall-size");
        fs::create_dir_all(&dir).unwrap();

        // Two downloaded streams sharing the prefix, plus the merge output growing.
        fs::write(dir.join("clip.f137.mp4"), b"aaaa").unwrap(); // 4 bytes
        fs::write(dir.join("clip.f140.m4a"), b"bb").unwrap(); // 2 bytes
        // Unrelated file and a directory named with the prefix must both be ignored.
        fs::write(dir.join("other.txt"), b"zzzzzzzz").unwrap();
        fs::create_dir_all(dir.join("clip.subdir")).unwrap();

        assert_eq!(total_matching_file_size(&dir, "clip."), 6);
        // A prefix that matches nothing is zero, not an error.
        assert_eq!(total_matching_file_size(&dir, "nomatch"), 0);
        // A missing directory is zero, not an error.
        assert_eq!(total_matching_file_size(&dir.join("missing"), "clip."), 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn redacted_args_for_log_redacts_cookies_file_but_not_browser() {
        let args = vec![
            "--cookies".to_string(),
            "/home/user/.config/cookies.txt".to_string(),
            "--cookies-from-browser".to_string(),
            "firefox".to_string(),
            "--paths".to_string(),
            "home:C:\\Users\\alice\\AppData\\Local\\com.kavynex.app\\cache\\run".to_string(),
            "--paths".to_string(),
            "temp:C:\\Users\\alice\\AppData\\Local\\com.kavynex.app\\cache\\run".to_string(),
            "--".to_string(),
            "https://youtube.com/watch?v=x".to_string(),
        ];

        let logged = redacted_args_for_log(&args);

        assert!(!logged.contains("/home/user/.config/cookies.txt"));
        assert!(logged.contains("--cookies <redacted>"));
        // The browser name is not sensitive and stays intact.
        assert!(logged.contains("--cookies-from-browser firefox"));
        // The temp directory (which embeds the OS username) is dropped, but the scope prefix is
        // kept for readability.
        assert!(!logged.contains("alice"));
        assert!(logged.contains("--paths home:<redacted>"));
        assert!(logged.contains("--paths temp:<redacted>"));
        assert!(logged.contains("-- https://youtube.com/watch?v=x"));
    }

    #[test]
    fn infer_is_live_detects_live_states() {
        assert!(infer_is_live(None, Some(true)));
        assert!(infer_is_live(Some("is_live"), None));
        assert!(infer_is_live(Some("was_live"), Some(false)));
        assert!(infer_is_live(Some("POST_LIVE"), None));
        assert!(infer_is_live(Some("  is_live  "), None));
    }

    #[test]
    fn infer_is_live_false_for_non_live() {
        assert!(!infer_is_live(None, None));
        assert!(!infer_is_live(Some("not_live"), Some(false)));
        assert!(!infer_is_live(Some(""), None));
    }

    #[test]
    fn build_live_chat_relative_path_uses_forward_slashes() {
        let path = build_live_chat_relative_path(Path::new("youtube_abc.live_chat.json"));
        assert_eq!(path, "live_chat/youtube_abc.live_chat.json");
    }

    #[test]
    fn find_live_chat_temp_file_matches_prefix_and_live_chat_token() {
        let dir = unique_temp_dir("live-chat");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("youtube_ID_137.live_chat.json"), b"{}").unwrap();
        fs::write(dir.join("youtube_ID_137.mp4"), b"x").unwrap();

        let found = find_live_chat_temp_file(&dir, "youtube_ID_137").unwrap();
        assert_eq!(
            found.file_name().unwrap().to_string_lossy(),
            "youtube_ID_137.live_chat.json"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_live_chat_temp_file_returns_none_without_live_chat_file() {
        let dir = unique_temp_dir("no-live-chat");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("youtube_ID_137.mp4"), b"x").unwrap();

        assert!(find_live_chat_temp_file(&dir, "youtube_ID_137").is_none());

        let _ = fs::remove_dir_all(&dir);
    }
}
