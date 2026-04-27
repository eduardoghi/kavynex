use std::fs;
use std::path::PathBuf;

use crate::models::yt_dlp::ImportMode;
use crate::services::filesystem::{copy_file_atomic, move_or_copy_file};
use crate::services::library_paths::{ensure_library_dir, resolve_existing_library_dir};
use crate::services::logger;
use crate::utils::format::{is_allowed_media_extension, media_subdir_from_extension};
use crate::utils::hash::file_hash;
use crate::utils::path::{
    absolute_path_from_relative, ensure_existing_path_inside_dir, ensure_path_parent_inside_dir,
    extension_from_path, relative_path_from_base,
};
use crate::{AppError, AppErrorCode, AppResult};

pub fn import_media_file_sync(
    path: &str,
    mode: ImportMode,
    library_path: &str,
) -> AppResult<String> {
    let source = PathBuf::from(path.trim());

    if !source.exists() {
        return Err(AppError::from_code(
            AppErrorCode::SourceMediaNotFound,
            "source media file does not exist",
        ));
    }

    if !source.is_file() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidSourceMedia,
            "source media path is not a file",
        ));
    }

    let ext = extension_from_path(&source);

    if !is_allowed_media_extension(&ext) {
        return Err(AppError::from_code(
            AppErrorCode::UnsupportedMediaExtension,
            format!("unsupported media file extension: {ext}"),
        ));
    }

    let library_dir = ensure_library_dir(library_path)?;
    let media_subdir = media_subdir_from_extension(&ext);
    let media_dir = library_dir.join(media_subdir);

    fs::create_dir_all(&media_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateMediaDirFailed,
            format!("failed to create media directory: {e}"),
        )
    })?;

    let hash = file_hash(&source)?;
    let destination = media_dir.join(format!("media_{hash}.{ext}"));

    ensure_path_parent_inside_dir(&destination, &library_dir)?;

    logger::info(
        "library",
        format!(
            "importing media: source='{}', mode='{:?}', destination='{}'",
            source.to_string_lossy(),
            mode,
            destination.to_string_lossy()
        ),
    );

    if !destination.exists() {
        match mode {
            ImportMode::Copy => {
                copy_file_atomic(&source, &destination)?;
            }
            ImportMode::Move => {
                move_or_copy_file(&source, &destination)?;
            }
        }
    } else {
        logger::info(
            "library",
            format!(
                "media import skipped because destination already exists: '{}'",
                destination.to_string_lossy()
            ),
        );
    }

    let relative_path = relative_path_from_base(&library_dir, &destination)?;

    logger::info(
        "library",
        format!("media import finished: '{}'", relative_path),
    );

    Ok(relative_path)
}

pub fn delete_media_file_sync(file_path: &str, library_path: &str) -> AppResult<()> {
    let library_dir = resolve_existing_library_dir(library_path)?;
    let target_path = absolute_path_from_relative(&library_dir, file_path)?;

    if !target_path.exists() {
        logger::warn(
            "library",
            format!(
                "media delete skipped because file does not exist: '{}'",
                target_path.to_string_lossy()
            ),
        );
        return Ok(());
    }

    if !target_path.is_file() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidMediaPath,
            "media path is not a file",
        ));
    }

    ensure_existing_path_inside_dir(&target_path, &library_dir)?;

    logger::info(
        "library",
        format!("deleting media file '{}'", target_path.to_string_lossy()),
    );

    fs::remove_file(&target_path).map_err(|e| {
        AppError::from_code(
            AppErrorCode::RemoveMediaFailed,
            format!("failed to remove media file: {e}"),
        )
    })?;

    logger::info(
        "library",
        format!("media file deleted '{}'", target_path.to_string_lossy()),
    );

    Ok(())
}
