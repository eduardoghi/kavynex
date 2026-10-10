use std::fs;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Runtime};
use tokio::{io::BufReader, process::Command, sync::Mutex, time::timeout};

use crate::models::yt_dlp::{DownloadedMediaResult, YtDlpFormatMetadata};
use crate::services::binaries::{
    ffmpeg_location_argument, resolve_ffmpeg_binary_async, resolve_yt_dlp_binary_async,
};
use crate::services::filesystem::clean_matching_files_in_dir;
use crate::services::library::paths::resolve_existing_library_dir;
use crate::services::logger;
use crate::services::temp_paths::yt_dlp_temp_dir;
use crate::services::yt_dlp::cookies::{
    normalize_cookies_browser, normalize_cookies_path, redact_cookies_browser_selector,
};
use crate::services::yt_dlp::events::{
    emit_download_cancelled, emit_download_error, emit_download_finished, emit_download_log,
    emit_download_log_infallible,
};
use crate::services::yt_dlp::metadata::{
    fetch_yt_dlp_metadata, normalize_download_metadata, sanitize_filename_component,
    sanitize_identifier_component,
};
use crate::services::yt_dlp::registry::{
    register_download_run, set_download_pid, DownloadPidGuard, DownloadRunReleaseGuard,
    MAX_ACTIVE_RUNS,
};
use crate::services::yt_dlp::url::youtube_ref_for_log;
use crate::utils::bounded_semaphore::BoundedSemaphore;
use crate::utils::format::codec_is_present;
use crate::utils::io::{read_lossy_line_capped, MAX_PROGRESS_LINE_BYTES};
use crate::utils::naming::unique_temp_suffix;
use crate::utils::path::relative_path_from_base;
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

const YT_DLP_WAIT_POLL_MILLIS: u64 = 250;
const MAX_CAPTURED_STDERR_LINES: usize = 100;

// A download that produces no output AND whose temp files stop growing for this long is
// treated as hung (dead network, deadlocked ffmpeg) and killed. Output alone is not a
// sufficient liveness signal. A large ffmpeg merge/remux can run for minutes writing to the
// output file without printing a line, so file growth counts as activity too (see the stall
// check in the wait loop). This stays generous so a slow-but-progressing download or merge
// is never killed by mistake.
const YT_DLP_STALL_TIMEOUT_SECS: u64 = 300;
// Absolute ceiling on a single download's wall-clock time, independent of progress. The stall
// detector above only fires on the *absence* of progress; a pathological or hostile source that
// dribbles just enough bytes to keep resetting the stall timer could otherwise keep a yt-dlp/ffmpeg
// process alive forever. This backstop bounds that. It is set very generously so it never truncates
// a legitimate large single-video download on a slow link (yt-dlp runs with --no-playlist, so this
// is always one video), only a run that is effectively never going to finish.
const YT_DLP_MAX_RUNTIME_SECS: u64 = 12 * 60 * 60;

// Bounds how many media downloads run at once. Each spawns a yt-dlp/ffmpeg process tree that is
// CPU-, disk- and network-heavy, so without a cap a compromised or buggy frontend firing many
// distinct run ids could saturate the machine (the per-run registry only rejects a *duplicate* run
// id, not a burst of unique ones). Separate from the standalone metadata/comment cap in
// yt_dlp::metadata: a download's own metadata pre-fetch takes a standalone permit, so gating both on
// one semaphore could deadlock. A small limit keeps a couple of downloads progressing without
// thrashing.
const MAX_CONCURRENT_DOWNLOADS: usize = 2;

// One process-wide gate, through the same `BoundedSemaphore` as the other spawn sites
// (`yt_dlp::metadata`, `thumbnail::download`). A permit that cannot be had refuses the run rather
// than panicking or running without one, since running without one would drop the cap.
//
// The queue bound is `MAX_ACTIVE_RUNS` because `register_download_run` runs before this acquire and
// already refuses past it, so the queue behind these permits can never grow deeper than that.
static DOWNLOAD_SEMAPHORE: BoundedSemaphore =
    BoundedSemaphore::new(MAX_CONCURRENT_DOWNLOADS, MAX_ACTIVE_RUNS);

/// True when the child has produced no output for longer than the stall threshold.
fn download_is_stalled(now_ms: u64, last_activity_ms: u64, threshold_ms: u64) -> bool {
    now_ms.saturating_sub(last_activity_ms) > threshold_ms
}

/// True when the run has been going longer than the absolute cap, regardless of progress. This is
/// the backstop the stall detector cannot provide (see [`YT_DLP_MAX_RUNTIME_SECS`]). Kept a pure
/// function so the boundary can be pinned by a unit test without running a real download.
fn download_exceeded_runtime(elapsed_ms: u64, max_ms: u64) -> bool {
    elapsed_ms > max_ms
}

/// Sums the byte sizes of the files in `dir` whose name starts with `prefix`. The stall
/// watchdog uses this to tell a silent-but-progressing ffmpeg merge (the output file keeps
/// growing) apart from a genuinely hung download. Best-effort. Unreadable entries are skipped
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

/// Resolves a (possibly `+`-combined) yt-dlp format selector against the fetched metadata
/// and returns whether the selection has a video track. Returns `None` if the selector (or
/// any part of a combined selector) is not a real format id from the metadata, which
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

fn infer_is_live(metadata_live_status: Option<&str>, was_live: Option<bool>) -> bool {
    if was_live.unwrap_or(false) {
        return true;
    }

    let normalized = metadata_live_status.unwrap_or("").trim().to_lowercase();

    matches!(normalized.as_str(), "is_live" | "was_live" | "post_live")
}

/// Cancels every active download and synchronously kills the process tree of each one
/// whose child has been spawned. Intended to run on app exit. It does not touch the async
/// runtime, so in-flight yt-dlp/ffmpeg children are terminated instead of being orphaned
/// when the window closes.
pub fn cancel_all_active_downloads_blocking() {
    let pids = crate::services::yt_dlp::registry::signal_cancel_all_and_collect_pids();

    for pid in pids {
        crate::utils::process::kill_process_tree_blocking(pid);
    }
}

// Placing a finished download, and keeping it when that fails, live in `placement`. What is stored
// after the media (the live chat replay, the thumbnail) lives in `post_download`.
mod placement;
use placement::*;
mod post_download;
use post_download::*;

// The pure request validation, argument-vector construction and outcome classification live in
// the `command` submodule so they stay unit-testable apart from the async orchestration below.
mod command;
use command::{
    build_download_command_args, classify_download_termination, validate_download_inputs,
    DownloadTermination,
};
#[cfg(test)]
use command::{is_valid_format_id, MAX_RUN_ID_LEN};

// Re-exported because a local media import registers a run id in the same process registry, so
// `cancel_media_download` reaches an import exactly as it reaches a download. Both therefore have
// to agree on what a run id may be, and one definition is how that is guaranteed rather than
// remembered. See the function's own comment.
pub(crate) use command::is_valid_run_id;

// Re-exported for the same reason. `events::infer_log_level` labels a line for the in-app terminal
// and the stderr reader below decides whether that same line may enter the failure evidence. A line
// shown as a warning must not also be quoted back as the reason the download failed, so both ask
// one function rather than each spelling the test.
pub(crate) use command::line_is_warning;

