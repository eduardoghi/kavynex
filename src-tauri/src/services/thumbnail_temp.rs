use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::services::binaries::resolve_ffmpeg_binary;
use crate::services::temp_paths::thumbs_temp_dir;
use crate::utils::format::{is_allowed_media_extension, media_subdir_from_extension};
use crate::utils::hash::file_hash;
use crate::utils::path::{ensure_existing_path_inside_dir, extension_from_path};
use crate::utils::process::{
    configure_process_group_blocking, hide_console, kill_process_tree_blocking, read_process_error,
};
use crate::{AppError, AppErrorCode, AppResult};

fn validate_temporary_thumbnail_delete_path(path: &str) -> AppResult<Option<PathBuf>> {
    let target_path = PathBuf::from(path.trim());

    if !target_path.exists() {
        return Ok(None);
    }

    if !target_path.is_file() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidTempThumbnailPath,
            "temporary thumbnail path is not a file",
        ));
    }

    Ok(Some(target_path))
}

fn validate_source_media_path(path: &str) -> AppResult<PathBuf> {
    let source_path = PathBuf::from(path.trim());

    if !source_path.exists() {
        return Err(AppError::from_code(
            AppErrorCode::SourceMediaNotFound,
            "source media file does not exist",
        ));
    }

    if !source_path.is_file() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidSourceMedia,
            "source media path is not a file",
        ));
    }

    let ext = extension_from_path(&source_path);

    if !is_allowed_media_extension(&ext) {
        return Err(AppError::from_code(
            AppErrorCode::UnsupportedMediaExtension,
            format!("unsupported media extension: {ext}"),
        ));
    }

    Ok(source_path)
}

fn ensure_generated_thumbnail_exists(
    path: &Path,
    code: AppErrorCode,
    message: &str,
) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::from_code(code, message));
    }

    let metadata = fs::metadata(path).map_err(|e| {
        AppError::from_code(
            code,
            format!("{message}: failed to read generated thumbnail metadata: {e}"),
        )
    })?;

    if !metadata.is_file() || metadata.len() == 0 {
        let _ = fs::remove_file(path);

        return Err(AppError::from_code(code, message));
    }

    Ok(())
}

/// Runs a prepared ffmpeg command to completion, registering its pid in the process registry
/// for the child's lifetime so the app-exit handler (`lib.rs`) tree-kills it instead of leaving
/// an orphan. These local-media thumbnail generations run synchronously via `std::process`,
/// outside the per-download and yt-dlp registries, so they would otherwise be untracked on exit.
/// Cap on how much stdout/stderr is retained from the local ffmpeg thumbnail run. `wait_with_output`
/// would buffer its whole output unbounded; this keeps memory bounded while still draining the pipes
/// fully on separate threads, so neither pipe filling can deadlock the other. Mirrors the async twin
/// in thumbnail_download.rs.
const MAX_FFMPEG_OUTPUT_BYTES: usize = 1024 * 1024; // 1 MiB per stream

/// How long a single-frame thumbnail extraction may run before ffmpeg is treated as hung and its
/// whole process tree killed. A single frame is near-instant; this is generous headroom for a cold
/// cache or a slow disk while still bounded - unlike the previous unbounded `wait()`, which a
/// crafted or truncated container fed to ffmpeg could wedge forever, leaking a blocking-pool thread
/// and a live ffmpeg process for the rest of the session. Every other external-process call site
/// (yt-dlp download/metadata/thumbnail, the health check) already bounds its child this way.
const FFMPEG_THUMBNAIL_TIMEOUT: Duration = Duration::from_secs(60);

/// How often the bounded wait re-checks for exit: short enough to fire promptly once the deadline
/// passes, long enough not to busy-spin the blocking-pool thread. Matches binaries.rs's health check.
const FFMPEG_THUMBNAIL_POLL: Duration = Duration::from_millis(50);

