use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::constants::THUMBNAIL_OUTPUT_FORMAT;
use crate::services::binaries::resolve_ffmpeg_binary;
use crate::services::temp_paths::thumbs_temp_dir;
use crate::utils::format::{
    allowed_media_extensions_label, allowed_thumbnail_extensions_label, is_allowed_media_extension,
    is_allowed_thumbnail_extension, media_subdir_from_extension,
};
use crate::utils::hash::file_hash;
use crate::utils::path::{ensure_existing_path_inside_dir, extension_from_path, is_network_path};
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
    let trimmed = path.trim();

    // Reject a UNC/network source before any filesystem call touches it: this command takes a
    // caller-supplied path (the pre-import preview needs to reach a file the user picked anywhere on
    // disk), so a compromised frontend could otherwise hand it `\\host\share\...` and make merely
    // stat-ing it trigger an SMB/NTLM handshake that leaks the user's hash to `host`. Mirrors the
    // same guard in services::library::resolve_path_inside_library / open_path_in_system.
    if is_network_path(trimmed) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidSourceMedia,
            "source media path must not be a network location",
        ));
    }

    let source_path = PathBuf::from(trimmed);

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
        // Same shape as the import gate in library/media.rs: the accepted list goes in `details`,
        // which is what the frontend appends after the catalogued message.
        return Err(AppError::from_code_with_details(
            AppErrorCode::UnsupportedMediaExtension,
            format!("unsupported media extension: {ext}"),
            format!("accepted: {}", allowed_media_extensions_label()),
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
/// in thumbnail/download.rs.
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

/// The name a generated preview lands under, content-addressed by the source file's hash and
/// carrying the container both thumbnail producers share ([`THUMBNAIL_OUTPUT_FORMAT`]).
///
/// Pure, and separate from the generator, so the format can be asserted without an `AppHandle` or
/// an ffmpeg on the machine. That matters more than it looks: this path wrote lossless PNG for a
/// while after the download path had moved to JPEG, and nothing failed - the divergence was only
/// visible as a library holding both formats for the same kind of content. The extension is also
/// what ffmpeg picks its encoder from, so the name and the bytes written cannot disagree.
fn temporary_thumbnail_file_name(source_hash: &str) -> String {
    format!("thumb_{source_hash}.{THUMBNAIL_OUTPUT_FORMAT}")
}

/// Builds the ffmpeg argv for a video thumbnail: seek slightly past the start (a frame at exactly
/// 0 is often black or missing on some encodes) and take a single scaled frame.
///
/// Extracted as a pure function, like `yt_dlp::download::build_download_command_args`, so the argv
/// can be asserted without spawning ffmpeg. Both paths are otherwise only observable as a blank
/// thumbnail on a user's machine.
fn build_video_thumbnail_args(source_path: &Path, out_thumbnail: &Path) -> Vec<String> {
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
        out_thumbnail.to_string_lossy().to_string(),
    ]
}

/// Builds the ffmpeg argv for an audio file's embedded cover art. Unlike the video path there is
/// no `-ss` (there is no timeline to seek); `-map 0:v:0` selects the attached picture stream, and
/// ffmpeg fails when the file has none - which is what the caller reports as
/// `ThumbnailNotSupportedForAudio`.
fn build_audio_thumbnail_args(source_path: &Path, out_thumbnail: &Path) -> Vec<String> {
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
        out_thumbnail.to_string_lossy().to_string(),
    ]
}

fn generate_video_temporary_thumbnail(
    ffmpeg: &str,
    source_path: &Path,
    out_thumbnail: &Path,
) -> AppResult<()> {
    let mut command = std::process::Command::new(ffmpeg);
    command.args(build_video_thumbnail_args(source_path, out_thumbnail));

    let output = run_tracked_ffmpeg(command)?;

    if !output.status.success() {
        return Err(read_process_error(
            &output,
            AppErrorCode::FfmpegFailed,
            "ffmpeg failed to generate thumbnail",
        ));
    }

    ensure_generated_thumbnail_exists(
        out_thumbnail,
        AppErrorCode::FfmpegFailed,
        "ffmpeg did not generate a valid thumbnail",
    )
}

