//! Running the yt-dlp thumbnail/avatar command: its argument vector, its concurrency bound, and
//! the spawn/wait/kill machinery around it.
//!
//! Split out of the orchestration in `super` because it shares nothing with the HTTP fetch next to
//! it beyond both ending in an image on disk: this half owns a process tree (yt-dlp plus the
//! ffmpeg child `--convert-thumbnails` spawns), and the other owns a socket.

use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::time::timeout;

use crate::constants::THUMBNAIL_OUTPUT_FORMAT;
use crate::services::yt_dlp::cookies::append_auth_args;
use crate::utils::bounded_semaphore::BoundedSemaphore;
use crate::utils::process::hide_console_async;
use crate::{AppError, AppErrorCode, AppResult};

/// Cap on how much stdout/stderr is retained from a yt-dlp thumbnail/avatar run. These commands
/// are far less chatty than a full download, but `wait_with_output` would buffer their entire
/// output unbounded; this keeps memory (and the error detail built from it) bounded while still
/// draining the pipes fully so the child can exit. A cap that stopped reading would deadlock a
/// child that outran it.
const MAX_PROCESS_OUTPUT_BYTES: usize = 1024 * 1024; // 1 MiB per stream

/// Bounds how many thumbnail/avatar yt-dlp runs execute at once. Each spawns a yt-dlp + ffmpeg
/// process tree (`--convert-thumbnails`, see [`THUMBNAIL_OUTPUT_FORMAT`]), so a burst (a bulk
/// import, a retry loop, or a compromised frontend firing the thumbnail/avatar commands) could
/// otherwise spawn an unbounded number of process trees and exhaust CPU/handles. The download flow
/// (`DOWNLOAD_SEMAPHORE`) and the
/// metadata/comment/format runs (`STANDALONE_RUN_SEMAPHORE`) each have their own bound; this is the
/// third yt-dlp spawn site and gets its own.
const MAX_CONCURRENT_THUMBNAIL_RUNS: usize = 4;
// Ceiling on how many thumbnail/avatar runs may be in flight (running or queued) at once. The
// concurrency cap bounds only how many spawn together; this bounds the queue behind it so a burst (// a bulk import or a compromised frontend firing the commands in a loop) is refused up front rather
// than enqueued without limit (see BoundedSemaphore). Set well above a realistic bulk import.
const MAX_THUMBNAIL_RUNS_IN_FLIGHT: usize = 32;
static THUMBNAIL_RUN_SEMAPHORE: BoundedSemaphore =
    BoundedSemaphore::new(MAX_CONCURRENT_THUMBNAIL_RUNS, MAX_THUMBNAIL_RUNS_IN_FLIGHT);

/// Drains an async pipe to its end, retaining at most `max_bytes`. Bytes past the cap are read and
/// discarded rather than left unread, so the child never blocks on a full pipe.
async fn read_drain_capped_async(
    stream: Option<impl AsyncRead + Unpin>,
    max_bytes: usize,
) -> Vec<u8> {
    let mut buffer: Vec<u8> = Vec::new();

    let Some(mut stream) = stream else {
        return buffer;
    };

    let mut chunk = [0u8; 8192];

    loop {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if buffer.len() < max_bytes {
                    let take = (max_bytes - buffer.len()).min(read);
                    buffer.extend_from_slice(&chunk[..take]);
                }
            }
        }
    }

    buffer
}

/// `Child::wait_with_output` with each stream capped at `MAX_PROCESS_OUTPUT_BYTES`. Reads both
/// pipes concurrently with the wait so neither can deadlock the other (mirroring std's own
/// implementation), but bounded.
async fn wait_with_capped_output(
    mut child: tokio::process::Child,
) -> std::io::Result<std::process::Output> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let (status, stdout_buf, stderr_buf) = tokio::join!(
        child.wait(),
        read_drain_capped_async(stdout, MAX_PROCESS_OUTPUT_BYTES),
        read_drain_capped_async(stderr, MAX_PROCESS_OUTPUT_BYTES),
    );

    Ok(std::process::Output {
        status: status?,
        stdout: stdout_buf,
        stderr: stderr_buf,
    })
}