/// Drains a pipe to its end, retaining at most `max_bytes`; bytes past the cap are read and
/// discarded rather than left unread.
fn read_drain_capped(mut stream: impl std::io::Read, max_bytes: usize) -> Vec<u8> {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];

    loop {
        match stream.read(&mut chunk) {
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

fn run_tracked_ffmpeg(mut command: std::process::Command) -> AppResult<std::process::Output> {
    hide_console(&mut command);
    // Put the child in its own process group so the timeout below can tree-kill it: ffmpeg does not
    // normally spawn children, but this matches the group-then-kill discipline every other call site
    // uses and covers any helper it does spawn.
    configure_process_group_blocking(&mut command);

    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            AppError::from_code(
                AppErrorCode::FfmpegExecFailed,
                format!("failed to execute ffmpeg: {e}"),
            )
        })?;

    // Tracked for the child's lifetime; the guard unregisters the pid when this function returns.
    let _tracked = crate::services::process_registry::TrackedChildGuard::register(Some(child.id()));

    // Drain stdout and stderr on separate threads so neither pipe filling can deadlock the other
    // (what `wait_with_output` does internally), each capped for memory. Draining on threads (rather
    // than on this one) frees this thread to poll for the timeout below; the reads finish on their
    // own once the child exits or is killed and its pipe ends close.
    let stdout_stream = child.stdout.take();
    let stdout_handle = std::thread::spawn(move || match stdout_stream {
        Some(stream) => read_drain_capped(stream, MAX_FFMPEG_OUTPUT_BYTES),
        None => Vec::new(),
    });

    let stderr_stream = child.stderr.take();
    let stderr_handle = std::thread::spawn(move || match stderr_stream {
        Some(stream) => read_drain_capped(stream, MAX_FFMPEG_OUTPUT_BYTES),
        None => Vec::new(),
    });

    // Bounded wait: poll `try_wait` until the child exits or the deadline passes, killing the whole
    // tree on timeout so a wedged ffmpeg cannot hang this thread forever.
    let deadline = Instant::now() + FFMPEG_THUMBNAIL_TIMEOUT;
    let timed_out = loop {
        match child.try_wait() {
            Ok(Some(_)) => break false,
            Ok(None) => {
                if Instant::now() >= deadline {
                    kill_process_tree_blocking(child.id());
                    break true;
                }
                std::thread::sleep(FFMPEG_THUMBNAIL_POLL);
            }
            Err(e) => {
                return Err(AppError::from_code(
                    AppErrorCode::FfmpegExecFailed,
                    format!("failed to wait for ffmpeg: {e}"),
                ));
            }
        }
    };

    // Reap the child (it has either exited on its own or just been killed) and collect the drained
    // output, so the timeout error can still carry ffmpeg's stderr.
    let status = child.wait().map_err(|e| {
        AppError::from_code(
            AppErrorCode::FfmpegExecFailed,
            format!("failed to execute ffmpeg: {e}"),
        )
    })?;

    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();

    if timed_out {
        return Err(AppError::from_code(
            AppErrorCode::FfmpegFailed,
            format!(
                "ffmpeg timed out after {} seconds",
                FFMPEG_THUMBNAIL_TIMEOUT.as_secs()
            ),
        ));
    }

    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

/// The scale filter both generators share: fit the thumbnail to 640px wide, never upscaling a
/// smaller source, and let the height follow the aspect ratio.
const THUMBNAIL_SCALE_FILTER: &str = "scale='min(640,iw)':-1";

/// Builds the ffmpeg argv for a video thumbnail: seek slightly past the start (a frame at exactly
/// 0 is often black or missing on some encodes) and take a single scaled frame.
///
/// Extracted as a pure function, like `yt_dlp_download::build_download_command_args`, so the argv
/// can be asserted without spawning ffmpeg. Both paths are otherwise only observable as a blank
/// thumbnail on a user's machine.
fn build_video_thumbnail_args(source_path: &Path, out_png: &Path) -> Vec<String> {
    vec![
        "-y".to_string(),
        "-ss".to_string(),
        "0.1".to_string(),
        "-i".to_string(),
        source_path.to_string_lossy().to_string(),
        "-frames:v".to_string(),
        "1".to_string(),
        "-vf".to_string(),
        THUMBNAIL_SCALE_FILTER.to_string(),
        out_png.to_string_lossy().to_string(),
    ]
}

/// Builds the ffmpeg argv for an audio file's embedded cover art. Unlike the video path there is
/// no `-ss` (there is no timeline to seek); `-map 0:v:0` selects the attached picture stream, and
/// ffmpeg fails when the file has none - which is what the caller reports as
/// `ThumbnailNotSupportedForAudio`.
fn build_audio_thumbnail_args(source_path: &Path, out_png: &Path) -> Vec<String> {
    vec![
        "-y".to_string(),
        "-i".to_string(),
        source_path.to_string_lossy().to_string(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-frames:v".to_string(),
        "1".to_string(),
        "-vf".to_string(),
        THUMBNAIL_SCALE_FILTER.to_string(),
        out_png.to_string_lossy().to_string(),
    ]
}

fn generate_video_temporary_thumbnail(
    ffmpeg: &str,
    source_path: &Path,
    out_png: &Path,
) -> AppResult<()> {
    let mut command = std::process::Command::new(ffmpeg);
    command.args(build_video_thumbnail_args(source_path, out_png));

    let output = run_tracked_ffmpeg(command)?;

    if !output.status.success() {
        return Err(read_process_error(
            &output,
            AppErrorCode::FfmpegFailed,
            "ffmpeg failed to generate thumbnail",
        ));
    }

    ensure_generated_thumbnail_exists(
        out_png,
        AppErrorCode::FfmpegFailed,
        "ffmpeg did not generate a valid thumbnail",
    )
}

fn generate_audio_embedded_temporary_thumbnail(
    ffmpeg: &str,
    source_path: &Path,
    out_png: &Path,
) -> AppResult<()> {
    let mut command = std::process::Command::new(ffmpeg);
    command.args(build_audio_thumbnail_args(source_path, out_png));

    let output = run_tracked_ffmpeg(command)?;

    if !output.status.success() {
        return Err(read_process_error(
            &output,
            AppErrorCode::ThumbnailNotSupportedForAudio,
            "audio file does not have an embedded thumbnail",
        ));
    }

    ensure_generated_thumbnail_exists(
        out_png,
        AppErrorCode::ThumbnailNotSupportedForAudio,
        "audio file does not have an embedded thumbnail",
    )
}

pub fn generate_temporary_thumbnail_sync(app: &AppHandle, path: &str) -> AppResult<String> {
    let source_path = validate_source_media_path(path)?;
    let ext = extension_from_path(&source_path);
    let media_kind = media_subdir_from_extension(&ext);

    let ffmpeg = resolve_ffmpeg_binary(app)?;
    let thumbs_dir = thumbs_temp_dir(app)?;

    let hash = file_hash(&source_path)?;
    let out_png = thumbs_dir.join(format!("thumb_{hash}.png"));

    if out_png.exists() {
        return Ok(out_png.to_string_lossy().to_string());
    }

    if media_kind == "audio" {
        generate_audio_embedded_temporary_thumbnail(&ffmpeg, &source_path, &out_png)?;
    } else {
        generate_video_temporary_thumbnail(&ffmpeg, &source_path, &out_png)?;
    }

    Ok(out_png.to_string_lossy().to_string())
}

pub fn delete_temporary_thumbnail_sync(app: &AppHandle, path: &str) -> AppResult<()> {
    let Some(target_path) = validate_temporary_thumbnail_delete_path(path)? else {
        return Ok(());
    };

    let thumbs_dir = thumbs_temp_dir(app)?;
    ensure_existing_path_inside_dir(&target_path, &thumbs_dir)?;

    fs::remove_file(&target_path).map_err(|e| {
        AppError::from_code(
            AppErrorCode::RemoveTempThumbnailFailed,
            format!("failed to remove temporary thumbnail file: {e}"),
        )
    })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_temporary_thumbnail_delete_path_rejects_directory_path_before_app_access() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        let result = validate_temporary_thumbnail_delete_path(dir.to_string_lossy().as_ref());

        assert!(result.is_err());
        assert_eq!(
            result.err().unwrap().code,
            AppErrorCode::InvalidTempThumbnailPath.as_str()
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn source_path_validation_examples_are_sound() {
        let missing = PathBuf::from("__definitely_missing_video__.mp4");
        assert!(!missing.exists());

        let ext_video = extension_from_path(Path::new("video.mp4"));
        let ext_audio = extension_from_path(Path::new("audio.mp3"));

        assert_eq!(media_subdir_from_extension(&ext_video), "video");
        assert_eq!(media_subdir_from_extension(&ext_audio), "audio");
    }

    #[test]
    fn video_thumbnail_args_seek_past_the_start_and_take_one_scaled_frame() {
        let args =
            build_video_thumbnail_args(Path::new("/tmp/clip.mp4"), Path::new("/tmp/out.png"));

        assert_eq!(
            args,
            vec![
                "-y",
                "-ss",
                "0.1",
                "-i",
                "/tmp/clip.mp4",
                "-frames:v",
                "1",
                "-vf",
                THUMBNAIL_SCALE_FILTER,
                "/tmp/out.png",
            ]
        );
    }

    #[test]
    fn audio_thumbnail_args_map_the_attached_picture_and_never_seek() {
        let args =
            build_audio_thumbnail_args(Path::new("/tmp/song.mp3"), Path::new("/tmp/out.png"));

        assert_eq!(
            args,
            vec![
                "-y",
                "-i",
                "/tmp/song.mp3",
                "-map",
                "0:v:0",
                "-frames:v",
                "1",
                "-vf",
                THUMBNAIL_SCALE_FILTER,
                "/tmp/out.png",
            ]
        );

        // An audio file has no timeline to seek into, so -ss must not appear: with it, ffmpeg
        // reports no frames for a cover-art stream and a working thumbnail turns into a
        // "does not have an embedded thumbnail" error.
        assert!(!args.iter().any(|arg| arg == "-ss"));
    }

    #[test]
    fn both_arg_builders_pass_the_source_as_a_single_argument() {
        // A path with spaces (and a leading dash, which a shell would read as a flag) must stay
        // one argv entry. This holds because the args are handed to Command as an array and never
        // joined into a shell string, and it is what keeps an odd filename from becoming an
        // ffmpeg option.
        let source = Path::new("/tmp/my clips/-weird name.mp4");
        let out = Path::new("/tmp/out dir/thumb.png");

        for args in [
            build_video_thumbnail_args(source, out),
            build_audio_thumbnail_args(source, out),
        ] {
            assert!(args
                .iter()
                .any(|arg| arg == "/tmp/my clips/-weird name.mp4"));
            assert_eq!(args.last().unwrap(), "/tmp/out dir/thumb.png");
        }
    }

    #[test]
    fn ensure_generated_thumbnail_exists_accepts_a_non_empty_file() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();
        let thumb = dir.join("thumb.png");
        fs::write(&thumb, b"\x89PNG\r\n").unwrap();

        ensure_generated_thumbnail_exists(&thumb, AppErrorCode::FfmpegFailed, "boom").unwrap();
        assert!(thumb.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_generated_thumbnail_exists_rejects_a_missing_file() {
        let dir = unique_test_dir();
        let missing = dir.join("thumb.png");

        let error = ensure_generated_thumbnail_exists(&missing, AppErrorCode::FfmpegFailed, "boom")
            .unwrap_err();

        assert_eq!(error.code, AppErrorCode::FfmpegFailed.as_str());
    }

    #[test]
    fn ensure_generated_thumbnail_exists_rejects_and_removes_a_zero_byte_file() {
        // ffmpeg can exit 0 having written nothing. Without this guard the empty file would be
        // returned as a valid preview and, worse, cached: generate_temporary_thumbnail_sync
        // short-circuits on an existing out_png, so the blank result would stick for that source
        // until the temp dir is swept.
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();
        let thumb = dir.join("thumb.png");
        fs::write(&thumb, b"").unwrap();

        let error = ensure_generated_thumbnail_exists(
            &thumb,
            AppErrorCode::ThumbnailNotSupportedForAudio,
            "boom",
        )
        .unwrap_err();

        assert_eq!(
            error.code,
            AppErrorCode::ThumbnailNotSupportedForAudio.as_str()
        );
        assert!(
            !thumb.exists(),
            "the empty thumbnail must be removed, not left to be served from cache"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_generated_thumbnail_exists_rejects_a_directory() {
        let dir = unique_test_dir();
        let fake = dir.join("thumb.png");
        fs::create_dir_all(&fake).unwrap();

        let error = ensure_generated_thumbnail_exists(&fake, AppErrorCode::FfmpegFailed, "boom")
            .unwrap_err();

        assert_eq!(error.code, AppErrorCode::FfmpegFailed.as_str());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_source_media_path_rejects_disallowed_extension() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        let file = dir.join("document.txt");
        fs::write(&file, b"not a media file").unwrap();

        let result = validate_source_media_path(file.to_string_lossy().as_ref());

        assert!(result.is_err());
        assert_eq!(
            result.err().unwrap().code,
            AppErrorCode::UnsupportedMediaExtension.as_str()
        );

        let _ = fs::remove_dir_all(dir);
    }

    fn unique_test_dir() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        std::env::temp_dir().join(format!(
            "kavynex-thumbnail-temp-test-{}-{}",
            std::process::id(),
            nanos
        ))
    }
}