fn generate_audio_embedded_temporary_thumbnail(
    ffmpeg: &str,
    source_path: &Path,
    out_thumbnail: &Path,
) -> AppResult<()> {
    let mut command = std::process::Command::new(ffmpeg);
    command.args(build_audio_thumbnail_args(source_path, out_thumbnail));

    let output = run_tracked_ffmpeg(command)?;

    if !output.status.success() {
        return Err(read_process_error(
            &output,
            AppErrorCode::ThumbnailNotSupportedForAudio,
            "audio file does not have an embedded thumbnail",
        ));
    }

    ensure_generated_thumbnail_exists(
        out_thumbnail,
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
    let out_thumbnail = thumbs_dir.join(temporary_thumbnail_file_name(&hash));

    if out_thumbnail.exists() {
        return Ok(out_thumbnail.to_string_lossy().to_string());
    }

    if media_kind == "audio" {
        generate_audio_embedded_temporary_thumbnail(&ffmpeg, &source_path, &out_thumbnail)?;
    } else {
        generate_video_temporary_thumbnail(&ffmpeg, &source_path, &out_thumbnail)?;
    }

    Ok(out_thumbnail.to_string_lossy().to_string())
}

/// Validates an image the user picked from the file dialog, before anything stats or reads it.
///
/// The network refusal comes first and is the reason this is a separate validator rather than a
/// reuse of [`validate_source_media_path`]: this path arrives raw over IPC, and on Windows merely
/// `is_file()`-ing `\\host\share\x.png` authenticates to `host` over SMB and hands it the user's
/// NTLM hash. Every sibling that takes a caller-supplied path already refuses one
/// (`library::resolve_path_inside_library`, `validate_source_media_path`, `db_backup`'s import and
/// export gates, `yt_dlp::cookies::normalize_cookies_path`); the preview path this replaced was the
/// last one that did not.
///
/// The extension gate is the same one the preview needs anyway: only an image is worth staging, and
/// refusing anything else here means the copy below can never be pointed at an arbitrary file.
fn validate_picked_thumbnail_path(path: &str) -> AppResult<PathBuf> {
    let trimmed = path.trim();

    if trimmed.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidThumbnailPath,
            "thumbnail path is empty",
        ));
    }

    if is_network_path(trimmed) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidThumbnailPath,
            "thumbnail path must not be a network location",
        ));
    }

    let source_path = PathBuf::from(trimmed);

    if !source_path.is_file() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidThumbnailFile,
            "thumbnail path is not an existing file",
        ));
    }

    if !is_allowed_thumbnail_extension(&extension_from_path(&source_path)) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidThumbnailFile,
            format!(
                "only image files can be used as a thumbnail ({})",
                allowed_thumbnail_extensions_label()
            ),
        ));
    }

    Ok(source_path)
}

/// The name a picked image lands under in the preview directory.
///
/// A distinct prefix from [`temporary_thumbnail_file_name`] so the two producers sharing this
/// directory can never name the same file, and the source's own extension rather than
/// [`THUMBNAIL_OUTPUT_FORMAT`] because the staged copy is byte-identical to what the user picked -
/// naming a PNG `.jpg` would make the extension disagree with the bytes, and the persist step
/// downstream derives the stored name from this one.
///
/// Content-addressed like everything else here, which is what makes picking the same image twice
/// free: the second stage finds the file already there.
fn staged_thumbnail_file_name(source_hash: &str, extension: &str) -> String {
    format!("picked_{source_hash}.{extension}")
}