/// Runs a yt-dlp thumbnail/avatar command under the shared timeout, capturing its output.
///
/// These invocations pass `--convert-thumbnails` (see [`THUMBNAIL_OUTPUT_FORMAT`]), which makes
/// yt-dlp spawn an `ffmpeg`
/// child. Relying on `kill_on_drop` alone (as the previous `.output()` call did) only kills
/// the direct yt-dlp child on timeout, leaving that ffmpeg grandchild running and holding the
/// temp directory open. Spawning into its own process group and killing the whole tree on
/// timeout (the same mechanism the main download path uses), prevents the orphan.
pub(super) async fn run_thumbnail_yt_dlp_with_timeout(
    mut command: Command,
    timeout_message: &str,
    exec_message: &str,
    cancel: Option<Arc<AtomicBool>>,
) -> AppResult<std::process::Output> {
    // Bound concurrent thumbnail/avatar runs (see THUMBNAIL_RUN_SEMAPHORE). Held for the whole
    // function (spawn through wait), so a burst queues here rather than each spawning a yt-dlp +
    // ffmpeg tree at once, and a queue deeper than the in-flight ceiling is refused up front.
    let _permit = THUMBNAIL_RUN_SEMAPHORE
        .acquire(AppErrorCode::TooManyConcurrentYtDlpRuns)
        .await?;

    // Any early return still reaps the direct child; the tree kill below covers the ffmpeg
    // grandchild that `kill_on_drop` does not reach.
    command.kill_on_drop(true);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_console_async(&mut command);
    crate::utils::process::configure_process_group(&mut command);

    let child = command.spawn().map_err(|e| {
        AppError::from_code(
            AppErrorCode::YtDlpThumbnailExecFailed,
            format!("{exec_message}: {e}"),
        )
    })?;
    let child_pid = child.id();
    // Track this yt-dlp thumbnail/avatar child (and its ffmpeg grandchild via the tree kill)
    // globally so the app-exit handler terminates it too; these run outside the per-download
    // registry (the standalone thumbnail/avatar paths) or before its child pid is recorded
    // (the pre-download media thumbnail). Unregisters when this function returns.
    let _tracked_child = crate::services::process_registry::TrackedChildGuard::register(child_pid);

    tokio::select! {
        output_result = timeout(
            Duration::from_secs(THUMBNAIL_COMMAND_TIMEOUT_SECS),
            wait_with_capped_output(child),
        ) => match output_result {
            Ok(result) => result.map_err(|e| {
                AppError::from_code(
                    AppErrorCode::YtDlpThumbnailExecFailed,
                    format!("{exec_message}: {e}"),
                )
            }),
            Err(_) => {
                if let Some(pid) = child_pid {
                    crate::utils::process::kill_process_tree(pid).await;
                }

                Err(AppError::from_code(
                    AppErrorCode::YtDlpThumbnailTimeout,
                    timeout_message.to_string(),
                ))
            }
        },
        _ = crate::utils::process::wait_for_cancel(cancel.as_deref()) => {
            // The download was cancelled while this bounded thumbnail phase was still running:
            // kill the whole tree now rather than blocking cancellation until the timeout. Only
            // reached for the media-thumbnail path (which passes the run's cancel flag); the
            // standalone and avatar paths pass None, so this branch pends forever.
            if let Some(pid) = child_pid {
                crate::utils::process::kill_process_tree(pid).await;
            }

            Err(AppError::from_code(
                AppErrorCode::YtDlpDownloadCancelled,
                "yt-dlp download cancelled",
            ))
        }
    }
}

pub(super) const THUMBNAIL_COMMAND_TIMEOUT_SECS: u64 = 60;

/// What a thumbnail fetch is pointed at, which decides how yt-dlp treats playlists.
#[derive(Clone, Copy)]
pub(super) enum ThumbnailTarget {
    /// A single video or direct media URL: `--no-playlist`, so only that entry is considered.
    SingleMedia,
    /// A channel URL: `--playlist-items 0`, so no video is enumerated and only the
    /// channel-level thumbnail (the avatar) is written.
    ChannelAvatar,
}

// `THUMBNAIL_OUTPUT_FORMAT` (imported at the top of this file) is what `--convert-thumbnails`
// normalizes every downloaded thumbnail to, and therefore the extension the file lands under in
// the temp directory. See `finalize_thumbnail_download` below, which looks the written file up by
// it. It lives in `constants.rs` because the local-import producer (`thumbnail/temp.rs`) writes
// the same kind of file and has to agree; `constants.rs` is where the choice is explained.
//
// Note what the format choice does *not* fix: the decoded size of the image in the grid is
// `width * height * 4` bytes regardless of how the file is compressed, so it reduces disk and I/O,
// never the webview's bitmap memory.