// Redacting the argument vector before it reaches the in-app terminal (and, from there, a public
// bug report) also lives in its own submodule. It has a privacy consequence and no I/O, which is
// exactly the shape that belongs under the mutation gate rather than buried in the orchestration.
mod redaction;
#[cfg(test)]
use redaction::redact_paths_value;
use redaction::redacted_args_for_log;
use redaction::{redact_download_output_line, OutputRedaction};

/// How long a killed download may keep running before it is killed again.
const KILL_GRACE: Duration = Duration::from_secs(10);

/// Whether a kill requested `since_kill` ago has not taken, so it is time for the second one. Once
/// per run, since the second one includes the direct kill, which cannot fail to reach the child.
fn kill_is_overdue(since_kill: Option<Duration>, already_forced: bool) -> bool {
    !already_forced && since_kill.is_some_and(|elapsed| elapsed >= KILL_GRACE)
}

/// How a download child ended, before any of it is reported.
#[derive(Debug)]
struct ChildOutcome {
    success: bool,
    stalled: bool,
    cancel_requested: bool,
    timed_out: bool,
    /// The non-warning stderr lines, only on a failure that was neither stalled nor cancelled.
    captured_stderr: String,
}

/// The time limits `supervise_download_child` enforces. Production uses the constants above, and
/// the tests shrink them so a stall can be observed in milliseconds.
#[derive(Debug, Clone, Copy)]
struct SupervisionLimits {
    stall_ms: u64,
    max_runtime_ms: u64,
    poll_millis: u64,
}

impl SupervisionLimits {
    const PRODUCTION: Self = Self {
        stall_ms: YT_DLP_STALL_TIMEOUT_SECS * 1000,
        max_runtime_ms: YT_DLP_MAX_RUNTIME_SECS * 1000,
        poll_millis: YT_DLP_WAIT_POLL_MILLIS,
    };
}