/// Copies an image the user picked into the preview directory and returns its path there.
///
/// This exists so the manual-thumbnail flow does not need the asset scope widened to the file the
/// user chose. The preview directory is already authorized wholesale
/// (`commands::security::register_cache_asset_scope`), so a staged copy is renderable through
/// `convertFileSrc` with no per-file grant at all - which matters because Tauri's asset scope has no
/// way to withdraw a grant, so per-file grants accumulated for the lifetime of the session and the
/// obvious cleanup (forbid the file when the preview is discarded) is worse than the disease: a
/// forbid outranks every later allow, so picking the same image for a second media would silently
/// render nothing.
///
/// The copy is byte-identical, so the content hash the persist step computes is unchanged and the
/// file that eventually lands in the library is exactly what it was before. Staging also gives the
/// picked image the same lifecycle every generated preview already has: it is swept by age, and the
/// frontend deletes it through the existing `delete_temporary_thumbnail`.
pub fn stage_manual_thumbnail_sync(app: &AppHandle, path: &str) -> AppResult<String> {
    let source_path = validate_picked_thumbnail_path(path)?;
    let extension = extension_from_path(&source_path);

    let thumbs_dir = thumbs_temp_dir(app)?;
    let hash = file_hash(&source_path)?;
    let staged = thumbs_dir.join(staged_thumbnail_file_name(&hash, &extension));

    // Already staged: the same image picked again, in this session or a previous one whose sweep has
    // not run yet. Content-addressed, so the existing file is the same bytes by construction.
    if staged.is_file() {
        return Ok(staged.to_string_lossy().to_string());
    }

    crate::services::filesystem::copy_file_atomic(&source_path, &staged)?;

    Ok(staged.to_string_lossy().to_string())
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

    // These moved here with the flow they gate: the manual-thumbnail preview used to widen the
    // asset scope to the picked file (`commands::security::allow_asset_file`), and the checks lived
    // beside that command. Staging a copy replaced it, so the gate belongs to this module now.

    #[test]
    fn validate_picked_thumbnail_rejects_a_network_location() {
        // The check the previous gate did not have, and the reason it matters more here than
        // anywhere else: this path arrives raw over IPC, and on Windows `is_file()` alone on a UNC
        // share authenticates to that host over SMB and leaks the user's NTLM hash. Every spelling
        // Windows resolves to a share is covered, and each carries a valid image extension so only
        // the network check can be what rejects it.
        for value in [
            r"\\evil\share\cover.png",
            "//evil/share/cover.png",
            r"/\evil\share\cover.png",
            r"\/evil\share\cover.png",
            r"\\?\UNC\evil\share\cover.png",
        ] {
            let error = validate_picked_thumbnail_path(value)
                .expect_err(&format!("{value} should be rejected as a network path"));
            assert_eq!(error.code, AppErrorCode::InvalidThumbnailPath.as_str());
        }
    }

    #[test]
    fn validate_picked_thumbnail_rejects_an_empty_path() {
        let error = validate_picked_thumbnail_path("   ").unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidThumbnailPath.as_str());
    }

    #[test]
    fn validate_picked_thumbnail_rejects_a_missing_file() {
        let missing = unique_test_dir().join("nope.png");
        let error = validate_picked_thumbnail_path(&missing.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidThumbnailFile.as_str());
    }

    #[test]
    fn validate_picked_thumbnail_rejects_an_existing_non_image_file() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("notes.txt");
        fs::write(&file, b"x").unwrap();

        let error = validate_picked_thumbnail_path(&file.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidThumbnailFile.as_str());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_picked_thumbnail_rejects_a_directory_with_an_image_name() {
        // A directory named like an image must not be staged - only regular files are.
        let dir = unique_test_dir();
        let fake = dir.join("thumb.png");
        fs::create_dir_all(&fake).unwrap();

        let error = validate_picked_thumbnail_path(&fake.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidThumbnailFile.as_str());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_picked_thumbnail_accepts_an_existing_image() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        for name in ["thumb.png", "photo.JPG", "art.webp"] {
            let file = dir.join(name);
            fs::write(&file, b"\x89PNG\r\n").unwrap();
            validate_picked_thumbnail_path(&file.to_string_lossy())
                .unwrap_or_else(|error| panic!("{name} should be accepted: {error}"));
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_staged_name_keeps_the_source_extension_and_cannot_collide_with_a_generated_preview() {
        // Two producers share the preview directory. The prefixes have to differ, or a generated
        // preview and a picked image could name the same file - and the extension has to be the
        // source's, because the staged copy is byte-identical and the persist step downstream names
        // the stored file from this one.
        let hash = "a".repeat(64);

        assert_eq!(
            staged_thumbnail_file_name(&hash, "png"),
            format!("picked_{hash}.png")
        );
        assert_ne!(
            staged_thumbnail_file_name(&hash, THUMBNAIL_OUTPUT_FORMAT),
            temporary_thumbnail_file_name(&hash)
        );
    }

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
    fn both_thumbnail_producers_name_their_output_with_the_shared_format() {
        // The two producers each choose an output container, and they diverged once: the yt-dlp
        // download moved to JPEG while this path kept writing lossless PNG, so a library fed from
        // both sources held both formats for the same kind of content and the size win applied to
        // half the paths. Reading the shared constant is what makes it one decision; asserting the
        // filename actually follows it is what stops a hardcoded extension creeping back, which is
        // exactly how the divergence happened the first time.
        //
        // ffmpeg picks its encoder from the output extension, so this is also what keeps the argv
        // built above writing the format the name claims.
        let ffmpeg_output = temporary_thumbnail_file_name("abc123");

        assert!(
            ffmpeg_output.ends_with(&format!(".{THUMBNAIL_OUTPUT_FORMAT}")),
            "the local-import thumbnail should use the shared format, got: {ffmpeg_output}"
        );
    }

    #[test]
    fn video_thumbnail_args_seek_past_the_start_and_take_one_scaled_frame() {
        let args =
            build_video_thumbnail_args(Path::new("/tmp/clip.mp4"), Path::new("/tmp/out.jpg"));

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
                "/tmp/out.jpg",
            ]
        );
    }

    #[test]
    fn audio_thumbnail_args_map_the_attached_picture_and_never_seek() {
        let args =
            build_audio_thumbnail_args(Path::new("/tmp/song.mp3"), Path::new("/tmp/out.jpg"));

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
                "/tmp/out.jpg",
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
        // short-circuits on an existing out_thumbnail, so the blank result would stick for that source
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
        std::env::temp_dir().join(format!(
            "kavynex-thumbnail-temp-test-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }
}