/// Builds the yt-dlp argument vector for writing a thumbnail (converted to
/// [`THUMBNAIL_OUTPUT_FORMAT`]) into `temp_dir` under `file_prefix`.
///
/// Extracted as a pure function so the three thumbnail flows (direct-URL fallback,
/// pre-download media thumbnail, channel avatar) share one definition instead of three
/// near-identical inline vectors, and so the argv can be asserted in tests without spawning a
/// process. The URL is always last and always immediately preceded by `--`, so it can never be
/// reinterpreted as a flag.
pub(super) fn build_thumbnail_command_args(
    ffmpeg_location: &str,
    temp_dir: &Path,
    file_prefix: &str,
    url: &str,
    target: ThumbnailTarget,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
) -> Vec<String> {
    let mut args = vec!["--ignore-config".to_string()];

    match target {
        ThumbnailTarget::SingleMedia => args.push("--no-playlist".to_string()),
        ThumbnailTarget::ChannelAvatar => {
            args.push("--playlist-items".to_string());
            args.push("0".to_string());
        }
    }

    args.extend([
        "--skip-download".to_string(),
        "--write-thumbnail".to_string(),
        "--convert-thumbnails".to_string(),
        THUMBNAIL_OUTPUT_FORMAT.to_string(),
        "--restrict-filenames".to_string(),
        "--windows-filenames".to_string(),
        "--no-warnings".to_string(),
        "--ffmpeg-location".to_string(),
        ffmpeg_location.to_string(),
        "--paths".to_string(),
        format!("home:{}", temp_dir.to_string_lossy()),
        "-o".to_string(),
        format!("{}.%(ext)s", file_prefix),
    ]);

    append_auth_args(&mut args, cookies_browser, cookies_path);
    args.push("--".to_string());
    args.push(url.to_string());

    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn sample_temp_dir() -> PathBuf {
        PathBuf::from(if cfg!(windows) {
            "C:\\tmp\\thumb"
        } else {
            "/tmp/thumb"
        })
    }

    #[test]
    fn build_thumbnail_command_args_single_media_uses_no_playlist_and_no_cookies() {
        let temp = sample_temp_dir();

        let args = build_thumbnail_command_args(
            "/opt/ffmpeg",
            &temp,
            "thumb_youtube_abc",
            "https://www.youtube.com/watch?v=abc",
            ThumbnailTarget::SingleMedia,
            None,
            None,
        );

        // Single media constrains yt-dlp to the one entry and never enumerates a playlist.
        assert!(args.iter().any(|arg| arg == "--no-playlist"));
        assert!(!args.iter().any(|arg| arg == "--playlist-items"));

        // The shared skeleton is present: skip download, write and convert the thumbnail,
        // pin ffmpeg, sandbox writes to the temp dir, and template the output name.
        assert!(args.iter().any(|arg| arg == "--skip-download"));
        assert!(args.iter().any(|arg| arg == "--write-thumbnail"));
        let convert = args
            .iter()
            .position(|arg| arg == "--convert-thumbnails")
            .unwrap();
        assert_eq!(args[convert + 1], THUMBNAIL_OUTPUT_FORMAT);
        let ffmpeg = args
            .iter()
            .position(|arg| arg == "--ffmpeg-location")
            .unwrap();
        assert_eq!(args[ffmpeg + 1], "/opt/ffmpeg");
        assert!(args.iter().any(|arg| arg == "thumb_youtube_abc.%(ext)s"));
        assert!(args
            .iter()
            .any(|arg| arg == &format!("home:{}", temp.to_string_lossy())));

        // No auth flags are added without cookies.
        assert!(!args.iter().any(|arg| arg == "--cookies"));
        assert!(!args.iter().any(|arg| arg == "--cookies-from-browser"));

        // The URL is last and immediately preceded by `--`.
        assert_eq!(args.last().unwrap(), "https://www.youtube.com/watch?v=abc");
        assert_eq!(args[args.len() - 2], "--");
    }

    #[test]
    fn build_thumbnail_command_args_channel_avatar_uses_playlist_items_zero() {
        let temp = sample_temp_dir();

        let args = build_thumbnail_command_args(
            "ffmpeg",
            &temp,
            "channel_avatar",
            "https://www.youtube.com/@handle",
            ThumbnailTarget::ChannelAvatar,
            None,
            None,
        );

        // A channel page enumerates zero videos, so only the avatar thumbnail is written.
        let items = args
            .iter()
            .position(|arg| arg == "--playlist-items")
            .unwrap();
        assert_eq!(args[items + 1], "0");
        assert!(!args.iter().any(|arg| arg == "--no-playlist"));

        assert_eq!(args.last().unwrap(), "https://www.youtube.com/@handle");
        assert_eq!(args[args.len() - 2], "--");
    }

    #[test]
    fn build_thumbnail_command_args_passes_browser_cookies_through() {
        let temp = sample_temp_dir();

        let args = build_thumbnail_command_args(
            "ffmpeg",
            &temp,
            "thumb_youtube_abc",
            "https://youtu.be/abc",
            ThumbnailTarget::SingleMedia,
            Some("firefox"),
            None,
        );

        let cookies = args
            .iter()
            .position(|arg| arg == "--cookies-from-browser")
            .unwrap();
        assert_eq!(args[cookies + 1], "firefox");

        // The `--` + URL invariant still holds with the cookie flags present.
        assert_eq!(args.last().unwrap(), "https://youtu.be/abc");
        assert_eq!(args[args.len() - 2], "--");
    }
}
