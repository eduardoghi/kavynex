use std::fs;
use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::services::binaries::resolve_ffmpeg_binary;
use crate::services::temp_paths::thumbs_temp_dir;
use crate::utils::format::{is_allowed_media_extension, media_subdir_from_extension};
use crate::utils::hash::file_hash;
use crate::utils::path::{ensure_existing_path_inside_dir, extension_from_path};
use crate::utils::process::{hide_console, read_process_error};
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

fn generate_video_temporary_thumbnail(
    ffmpeg: &str,
    source_path: &Path,
    out_png: &Path,
) -> AppResult<()> {
    let mut command = std::process::Command::new(ffmpeg);
    command.args([
        "-y",
        "-ss",
        "0.1",
        "-i",
        source_path.to_string_lossy().as_ref(),
        "-frames:v",
        "1",
        "-vf",
        "scale='min(640,iw)':-1",
        out_png.to_string_lossy().as_ref(),
    ]);
    hide_console(&mut command);

    let output = command.output().map_err(|e| {
        AppError::from_code(
            AppErrorCode::FfmpegExecFailed,
            format!("failed to execute ffmpeg: {e}"),
        )
    })?;

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
    command.args([
        "-y",
        "-i",
        source_path.to_string_lossy().as_ref(),
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        "scale='min(640,iw)':-1",
        out_png.to_string_lossy().as_ref(),
    ]);
    hide_console(&mut command);

    let output = command.output().map_err(|e| {
        AppError::from_code(
            AppErrorCode::FfmpegExecFailed,
            format!("failed to execute ffmpeg: {e}"),
        )
    })?;

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
