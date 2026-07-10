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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        std::env::temp_dir().join(format!(
            "kavynex-library-media-test-{}-{}-{}",
            prefix,
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn import_media_file_sync_rejects_unsupported_extension() {
        let root = unique_test_dir("unsupported-ext");
        let source_dir = root.join("source");
        let library_dir = root.join("library");
        fs::create_dir_all(&source_dir).unwrap();

        let source = source_dir.join("notes.txt");
        fs::write(&source, b"not media").unwrap();

        let result = import_media_file_sync(
            source.to_string_lossy().as_ref(),
            ImportMode::Copy,
            library_dir.to_string_lossy().as_ref(),
        );

        let error = result.unwrap_err();
        assert_eq!(error.code, AppErrorCode::UnsupportedMediaExtension.as_str());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_media_file_sync_copy_mode_preserves_source_file() {
        let root = unique_test_dir("copy-preserves");
        let source_dir = root.join("source");
        let library_dir = root.join("library");
        fs::create_dir_all(&source_dir).unwrap();

        let source = source_dir.join("video.mp4");
        fs::write(&source, b"video-bytes").unwrap();

        let relative = import_media_file_sync(
            source.to_string_lossy().as_ref(),
            ImportMode::Copy,
            library_dir.to_string_lossy().as_ref(),
        )
        .unwrap();

        assert!(source.exists(), "copy mode must keep the source file");
        assert!(library_dir
            .join(relative.replace('/', std::path::MAIN_SEPARATOR_STR))
            .exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_media_file_sync_move_mode_removes_source_file() {
        let root = unique_test_dir("move-removes");
        let source_dir = root.join("source");
        let library_dir = root.join("library");
        fs::create_dir_all(&source_dir).unwrap();

        let source = source_dir.join("video.mp4");
        fs::write(&source, b"video-bytes").unwrap();

        let relative = import_media_file_sync(
            source.to_string_lossy().as_ref(),
            ImportMode::Move,
            library_dir.to_string_lossy().as_ref(),
        )
        .unwrap();

        assert!(!source.exists(), "move mode must remove the source file");
        assert!(library_dir
            .join(relative.replace('/', std::path::MAIN_SEPARATOR_STR))
            .exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_media_file_sync_is_a_noop_when_destination_already_exists() {
        let root = unique_test_dir("noop-existing");
        let source_dir = root.join("source");
        let library_dir = root.join("library");
        fs::create_dir_all(&source_dir).unwrap();

        let source = source_dir.join("video.mp4");
        fs::write(&source, b"identical-content").unwrap();

        // Copy mode keeps the source in place, so importing the same content twice must
        // resolve to the same content-addressed destination without erroring or duplicating.
        let first = import_media_file_sync(
            source.to_string_lossy().as_ref(),
            ImportMode::Copy,
            library_dir.to_string_lossy().as_ref(),
        )
        .unwrap();

        let second = import_media_file_sync(
            source.to_string_lossy().as_ref(),
            ImportMode::Copy,
            library_dir.to_string_lossy().as_ref(),
        )
        .unwrap();

        assert_eq!(first, second);

        let video_dir = library_dir.join("video");
        let entries: Vec<_> = fs::read_dir(&video_dir).unwrap().flatten().collect();
        assert_eq!(
            entries.len(),
            1,
            "the destination file must not be duplicated"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn delete_media_file_sync_returns_ok_for_missing_file() {
        let root = unique_test_dir("delete-missing");
        let library_dir = root.join("library");
        fs::create_dir_all(library_dir.join("video")).unwrap();

        let result =
            delete_media_file_sync("video/missing.mp4", library_dir.to_string_lossy().as_ref());

        assert!(result.is_ok());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn delete_media_file_sync_rejects_path_outside_library() {
        let root = unique_test_dir("delete-outside");
        let library_dir = root.join("library");
        fs::create_dir_all(&library_dir).unwrap();

        let result =
            delete_media_file_sync("../outside.mp4", library_dir.to_string_lossy().as_ref());

        let error = result.unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidRelativePath.as_str());

        let _ = fs::remove_dir_all(root);
    }
}
