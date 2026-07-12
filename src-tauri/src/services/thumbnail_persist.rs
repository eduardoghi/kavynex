use std::fs;
use std::path::{Path, PathBuf};

use crate::constants::LIBRARY_DIR_THUMBNAILS;
use crate::services::filesystem::copy_file_atomic;
use crate::services::library_paths::{ensure_library_dir, resolve_existing_library_dir};
use crate::utils::format::is_allowed_thumbnail_extension;
use crate::utils::hash::file_hash;
use crate::utils::path::{
    absolute_path_from_relative, ensure_existing_path_inside_dir, ensure_path_parent_inside_dir,
    extension_from_path, relative_path_from_base,
};
use crate::{AppError, AppErrorCode, AppResult};

pub fn persist_thumbnail_from_source(source: &Path, library_dir: &Path) -> AppResult<String> {
    // Serialize this library write against a concurrent migration (see library_lock). Covers
    // both the manual-thumbnail persist and the downloaded-thumbnail/avatar persist, which are
    // this function's only callers.
    let _library_guard = crate::services::library_lock::library_read_guard();

    if !source.exists() {
        return Err(AppError::from_code(
            AppErrorCode::SourceThumbnailNotFound,
            "source thumbnail file does not exist",
        ));
    }

    if !source.is_file() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidSourceThumbnail,
            "source thumbnail path is not a file",
        ));
    }

    fs::create_dir_all(library_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateLibraryDirFailed,
            format!("failed to create library directory: {e}"),
        )
    })?;

    let ext = extension_from_path(source);

    if !is_allowed_thumbnail_extension(&ext) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidThumbnailFile,
            "invalid thumbnail file type. Allowed: png, jpg, jpeg, webp, bmp, avif",
        ));
    }

    let thumbs_dir = library_dir.join(LIBRARY_DIR_THUMBNAILS);
    fs::create_dir_all(&thumbs_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateThumbnailsDirFailed,
            format!("failed to create thumbnails directory: {e}"),
        )
    })?;

    let hash = file_hash(source)?;
    let destination = thumbs_dir.join(format!("thumb_{hash}.{ext}"));

    ensure_path_parent_inside_dir(&destination, library_dir)?;

    if !destination.exists() {
        copy_file_atomic(source, &destination)?;
    }

    relative_path_from_base(library_dir, &destination)
}

pub fn persist_thumbnail_file_sync(path: &str, library_path: &str) -> AppResult<String> {
    let source = PathBuf::from(path.trim());
    let library_dir = ensure_library_dir(library_path)?;
    persist_thumbnail_from_source(&source, &library_dir)
}

pub fn delete_thumbnail_file_sync(thumbnail_path: &str, library_path: &str) -> AppResult<()> {
    // Serialize against a concurrent library migration (see library_lock). Acquired once per
    // call, so the per-artifact loop in library_cleanup releases between files rather than
    // nesting.
    let _library_guard = crate::services::library_lock::library_read_guard();

    let library_dir = resolve_existing_library_dir(library_path)?;
    let target_path = absolute_path_from_relative(&library_dir, thumbnail_path)?;

    if !target_path.exists() {
        return Ok(());
    }

    if !target_path.is_file() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidThumbnailPath,
            "thumbnail path is not a file",
        ));
    }

    ensure_existing_path_inside_dir(&target_path, &library_dir)?;

    fs::remove_file(&target_path).map_err(|e| {
        AppError::from_code(
            AppErrorCode::RemoveThumbnailFailed,
            format!("failed to remove thumbnail file: {e}"),
        )
    })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        std::env::temp_dir().join(format!(
            "kavynex-thumbnail-persist-test-{}-{}",
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn persist_thumbnail_from_source_copies_file_to_thumbnails_dir() {
        let root = unique_test_dir();
        let source_dir = root.join("source");
        let library_dir = root.join("library");

        fs::create_dir_all(&source_dir).unwrap();
        fs::create_dir_all(&library_dir).unwrap();

        let source = source_dir.join("thumb.png");
        fs::write(&source, b"png-data").unwrap();

        let relative = persist_thumbnail_from_source(&source, &library_dir).unwrap();

        assert!(relative.starts_with("thumbnails/thumb_"));
        assert!(relative.ends_with(".png"));

        let final_path = library_dir.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        assert!(final_path.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn persist_thumbnail_from_source_rejects_invalid_extension() {
        let root = unique_test_dir();
        let source_dir = root.join("source");
        let library_dir = root.join("library");

        fs::create_dir_all(&source_dir).unwrap();
        fs::create_dir_all(&library_dir).unwrap();

        let source = source_dir.join("thumb.txt");
        fs::write(&source, b"text-data").unwrap();

        let result = persist_thumbnail_from_source(&source, &library_dir);

        assert!(result.is_err());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn delete_thumbnail_file_sync_removes_existing_relative_file() {
        let root = unique_test_dir();
        let library_dir = root.join("library");
        let thumbs_dir = library_dir.join("thumbnails");

        fs::create_dir_all(&thumbs_dir).unwrap();

        let target = thumbs_dir.join("thumb_test.png");
        fs::write(&target, b"png-data").unwrap();

        delete_thumbnail_file_sync(
            "thumbnails/thumb_test.png",
            library_dir.to_string_lossy().as_ref(),
        )
        .unwrap();

        assert!(!target.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn delete_thumbnail_file_sync_ignores_missing_file() {
        let root = unique_test_dir();
        let library_dir = root.join("library");
        fs::create_dir_all(library_dir.join("thumbnails")).unwrap();

        let result = delete_thumbnail_file_sync(
            "thumbnails/missing.png",
            library_dir.to_string_lossy().as_ref(),
        );

        assert!(result.is_ok());

        let _ = fs::remove_dir_all(root);
    }
}