/// Spawns the download child and supervises it to the end. Streams both pipes to the terminal,
/// kills the tree on a cancel, a stall or the run-time cap, and repeats the kill when the first one
/// did not take.
///
/// Separate from `download_media_from_url_async` so the supervision can run against a stand-in
/// child in tests. Classifying the outcome is the caller's job.
#[allow(clippy::too_many_arguments)]
async fn supervise_download_child<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    mut command: Command,
    temp_dir: &Path,
    file_prefix: &str,
    redaction: OutputRedaction,
    cancel_flag: &Arc<AtomicBool>,
    limits: SupervisionLimits,
) -> AppResult<ChildOutcome> {
    let normalized_run_id = run_id.to_string();
    let temp_dir = temp_dir.to_path_buf();
    let file_prefix = file_prefix.to_string();

    let mut child = command
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
    // Forgotten when this function returns, with the child reaped, rather than when the whole run
    // ends minutes later (see clear_download_pid).
    let _pid_registration = DownloadPidGuard::new(&normalized_run_id);
    // Also track it in the process-wide registry so the exit handler's global sweep covers
    // it uniformly with the metadata/thumbnail children; killing a pid twice on exit (once
    // via the download registry, once via the global one) is harmless. Unregisters when
    // this download future completes.
    let _tracked_child = crate::services::process_registry::TrackedChildGuard::register(child_pid);

    // Stall detection. The reader tasks record the elapsed millis of the last line the
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
    let output_redaction = Arc::new(redaction);
    let redaction_stdout = Arc::clone(&output_redaction);
    let redaction_stderr = Arc::clone(&output_redaction);

    let stderr_buffer: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_buffer_reader = Arc::clone(&stderr_buffer);

    let stdout_task = tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut line_buf: Vec<u8> = Vec::new();

        while let Some(line) =
            read_lossy_line_capped(&mut reader, &mut line_buf, MAX_PROGRESS_LINE_BYTES).await
        {
            last_activity_stdout.store(
                download_start.elapsed().as_millis() as u64,
                Ordering::Relaxed,
            );

            let line = redact_download_output_line(&line, &redaction_stdout);
            emit_download_log_infallible(&app_stdout, &run_id_stdout, line, "stdout");
        }
    });

    let stderr_task = tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line_buf: Vec<u8> = Vec::new();

        while let Some(line) =
            read_lossy_line_capped(&mut reader, &mut line_buf, MAX_PROGRESS_LINE_BYTES).await
        {
            last_activity_stderr.store(
                download_start.elapsed().as_millis() as u64,
                Ordering::Relaxed,
            );

            // Redact before buffering so the failure message built from this buffer below is
            // redacted too, not just the live stream.
            let line = redact_download_output_line(&line, &redaction_stderr);

            // A warning goes to the terminal but never into this buffer. The buffer is joined
            // verbatim into the user-facing failure message, so a run that warned about a
            // missing format and then failed for an unrelated reason would report the warnings
            // as the cause. Keeping them out is what makes dropping `--no-warnings` from the
            // argv free. The terminal gains the diagnostic, the error message is unchanged.
            if !line_is_warning(&line) {
                let mut guard = stderr_buffer_reader.lock().await;

                if guard.len() >= MAX_CAPTURED_STDERR_LINES {
                    guard.remove(0);
                }

                guard.push(line.clone());
            }

            emit_download_log_infallible(&app_stderr, &run_id_stderr, line, "stderr");
        }
    });

    let mut cancel_requested = false;
    let mut kill_requested_at: Option<Instant> = None;
    let mut kill_forced = false;
    let mut stalled = false;
    let mut timed_out = false;
    let mut last_observed_temp_size: u64 = 0;

    let status = loop {
        let user_cancelled = cancel_flag.load(Ordering::SeqCst);

        // Absolute run-time backstop, checked before the stall logic so a slow-drip run that
        // keeps resetting the stall timer is still stopped once it crosses the ceiling.
        if !timed_out
            && !user_cancelled
            && download_exceeded_runtime(
                download_start.elapsed().as_millis() as u64,
                limits.max_runtime_ms,
            )
        {
            timed_out = true;
        }

        if !stalled
            && !user_cancelled
            && download_is_stalled(
                download_start.elapsed().as_millis() as u64,
                last_activity_ms.load(Ordering::Relaxed),
                limits.stall_ms,
            )
        {
            // The child has gone silent past the threshold, but a large ffmpeg merge/remux
            // can run for minutes writing to the output file without printing a line. Before
            // killing it, check whether the temp files are still growing. If so it is
            // progressing, so record the growth as activity and keep waiting. Only a stretch
            // with neither output nor file growth is treated as a real stall.
            // Off the async runtime. read_dir is blocking I/O, and the project's convention
            // (utils::task) is that no synchronous filesystem work runs on a Tokio worker.
            // A join failure defaults to 0 (no growth observed), which is the safe direction.
            // it lets the stall be confirmed rather than masking a genuinely hung download.
            let temp_dir_probe = temp_dir.clone();
            let file_prefix_probe = file_prefix.clone();
            let current_temp_size = crate::utils::task::run_blocking(move || {
                Ok(total_matching_file_size(
                    &temp_dir_probe,
                    &file_prefix_probe,
                ))
            })
            .await
            .unwrap_or(0);

            if current_temp_size > last_observed_temp_size {
                // Say so. This branch is the app knowing something the user cannot see. The
                // child has printed nothing for the whole stall threshold, and the only reason
                // it is not being killed is that its output file is still growing. That is
                // exactly the stretch (a large ffmpeg merge) where the terminal stops moving and
                // the reasonable read is that the download hung, so cancelling is the next thing
                // a user does. Bounded by construction. Reaching here resets the activity clock,
                // so this can only be reported once per stall threshold.
                emit_download_log_infallible(
                    app,
                    &normalized_run_id,
                    format!(
                        "Still working: no output for {}s, but the file is still growing ({}). \
                         This is normal while audio and video are being combined.",
                        limits.stall_ms / 1000,
                        crate::utils::format::format_bytes(current_temp_size)
                    ),
                    "system",
                );

                last_observed_temp_size = current_temp_size;
                last_activity_ms.store(
                    download_start.elapsed().as_millis() as u64,
                    Ordering::Relaxed,
                );
            } else {
                stalled = true;
            }
        }

        if (user_cancelled || stalled || timed_out) && !cancel_requested {
            cancel_requested = true;
            kill_requested_at = Some(Instant::now());

            if let Some(pid) = child_pid {
                crate::utils::process::kill_process_tree(pid).await;
            } else {
                let _ = child.kill().await;
            }
        }

        // The tree kill can fail without a word (taskkill could not start, or gave up after its
        // own bound), and after a cancel nothing else ends this loop, since the stall and runtime
        // checks above stand down once the user cancelled. The run would then hold its download
        // slot until the app restarts. So a child still running well after the kill is killed
        // again, directly as well as by tree.
        if kill_is_overdue(kill_requested_at.map(|at| at.elapsed()), kill_forced) {
            kill_forced = true;

            if let Some(pid) = child_pid {
                crate::utils::process::kill_process_tree(pid).await;
            }

            let _ = child.start_kill();
        }

        match timeout(Duration::from_millis(limits.poll_millis), child.wait()).await {
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

    // Read the captured stderr only on the path that uses it (a non-zero exit that was neither
    // stalled nor cancelled), preserving the empty-buffer fallback the failure message expects.
    let captured_stderr = if !stalled && !cancel_requested && !status.success() {
        let guard = stderr_buffer.lock().await;

        if guard.is_empty() {
            "yt-dlp failed".to_string()
        } else {
            guard.join("\n")
        }
    } else {
        String::new()
    };

    Ok(ChildOutcome {
        success: status.success(),
        stalled,
        cancel_requested,
        timed_out,
        captured_stderr,
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn download_media_from_url_async<R: Runtime>(
    app: &AppHandle<R>,
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

    // Wait for a download slot (see DOWNLOAD_SEMAPHORE). Acquired after the run is registered, so a
    // cancel reaches a download still waiting in the queue, which stops waiting rather than holding
    // its place until a slot frees. Held until this function returns, so the slot covers the run.
    let _download_permit = tokio::select! {
        permit = DOWNLOAD_SEMAPHORE.acquire(AppErrorCode::TooManyConcurrentYtDlpRuns) => permit?,
        () = crate::utils::process::wait_for_cancel(Some(&cancel_flag)) => {
            let message = "yt-dlp download cancelled";
            emit_download_cancelled(app, &normalized_run_id, message);

            return Err(AppError::from_code(
                AppErrorCode::YtDlpDownloadCancelled,
                message,
            ));
        }
    };
    let yt_dlp = resolve_yt_dlp_binary_async(app).await?;
    let ffmpeg = resolve_ffmpeg_binary_async(app).await?;
    let ffmpeg_location = ffmpeg_location_argument(&ffmpeg);

    // Resolving the library touches the disk it lives on, which may be an external or network
    // drive that stalls, so it runs off the async runtime with the temp directory's creation.
    let (library_dir, temp_dir) = {
        let app = app.clone();
        let library_path = library_path.to_string();
        let unique_run_dir = format!(
            "{}-{}",
            sanitize_filename_component(&normalized_run_id),
            unique_temp_suffix()
        );

        run_blocking(move || {
            let library_dir = resolve_existing_library_dir(&library_path)?;
            let temp_dir = yt_dlp_temp_dir(&app)?.join(unique_run_dir);

            fs::create_dir_all(&temp_dir).map_err(|e| {
                AppError::from_code(
                    AppErrorCode::CreateTempDirFailed,
                    format!("failed to create temporary directory: {e}"),
                )
            })?;

            Ok((library_dir, temp_dir))
        })
        .await?
    };

    // yt-dlp reads and rewrites a copy in the run's own folder (see RunCookies).
    let run_cookies = crate::services::yt_dlp::cookies::RunCookies::prepare(
        normalized_cookies_path.as_deref(),
        &temp_dir,
    );
    let run_cookies_path = run_cookies.path();

    logger::info(
        "yt_dlp",
        format!(
            "download run started: run_id='{}', video='{}', format_id='{}', download_live_chat='{}', skip_auto_thumbnail_download='{}', cookies_browser='{}', cookies_path='{}'",
            normalized_run_id,
            // Log a reduced video reference, not the full pasted URL (which can carry playlist /
            // tracking params); the file log may be pasted into a public bug report.
            youtube_ref_for_log(&normalized_url),
            normalized_format_id,
            download_live_chat,
            skip_auto_thumbnail_download,
            // The browser name is kept, a profile or container after it is not. A profile is often
            // a path under the user's home directory, and this log may be pasted into a bug report.
            normalized_cookies_browser
                .as_deref()
                .map(redact_cookies_browser_selector)
                .unwrap_or_default(),
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
            format!(
                "Resolving metadata for: {}",
                youtube_ref_for_log(&normalized_url)
            ),
            "system",
        )?;

        if let Some(path) = normalized_cookies_path.as_ref() {
            // Show only the file name, never the full path. This line is rendered in the UI
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
            // Same rule as the file log. The UI terminal may be pasted into a bug report, so the
            // profile (often a path) is not shown, only that one was set.
            emit_download_log(
                app,
                &normalized_run_id,
                format!(
                    "Cookies from browser: {}",
                    redact_cookies_browser_selector(browser)
                ),
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
            run_cookies_path.as_deref(),
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
        // Neither folder is created here. The placement creates `video/` or `audio/` only inside a
        // library folder that is still there once the download is done (ensure_path_parent_inside_dir),
        // and storing the replay does the same for `live_chat/`. Creating them now, with
        // create_dir_all, ran on the async runtime against a drive that may stall, and could put a
        // new library folder at the path of one whose drive had just gone.
        let media_dir = library_dir.join(media_subdir);

        let run_live_chat_dir = download_live_chat.then(|| live_chat_dir_in(&library_dir));

        let (id, extractor, suggested_title, youtube_video_id, published_at) =
            normalize_download_metadata(&metadata)?;

        let is_live = infer_is_live(metadata.live_status.as_deref(), metadata.was_live);

        let safe_extractor = sanitize_filename_component(&extractor);
        // The id disambiguates collisions (two distinct ids that sanitize to the same string),
        // so a download can never silently overwrite a different video's file. See
        // sanitize_identifier_component.
        let safe_id = sanitize_identifier_component(&id);
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
            run_cookies_path.as_deref(),
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
        crate::utils::process::configure_child_async(&mut command);
        crate::services::binaries::expose_js_runtime_to_child(&mut command);
        // Starts in the run's own temp directory rather than wherever the app was launched from
        // (see utils::process::pin_working_dir_async).
        crate::utils::process::pin_working_dir_async(&mut command, &temp_dir);
        command.args(&args);

        // Both streams are redacted before anything sees a line: the terminal, the log, and the
        // failure message built from stderr below. See redact_download_output_line.
        let output_redaction = OutputRedaction {
            run_dir: temp_dir.to_string_lossy().into_owned(),
            ffmpeg_location: ffmpeg_location.clone(),
            url: normalized_url.clone(),
            cookies_path: normalized_cookies_path.clone(),
            cookies_browser: normalized_cookies_browser.clone(),
        };

        let ChildOutcome {
            success,
            stalled,
            cancel_requested,
            timed_out,
            captured_stderr,
        } = supervise_download_child(
            app,
            &normalized_run_id,
            command,
            &temp_dir,
            &file_prefix,
            output_redaction,
            &cancel_flag,
            SupervisionLimits::PRODUCTION,
        )
        .await?;

        // The absolute run-time cap is reported before the stall/cancel/exit classification. A run
        // killed for exceeding it comes back with cancel_requested set and a non-success status, so
        // classify_download_termination would otherwise report it as a plain cancel. It gets its own
        // message so the cause is clear rather than looking like a user cancel.
        if timed_out {
            let message = "yt-dlp download exceeded the maximum allowed run time and was stopped";
            emit_download_error(app, &normalized_run_id, message);

            return Err(AppError::from_code(
                AppErrorCode::YtDlpDownloadTimeout,
                message,
            ));
        }

        match classify_download_termination(
            stalled,
            cancel_requested,
            success,
            &captured_stderr,
        ) {
            DownloadTermination::Stalled => {
                let message = "yt-dlp download stalled with no progress and was stopped";
                emit_download_error(app, &normalized_run_id, message);

                return Err(AppError::from_code(
                    AppErrorCode::YtDlpDownloadTimeout,
                    message,
                ));
            }
            DownloadTermination::Cancelled => {
                let message = "yt-dlp download cancelled";
                emit_download_cancelled(app, &normalized_run_id, message);

                return Err(AppError::from_code(
                    AppErrorCode::YtDlpDownloadCancelled,
                    message,
                ));
            }
            DownloadTermination::Failed(message) => {
                emit_download_error(app, &normalized_run_id, message.clone());

                return Err(AppError::from_code(
                    AppErrorCode::YtDlpDownloadFailed,
                    message,
                ));
            }
            DownloadTermination::Succeeded => {}
        }

        // A cancel that arrived after yt-dlp exited is still honored before the file is placed, the
        // last point where stopping leaves nothing in the library. The Cancel button stays up for
        // the whole creation, not only while the process runs.
        if cancel_flag.load(Ordering::SeqCst) {
            let message = "yt-dlp download cancelled";
            emit_download_cancelled(app, &normalized_run_id, message);

            return Err(AppError::from_code(
                AppErrorCode::YtDlpDownloadCancelled,
                message,
            ));
        }

        let downloaded_temp =
            find_downloaded_media_file(&temp_dir, &file_name_prefix, expected_ext.as_deref())?;

        let placement =
            place_downloaded_file_async(downloaded_temp.clone(), media_dir, library_dir.clone())
                .await;

        let (final_destination, kept_existing) = match placement {
            Ok(placed) => placed,
            Err(error) => {
                return Err(
                    keep_unplaced_download(app, &normalized_run_id, downloaded_temp, error).await,
                );
            }
        };

        // Nothing past this point may fail the run. The file is in the library, and an error here
        // would leave it there with no row while the user is told the download failed.
        let file_path = relative_path_from_base(&library_dir, &final_destination)?;

        // Recorded now, before the live chat and the thumbnail, which can take minutes. A process
        // that dies in that stretch leaves this marker, and the next launch's sweep moves the file
        // to the library's trash instead of leaving it there with nothing pointing at it. The
        // registration replaces it with a marker naming everything it writes.
        let placement_marker = record_placement_marker(app, &file_path).await;

        if kept_existing {
            // The library already held these exact bytes (see place_downloaded_file), so the fresh
            // copy was discarded. Said so the user is not left guessing why nothing new appeared.
            emit_download_log_infallible(
                app,
                &normalized_run_id,
                "The library already held this exact file, so it was reused and the new download discarded.",
                "system",
            );
        }

        // yt-dlp merges into .mkv when the picked video and audio cannot share an mp4 or webm
        // container (VP9 or AV1 video with m4a audio, which is what high resolutions usually are).
        // The file is fine, but WebKit on macOS has no Matroska support, so the player there shows
        // nothing. Said here because the format list cannot know the merged container up front.
        let merged_into_mkv = final_destination
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("mkv"));

        if merged_into_mkv {
            emit_download_log_infallible(
                app,
                &normalized_run_id,
                "Saved as .mkv because the chosen video and audio streams cannot share an mp4 container. The macOS version of Kavynex cannot play .mkv files, so choose an mp4 format there to avoid this.",
                "system",
            );
        }

        // Best effort, like the thumbnail below, because the media is already in the library by now.
        let live_chat_file_path = if download_live_chat {
            store_live_chat_best_effort(
                app,
                &normalized_run_id,
                &temp_dir,
                &file_prefix,
                run_live_chat_dir.as_deref(),
            )
            .await
        } else {
            None
        };

        // After the media rather than before it, and never fatal. The video is what the user asked
        // to archive, so an image that will not download cannot cost them the backup, and fetching
        // it last means a download that fails leaves no thumbnail behind with nothing pointing at
        // it.
        let thumbnail_path = if skip_auto_thumbnail_download {
            None
        } else {
            download_thumbnail_best_effort(
                app,
                &normalized_run_id,
                library_path,
                &metadata,
                &cancel_flag,
            )
            .await
        };

        let result = DownloadedMediaResult {
            file_path,
            suggested_title: suggested_title.clone(),
            youtube_video_id,
            published_at,
            media_type: media_subdir.to_string(),
            thumbnail_path,
            is_live,
            live_chat_file_path,
            placement_marker,
        };

        run_cookies.keep_refreshed();

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

    // A download temp dir can hold multi-GB leftovers (a partial video, an ffmpeg merge output),
    // so this recursive removal is offloaded to the blocking pool rather than run directly on the
    // async task.
    let _ = run_blocking(move || {
        let _ = fs::remove_dir_all(&temp_dir);
        Ok::<(), AppError>(())
    })
    .await;
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
    use std::path::PathBuf;

    fn unique_temp_dir(suffix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-download-test-{suffix}-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    fn output_redaction(run_dir: &str, ffmpeg_location: &str) -> OutputRedaction {
        OutputRedaction {
            run_dir: run_dir.to_string(),
            ffmpeg_location: ffmpeg_location.to_string(),
            url: "https://www.youtube.com/watch?v=abc123&list=PLsecret&t=42".to_string(),
            cookies_path: None,
            cookies_browser: None,
        }
    }

    #[test]
    fn a_download_line_loses_the_run_folder_under_the_users_profile() {
        let redaction = output_redaction(
            r"C:\Users\alice\AppData\Local\kavynex\yt-dlp-temp\run-1",
            "ffmpeg",
        );

        let destination = redact_download_output_line(
            r"[download] Destination: C:\Users\alice\AppData\Local\kavynex\yt-dlp-temp\run-1\youtube_abc123_137.f137.mp4",
            &redaction,
        );
        // Python reprs, as in an [Errno] message, double every backslash.
        let errno = redact_download_output_line(
            r"ERROR: [Errno 28] No space left on device: 'C:\\Users\\alice\\AppData\\Local\\kavynex\\yt-dlp-temp\\run-1\\x.part'",
            &redaction,
        );

        assert!(!destination.contains("alice"), "{destination}");
        assert!(destination.contains("youtube_abc123_137.f137.mp4"));
        assert!(!errno.contains("alice"), "{errno}");
    }

    #[test]
    fn a_download_line_reduces_the_pasted_url_to_the_video() {
        let redaction = output_redaction("/tmp/run-1", "ffmpeg");

        let line = redact_download_output_line(
            "[youtube] Extracting URL: https://www.youtube.com/watch?v=abc123&list=PLsecret&t=42",
            &redaction,
        );

        assert!(!line.contains("PLsecret"), "{line}");
        assert!(line.contains("abc123"));
    }

    #[test]
    fn a_bare_ffmpeg_name_is_not_redacted_out_of_a_line() {
        let redaction = output_redaction("/tmp/run-1", "ffmpeg");

        assert_eq!(
            redact_download_output_line("[Merger] ffmpeg is merging formats", &redaction),
            "[Merger] ffmpeg is merging formats"
        );
    }

    #[test]
    fn an_ffmpeg_folder_under_the_users_profile_is_redacted() {
        let redaction = output_redaction("/tmp/run-1", "/home/alice/.local/share/kavynex/tools");

        let line = redact_download_output_line(
            "ERROR: Postprocessing: /home/alice/.local/share/kavynex/tools/ffmpeg exited with code 1",
            &redaction,
        );

        assert!(!line.contains("alice"), "{line}");
    }

    #[test]
    fn a_kill_is_repeated_once_it_has_had_its_grace_period() {
        assert!(!kill_is_overdue(None, false), "nothing was killed yet");
        assert!(!kill_is_overdue(Some(KILL_GRACE / 2), false));
        assert!(kill_is_overdue(Some(KILL_GRACE), false));
        assert!(
            !kill_is_overdue(Some(KILL_GRACE * 3), true),
            "the second kill is not repeated"
        );
    }

    #[test]
    fn an_unplaced_download_is_moved_under_its_own_name() {
        let run_dir = unique_temp_dir("unplaced-run");
        let kept_dir = unique_temp_dir("unplaced-kept");
        fs::create_dir_all(&run_dir).unwrap();
        fs::create_dir_all(&kept_dir).unwrap();
        let downloaded = run_dir.join("youtube_abc_18.mp4");
        fs::write(&downloaded, b"finished download").unwrap();

        let kept = move_into_dir_without_overwriting(&downloaded, &kept_dir).unwrap();

        assert_eq!(kept, kept_dir.join("youtube_abc_18.mp4"));
        assert_eq!(fs::read(&kept).unwrap(), b"finished download");
        assert!(!downloaded.exists());

        let _ = fs::remove_dir_all(run_dir);
        let _ = fs::remove_dir_all(kept_dir);
    }

    #[test]
    fn an_unplaced_download_never_replaces_one_kept_earlier() {
        let run_dir = unique_temp_dir("unplaced-again-run");
        let kept_dir = unique_temp_dir("unplaced-again-kept");
        fs::create_dir_all(&run_dir).unwrap();
        fs::create_dir_all(&kept_dir).unwrap();
        fs::write(kept_dir.join("youtube_abc_18.mp4"), b"kept before").unwrap();
        let downloaded = run_dir.join("youtube_abc_18.mp4");
        fs::write(&downloaded, b"kept now").unwrap();

        let kept = move_into_dir_without_overwriting(&downloaded, &kept_dir).unwrap();

        assert_ne!(kept, kept_dir.join("youtube_abc_18.mp4"));
        assert!(kept
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with("-youtube_abc_18.mp4"));
        assert_eq!(fs::read(&kept).unwrap(), b"kept now");
        assert_eq!(
            fs::read(kept_dir.join("youtube_abc_18.mp4")).unwrap(),
            b"kept before"
        );

        let _ = fs::remove_dir_all(run_dir);
        let _ = fs::remove_dir_all(kept_dir);
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

        // Dated by when it was written, whatever the installed yt-dlp defaults to.
        assert!(args.iter().any(|arg| arg == "--no-mtime"));

        // The chosen format follows `-f` verbatim.
        let format_index = args.iter().position(|arg| arg == "-f").unwrap();
        assert_eq!(args[format_index + 1], "137+140");

        // ffmpeg is pinned to the resolved binary.
        let ffmpeg_index = args
            .iter()
            .position(|arg| arg == "--ffmpeg-location")
            .unwrap();
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
        assert!(!args.iter().any(|arg| arg == "--ignore-errors"));
        assert!(!args.iter().any(|arg| arg == "--cookies"));
        assert!(!args.iter().any(|arg| arg == "--cookies-from-browser"));

        // Warnings are not suppressed on a download. They are the category that explains an
        // outcome the user did not ask for (a requested format that was unavailable, an extractor
        // that is out of date), and the in-app terminal is the only place they can be read. The
        // flag was here, so this pins its absence rather than leaving it to be re-added as tidying.
        assert!(!args.iter().any(|arg| arg == "--no-warnings"));
    }

    #[test]
    fn a_warning_line_is_recognized_however_yt_dlp_prefixes_it() {
        // Both spellings appear in real output. Bare, and with the reporting stage in between.
        assert!(line_is_warning(
            "WARNING: Requested format is not available"
        ));
        assert!(line_is_warning(
            "WARNING: [youtube] falling back to a generic extractor"
        ));
        assert!(line_is_warning("  warning: low download speed  "));
    }

    #[test]
    fn an_error_line_is_not_mistaken_for_a_warning() {
        // The direction that costs something. A genuine failure classified as a warning would be
        // dropped from the failure evidence, leaving the user an error message that says nothing.
        assert!(!line_is_warning("ERROR: unable to download video data"));
        assert!(!line_is_warning("[download] 12.3% of 4.00MiB"));
        assert!(!line_is_warning(""));
    }

    #[test]
    fn an_error_line_that_mentions_a_warning_is_still_an_error() {
        // The substring test alone answered "warning" to all three of these, which kept them out
        // of the stderr buffer and therefore out of the failure message. The text of a yt-dlp error
        // line is not this app's. It quotes back what YouTube returned for the video, and YouTube
        // uses "warning" for a strike on a channel, so this is reachable from content rather than
        // only from an unlucky phrasing.
        for line in [
            "ERROR: [youtube] abc123: Video unavailable. This channel received a warning.",
            "ERROR: Postprocessing: ignoring the warning above",
            "error: unable to download video data; see the warning above",
        ] {
            assert!(
                !line_is_warning(line),
                "a line declaring itself an error must not be classified as a warning: {line}"
            );
        }

        // And the case that keeps the refusal from being a blanket one. A warning line that
        // mentions no error is still a warning, so the terminal keeps the diagnostic that dropping
        // `--no-warnings` was meant to surface.
        assert!(line_is_warning(
            "WARNING: Requested format is not available; falling back"
        ));
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
        // And a replay that fails to download does not abort the media with it.
        assert!(args.iter().any(|arg| arg == "--ignore-errors"));

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

    fn candidate(name: &str, len: u64) -> (PathBuf, u64) {
        (PathBuf::from(name), len)
    }

    #[test]
    fn a_merged_download_is_picked_over_a_newer_or_larger_live_chat_replay() {
        // A merged format has no expected extension. The replay used to win on mtime whenever
        // yt-dlp dated the video by the server's Last-Modified, and was then stored as the video.
        let picked = pick_downloaded_media(
            vec![
                candidate("youtube_ID_137_140.live_chat.json", 50_000_000),
                candidate("youtube_ID_137_140.mkv", 1_000),
            ],
            None,
        );

        assert_eq!(picked, Some(PathBuf::from("youtube_ID_137_140.mkv")));
    }

    #[test]
    fn the_expected_extension_wins_over_a_larger_media_file() {
        let picked = pick_downloaded_media(
            vec![candidate("x.webm", 900), candidate("x.mp4", 10)],
            Some("MP4"),
        );

        assert_eq!(picked, Some(PathBuf::from("x.mp4")));
    }

    #[test]
    fn without_an_expected_extension_the_largest_media_file_is_the_download() {
        // A part yt-dlp left behind next to the merged file is smaller than the merge.
        let picked = pick_downloaded_media(
            vec![candidate("x.f140.m4a", 300), candidate("x.mp4", 1_300)],
            None,
        );

        assert_eq!(picked, Some(PathBuf::from("x.mp4")));
    }

    #[test]
    fn nothing_is_picked_when_no_file_is_media() {
        let picked = pick_downloaded_media(
            vec![
                candidate("x.live_chat.json", 10),
                candidate("x.en.vtt", 10),
                candidate("x.webp", 10),
            ],
            None,
        );

        assert_eq!(picked, None);
    }

    #[test]
    fn place_downloaded_file_refuses_a_file_that_is_not_media() {
        let base = unique_temp_dir("place-not-media");
        let media_dir = base.join("video");
        fs::create_dir_all(&media_dir).unwrap();

        let temp_file = base.join("youtube_ID_137.live_chat.json");
        fs::write(&temp_file, b"{}").unwrap();

        let error = place_downloaded_file(&temp_file, &media_dir, &base)
            .expect_err("a replay must never be stored as the video");

        assert_eq!(error.code, AppErrorCode::InvalidDownloadedFile.as_str());
        assert!(!media_dir.join("youtube_ID_137.live_chat.json").exists());

        let _ = fs::remove_dir_all(&base);
    }

    fn library_name_for(bytes: &[u8], extension: &str) -> String {
        let probe = unique_temp_dir("name-probe");
        fs::create_dir_all(&probe).unwrap();
        let file = probe.join("bytes");
        fs::write(&file, bytes).unwrap();
        let digest = crate::utils::hash::file_hash(&file).unwrap();
        let _ = fs::remove_dir_all(&probe);

        crate::services::library::media::content_addressed_media_name(&digest, extension)
    }

    #[test]
    fn a_placed_download_is_named_after_its_content() {
        let base = unique_temp_dir("place-move");
        let media_dir = base.join("video");
        fs::create_dir_all(&media_dir).unwrap();

        let temp_file = base.join("youtube_ID_137.MP4");
        fs::write(&temp_file, b"fresh-download").unwrap();

        let (final_path, kept_existing) =
            place_downloaded_file(&temp_file, &media_dir, &base).unwrap();

        assert!(
            !kept_existing,
            "a free destination must place the fresh file"
        );
        assert_eq!(
            final_path,
            media_dir.join(library_name_for(b"fresh-download", "mp4"))
        );
        assert_eq!(fs::read(&final_path).unwrap(), b"fresh-download");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_download_already_in_the_library_is_reused_and_left_untouched() {
        let base = unique_temp_dir("place-keep");
        let media_dir = base.join("video");
        fs::create_dir_all(&media_dir).unwrap();

        // The same bytes, already catalogued (the same video saved for another channel).
        let existing = media_dir.join(library_name_for(b"same-content", "mp4"));
        fs::write(&existing, b"same-content").unwrap();

        let temp_file = base.join("youtube_ID_137.mp4");
        fs::write(&temp_file, b"same-content").unwrap();

        let (final_path, kept_existing) =
            place_downloaded_file(&temp_file, &media_dir, &base).unwrap();

        assert!(
            kept_existing,
            "an existing copy must be reported as kept so the caller can notify the user"
        );
        assert_eq!(final_path, existing);
        assert_eq!(fs::read(&existing).unwrap(), b"same-content");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_damaged_library_copy_is_replaced_by_the_fresh_download() {
        let base = unique_temp_dir("place-repair");
        let media_dir = base.join("video");
        fs::create_dir_all(&media_dir).unwrap();

        // A file named after the right content whose bytes have since gone bad.
        let damaged = media_dir.join(library_name_for(b"intact-content", "mp4"));
        fs::write(&damaged, b"bit-rotted").unwrap();

        let temp_file = base.join("youtube_ID_137.mp4");
        fs::write(&temp_file, b"intact-content").unwrap();

        let (final_path, kept_existing) =
            place_downloaded_file(&temp_file, &media_dir, &base).unwrap();

        assert!(!kept_existing, "a damaged copy is not a copy worth keeping");
        assert_eq!(final_path, damaged);
        assert_eq!(fs::read(&final_path).unwrap(), b"intact-content");

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
    fn is_valid_format_id_matches_the_shared_fixture() {
        // The frontend's buildMergedFormats (src/services/yt-dlp-format-rules.ts) synthesizes the
        // merged `<video>+<audio>` selector this rule then validates, and TypeScript has its own copy
        // of the rule (isValidYtDlpFormatId) so it can flag a bad selector before the round trip. The
        // two are independent implementations that must agree on every id. A drift would let a
        // selector the frontend built come back as a raw backend error instead of being caught up
        // front. Both sides assert against the same shared cases (see
        // src/services/yt-dlp-format-rules.test.ts), so a change to either rule that the other did not
        // follow fails a test here rather than surfacing to a user.
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/yt-dlp-format-id-cases.json"
        ));
        let cases: serde_json::Value =
            serde_json::from_str(raw).expect("the shared fixture must be valid JSON");

        for id in cases["valid"].as_array().expect("valid must be an array") {
            let id = id.as_str().expect("each case must be a string");
            assert!(
                is_valid_format_id(id),
                "the shared fixture marks {id:?} valid but Rust rejects it"
            );
        }

        for id in cases["invalid"]
            .as_array()
            .expect("invalid must be an array")
        {
            let id = id.as_str().expect("each case must be a string");
            assert!(
                !is_valid_format_id(id),
                "the shared fixture marks {id:?} invalid but Rust accepts it"
            );
        }
    }

    #[test]
    fn validate_download_inputs_rejects_a_too_long_or_malformed_run_id() {
        // A legitimate run_id is a short UUID; the backend still bounds length and charset so a
        // compromised frontend cannot drive an arbitrarily long or path-significant value into the
        // download temp-directory name.
        let long_run_id = "a".repeat(MAX_RUN_ID_LEN + 1);

        for run_id in [long_run_id.as_str(), "run/../etc", "run id", "run\\x"] {
            let error =
                validate_download_inputs("https://youtube.com/watch?v=x", "/lib", run_id, "137")
                    .unwrap_err();
            assert_eq!(
                error.code,
                AppErrorCode::InvalidRunId.as_str(),
                "run_id: {run_id:?}"
            );
        }

        // A real UUID-shaped run id is accepted (charset and length both within bounds).
        assert!(is_valid_run_id("3f2504e0-4f89-41d3-9a0c-0305e82c3301"));
        assert!(is_valid_run_id(&"a".repeat(MAX_RUN_ID_LEN)));
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

        // Combined video+audio. Has video, both parts exist.
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
    fn classify_download_termination_applies_stall_cancel_failure_precedence() {
        // A stall preempts everything. A killed-for-stalling child also comes back non-success with
        // the cancel flag set, so the exit status alone must not win.
        assert_eq!(
            classify_download_termination(true, true, false, "boom"),
            DownloadTermination::Stalled
        );

        // A cancel preempts a non-zero exit for the same reason (the kill sets both).
        assert_eq!(
            classify_download_termination(false, true, false, "boom"),
            DownloadTermination::Cancelled
        );

        // A clean, uncancelled, un-stalled exit succeeds.
        assert_eq!(
            classify_download_termination(false, false, true, ""),
            DownloadTermination::Succeeded
        );
    }

    #[test]
    fn classify_download_termination_shapes_the_failure_message() {
        // A non-zero exit carries the stderr, prefixed and trimmed.
        assert_eq!(
            classify_download_termination(false, false, false, "  ERROR: unavailable  "),
            DownloadTermination::Failed("yt-dlp download failed: ERROR: unavailable".to_string())
        );

        // An empty captured stderr falls back to the bare message rather than a dangling prefix.
        assert_eq!(
            classify_download_termination(false, false, false, "   "),
            DownloadTermination::Failed("yt-dlp download failed".to_string())
        );
    }

    #[test]
    fn a_failure_message_keeps_only_the_end_of_a_long_stderr() {
        // The cause is at the end, and the message reaches the modal and one line of the log.
        let stderr = (0..100)
            .map(|index| format!("line {index}: {}", "x".repeat(2000)))
            .chain(std::iter::once("ERROR: the real cause".to_string()))
            .collect::<Vec<_>>()
            .join("\n");

        let DownloadTermination::Failed(message) =
            classify_download_termination(false, false, false, &stderr)
        else {
            panic!("a non-zero exit is a failure");
        };

        assert!(message.ends_with("ERROR: the real cause"), "{message}");
        assert!(message.len() < 2000, "{} bytes", message.len());
        assert!(!message.contains("line 0:"));
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
    fn download_exceeded_runtime_only_past_the_cap() {
        let max = YT_DLP_MAX_RUNTIME_SECS * 1000;

        // Past the cap -> exceeded.
        assert!(download_exceeded_runtime(max + 1, max));
        // Exactly at the cap -> not yet.
        assert!(!download_exceeded_runtime(max, max));
        // Well under the cap -> not exceeded.
        assert!(!download_exceeded_runtime(0, max));
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
            "--ffmpeg-location".to_string(),
            "C:\\Users\\alice\\AppData\\Roaming\\com.kavynex.app\\tools".to_string(),
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
        // The ffmpeg directory can fall back to <app_data_dir>/tools, which embeds the OS
        // username, so its value is dropped just like the cookies path.
        assert!(logged.contains("--ffmpeg-location <redacted>"));
        // The browser name is not sensitive and stays intact.
        assert!(logged.contains("--cookies-from-browser firefox"));
        // The temp directory (which embeds the OS username) is dropped, but the scope prefix is
        // kept for readability.
        assert!(!logged.contains("alice"));
        assert!(logged.contains("--paths home:<redacted>"));
        assert!(logged.contains("--paths temp:<redacted>"));
        // The URL after `--` is reduced to its video id, dropping any playlist/tracking params,
        // since this line is shown in the UI terminal and may be pasted into a public bug report.
        assert!(!logged.contains("https://youtube.com/watch?v=x"));
        assert!(logged.contains("-- youtube.com?v=x"));
    }

    #[test]
    fn redacted_args_for_log_hides_the_browser_profile_but_keeps_the_browser() {
        // A profile is often a path under the user's home directory, so it is the same kind of
        // value the `--cookies` redaction exists for, and this line reaches the UI terminal.
        let args = vec![
            "--cookies-from-browser".to_string(),
            "firefox:/home/alice/.mozilla/firefox/abc.default::Work".to_string(),
            "--".to_string(),
            "https://youtube.com/watch?v=x".to_string(),
        ];

        let logged = redacted_args_for_log(&args);

        assert!(!logged.contains("alice"));
        assert!(!logged.contains("Work"));
        assert!(logged.contains("--cookies-from-browser firefox:<redacted>::<redacted>"));
    }

    #[test]
    fn redact_paths_value_keeps_the_scope_and_drops_everything_after_it() {
        // The scope prefix is kept for readability, the directory is not. It sits under the
        // per-user app cache and so embeds the OS username.
        assert_eq!(
            redact_paths_value("home:C:\\Users\\alice\\AppData\\Local\\cache"),
            "home:<redacted>"
        );
        assert_eq!(
            redact_paths_value("temp:/home/alice/.cache/kavynex"),
            "temp:<redacted>"
        );

        // The split is on the *first* colon, which is always the scope separator. A Windows drive
        // colon comes after it and must not be what the value is cut on.
        assert_eq!(
            redact_paths_value("home:C:\\Users\\alice"),
            "home:<redacted>"
        );

        // A value with no scope at all has nothing safe to keep, so the whole thing goes. This is
        // the branch the argv test cannot reach, since build_download_command_args always emits the
        // `home:`/`temp:` prefix.
        assert_eq!(redact_paths_value("/home/alice/cache"), "<redacted>");
        assert_eq!(redact_paths_value(""), "<redacted>");
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

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap()
    }

    #[tokio::test]
    async fn the_live_chat_replay_is_stored_compressed_in_the_library() {
        let root = unique_temp_dir("live-chat-store");
        let temp_dir = root.join("run");
        let live_chat_dir = root.join("library").join("live_chat");
        fs::create_dir_all(&temp_dir).unwrap();
        fs::create_dir_all(&live_chat_dir).unwrap();
        fs::write(
            temp_dir.join("youtube_ID_137.live_chat.json"),
            b"{\"a\":1}\n",
        )
        .unwrap();

        let app = mock_app();
        let stored = store_live_chat_best_effort(
            app.handle(),
            "run-1",
            &temp_dir,
            "youtube_ID_137",
            Some(&live_chat_dir),
        )
        .await;

        assert_eq!(
            stored.as_deref(),
            Some("live_chat/youtube_ID_137.live_chat.json")
        );
        assert!(live_chat_dir
            .join("youtube_ID_137.live_chat.json")
            .is_file());

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_replay_that_cannot_be_stored_leaves_the_media_without_one_instead_of_failing() {
        // The media is already in the library when this runs. Failing here used to abandon a
        // finished download with no row and no crash marker behind it.
        let root = unique_temp_dir("live-chat-unstorable");
        let temp_dir = root.join("run");
        fs::create_dir_all(&temp_dir).unwrap();
        fs::write(temp_dir.join("youtube_ID_137.live_chat.json"), b"{}\n").unwrap();
        // A file where the live chat directory should be, so nothing can be written under it.
        let not_a_dir = root.join("live_chat");
        fs::write(&not_a_dir, b"").unwrap();

        let app = mock_app();
        let stored = store_live_chat_best_effort(
            app.handle(),
            "run-1",
            &temp_dir,
            "youtube_ID_137",
            Some(&not_a_dir),
        )
        .await;

        assert_eq!(stored, None);

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_replay_is_not_stored_into_a_library_folder_that_went_away() {
        // The download can take hours, and the library's drive can go in that time. Recreating the
        // folder would start an empty library at its path.
        let root = unique_temp_dir("live-chat-library-gone");
        let temp_dir = root.join("run");
        fs::create_dir_all(&temp_dir).unwrap();
        fs::write(temp_dir.join("youtube_ID_137.live_chat.json"), b"{}\n").unwrap();
        let library = root.join("library");

        let app = mock_app();
        let stored = store_live_chat_best_effort(
            app.handle(),
            "run-1",
            &temp_dir,
            "youtube_ID_137",
            Some(&live_chat_dir_in(&library)),
        )
        .await;

        assert_eq!(stored, None);
        assert!(
            !library.exists(),
            "the library folder must not be recreated"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn no_replay_from_yt_dlp_is_not_an_error() {
        let root = unique_temp_dir("live-chat-none");
        fs::create_dir_all(&root).unwrap();

        let app = mock_app();
        let stored = store_live_chat(app.handle(), "run-1", &root, "youtube_ID_137", None).await;

        assert_eq!(stored.unwrap(), None);

        let _ = fs::remove_dir_all(&root);
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
    fn find_live_chat_temp_file_passes_over_what_an_unfinished_replay_leaves() {
        let dir = unique_temp_dir("live-chat-partial");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("youtube_ID_137.live_chat.json.part"), b"{").unwrap();
        fs::write(dir.join("youtube_ID_137.live_chat.json.ytdl"), b"{}").unwrap();

        assert!(find_live_chat_temp_file(&dir, "youtube_ID_137").is_none());

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

    // The supervision of the download child, against stand-in children. Each spawns a real process
    // the way the metadata tests do (see metadata/tests.rs for the runner note).

    fn shell(script: &str) -> Command {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", script]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", script]);
            command
        };

        crate::utils::process::configure_child_async(&mut command);
        command
    }

    fn silent_for_thirty_seconds() -> Command {
        if cfg!(windows) {
            shell("ping -n 30 127.0.0.1 > NUL")
        } else {
            shell("sleep 30")
        }
    }

    const FAST_LIMITS: SupervisionLimits = SupervisionLimits {
        stall_ms: 500,
        max_runtime_ms: 60_000,
        poll_millis: 50,
    };

    async fn supervise(
        command: Command,
        temp_dir: &Path,
        cancel_flag: &Arc<AtomicBool>,
        limits: SupervisionLimits,
    ) -> ChildOutcome {
        let app = mock_app();

        supervise_download_child(
            app.handle(),
            "supervision-test",
            command,
            temp_dir,
            "youtube_ID_137",
            output_redaction(&temp_dir.to_string_lossy(), "ffmpeg"),
            cancel_flag,
            limits,
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn a_child_that_exits_zero_is_a_success() {
        let temp_dir = unique_temp_dir("supervise-ok");
        fs::create_dir_all(&temp_dir).unwrap();

        let outcome = supervise(
            shell("echo [download] 100%"),
            &temp_dir,
            &Arc::new(AtomicBool::new(false)),
            FAST_LIMITS,
        )
        .await;

        assert!(outcome.success);
        assert!(!outcome.stalled && !outcome.cancel_requested && !outcome.timed_out);
        assert!(outcome.captured_stderr.is_empty());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn a_failing_child_reports_its_errors_but_not_its_warnings() {
        let temp_dir = unique_temp_dir("supervise-fail");
        fs::create_dir_all(&temp_dir).unwrap();

        let script = if cfg!(windows) {
            "echo WARNING: a format is missing 1>&2 & echo ERROR: boom 1>&2 & exit /b 1"
        } else {
            "echo 'WARNING: a format is missing' >&2; echo 'ERROR: boom' >&2; exit 1"
        };

        let outcome = supervise(
            shell(script),
            &temp_dir,
            &Arc::new(AtomicBool::new(false)),
            FAST_LIMITS,
        )
        .await;

        assert!(!outcome.success);
        assert!(outcome.captured_stderr.contains("ERROR: boom"));
        assert!(!outcome.captured_stderr.contains("WARNING"));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn a_silent_child_is_killed_as_stalled() {
        let temp_dir = unique_temp_dir("supervise-stall");
        fs::create_dir_all(&temp_dir).unwrap();
        let started = Instant::now();

        let outcome = supervise(
            silent_for_thirty_seconds(),
            &temp_dir,
            &Arc::new(AtomicBool::new(false)),
            FAST_LIMITS,
        )
        .await;

        assert!(outcome.stalled);
        assert!(!outcome.success);
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "the stalled child was killed rather than waited out"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn a_silent_child_whose_file_keeps_growing_is_not_a_stall() {
        // The ffmpeg merge case. Nothing on the pipes, but the output file grows, so the child is
        // left alone until it exits by itself.
        let temp_dir = unique_temp_dir("supervise-growing");
        fs::create_dir_all(&temp_dir).unwrap();
        let file = temp_dir.join("youtube_ID_137.mp4");

        let script = if cfg!(windows) {
            format!(
                "for /L %i in (1,1,8) do (echo xxxxxxxx>> \"{}\" & ping -n 2 127.0.0.1 > NUL)",
                file.display()
            )
        } else {
            format!(
                "for i in 1 2 3 4 5 6 7 8; do echo xxxxxxxx >> '{}'; sleep 0.4; done",
                file.display()
            )
        };

        let limits = SupervisionLimits {
            stall_ms: if cfg!(windows) { 1_500 } else { 600 },
            ..FAST_LIMITS
        };

        let outcome = supervise(
            shell(&script),
            &temp_dir,
            &Arc::new(AtomicBool::new(false)),
            limits,
        )
        .await;

        assert!(!outcome.stalled, "a growing output file counts as progress");
        assert!(outcome.success);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn a_cancelled_child_is_killed_and_reported_as_cancelled() {
        let temp_dir = unique_temp_dir("supervise-cancel");
        fs::create_dir_all(&temp_dir).unwrap();
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let started = Instant::now();

        let flag = Arc::clone(&cancel_flag);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            flag.store(true, Ordering::SeqCst);
        });

        let outcome = supervise(
            silent_for_thirty_seconds(),
            &temp_dir,
            &cancel_flag,
            SupervisionLimits::PRODUCTION,
        )
        .await;

        assert!(outcome.cancel_requested);
        assert!(!outcome.stalled && !outcome.timed_out && !outcome.success);
        assert!(started.elapsed() < Duration::from_secs(20));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn a_child_past_the_run_time_cap_is_killed_as_timed_out() {
        let temp_dir = unique_temp_dir("supervise-runtime");
        fs::create_dir_all(&temp_dir).unwrap();

        let limits = SupervisionLimits {
            stall_ms: 60_000,
            max_runtime_ms: 300,
            poll_millis: 50,
        };

        let outcome = supervise(
            silent_for_thirty_seconds(),
            &temp_dir,
            &Arc::new(AtomicBool::new(false)),
            limits,
        )
        .await;

        assert!(outcome.timed_out);
        assert!(!outcome.stalled);

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
