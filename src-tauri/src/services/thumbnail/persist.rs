use std::fs;
use std::path::{Path, PathBuf};

use crate::constants::LIBRARY_DIR_THUMBNAILS;
use crate::services::filesystem::copy_file_atomic;
use crate::services::library::paths::{ensure_library_dir, resolve_existing_library_dir};
use crate::utils::format::{allowed_thumbnail_extensions_label, is_allowed_thumbnail_extension};
use crate::utils::hash::file_hash;
use crate::utils::path::{
    absolute_path_from_relative, ensure_existing_path_inside_dir, ensure_path_parent_inside_dir,
    extension_from_path, is_network_path, relative_path_from_base, ManagedSubtree,
};
use crate::{AppError, AppErrorCode, AppResult};

pub fn persist_thumbnail_from_source(source: &Path, library_dir: &Path) -> AppResult<String> {
    // Refuse a UNC / network source before the `exists()` below touches it. Two of this
    // function's callers hand it a path that arrived raw over IPC (the `persist_thumbnail_file`
    // command and the local branch of `create_media`'s thumbnail source), and on Windows merely
    // stat'ing `\\host\share\x.jpg` authenticates to `host` over SMB and leaks the user's NTLM
    // hash. The same cross-cutting rule as `thumbnail::picked::validate_picked_thumbnail_path`,
    // which only the staged-preview path runs; this was the one persist entry point without it.
    // The third caller (the download) passes a file it just wrote into the app cache, so the
    // check is free there.
    if is_network_path(&source.to_string_lossy()) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidSourceThumbnail,
            "source thumbnail must not be a network location",
        ));
    }

    // Serialize this library write against a concurrent migration (see library::lock). Covers
    // both the manual-thumbnail persist and the downloaded-thumbnail/avatar persist, which are
    // this function's only callers.
    let _library_guard = crate::services::library::lock::library_read_guard();

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
            format!(
                "invalid thumbnail file type. Allowed: {}",
                allowed_thumbnail_extensions_label()
            ),
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

    // On a fresh write, re-hash the written file and correct its name if the source changed between
    // the hash above and the copy (see verify_content_addressed_write). An already-present
    // destination wrote nothing, so it keeps its (already content-verified) name without a re-hash.
    let destination = if destination.exists() {
        destination
    } else {
        copy_file_atomic(source, &destination)?;
        crate::services::filesystem::verify_content_addressed_write(
            &destination,
            &hash,
            "thumb",
            &ext,
        )?
    };

    relative_path_from_base(library_dir, &destination)
}

pub fn persist_thumbnail_file_sync(path: &str, library_path: &str) -> AppResult<String> {
    let source = PathBuf::from(path.trim());

    // Refused here as well as in `persist_thumbnail_from_source`, ahead of `ensure_library_dir`:
    // the source is the value that arrived over IPC, and nothing should run on its account (not
    // even creating the library directory) before it is known to be one this app will read.
    if is_network_path(&source.to_string_lossy()) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidSourceThumbnail,
            "source thumbnail must not be a network location",
        ));
    }

    let library_dir = ensure_library_dir(library_path)?;
    persist_thumbnail_from_source(&source, &library_dir)
}

pub fn delete_thumbnail_file_sync(thumbnail_path: &str, library_path: &str) -> AppResult<()> {
    // Serialize against a concurrent library migration (see library::lock). Acquired once per
    // call, so the per-artifact loop in library::cleanup releases between files rather than
    // nesting.
    let _library_guard = crate::services::library::lock::library_read_guard();

    let library_dir = resolve_existing_library_dir(library_path)?;
    let target_path =
        absolute_path_from_relative(&library_dir, thumbnail_path, ManagedSubtree::Thumbnails)?;

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

    fn unique_test_dir() -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-thumbnail-persist-test-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    #[test]
    fn persist_thumbnail_from_source_refuses_a_network_source_before_touching_it() {
        // Every spelling Windows resolves to a share, each carrying a valid image extension so only
        // the network check can be what refuses it. The library is deliberately a path that does
        // not exist: the refusal has to come before anything (the stat of the source, the creation
        // of the library) runs, and a library that was created would show it did not.
        let library = unique_test_dir();

        for value in [
            r"\\evil\share\cover.jpg",
            "//evil/share/cover.jpg",
            r"/\evil\share\cover.jpg",
            r"\/evil\share\cover.jpg",
            r"\\?\UNC\evil\share\cover.jpg",
        ] {
            let error = persist_thumbnail_from_source(Path::new(value), &library)
                .expect_err(&format!("{value} should be refused as a network path"));

            assert_eq!(error.code, AppErrorCode::InvalidSourceThumbnail.as_str());
            assert!(
                error.message.contains("network location"),
                "the refusal should name the reason: {}",
                error.message
            );
        }

        assert!(
            !library.exists(),
            "nothing may run before the network refusal, not even creating the library"
        );
    }

    #[test]
    fn persist_thumbnail_file_sync_refuses_a_network_source() {
        // The string-taking entry the `persist_thumbnail_file` command and the local thumbnail
        // branch of a media creation call, pinned separately so a later split of the two cannot
        // leave one of them behind.
        let library = unique_test_dir();

        let error =
            persist_thumbnail_file_sync(r"\\evil\share\cover.png", &library.to_string_lossy())
                .expect_err("a UNC source must be refused");

        assert_eq!(error.code, AppErrorCode::InvalidSourceThumbnail.as_str());
        assert!(!library.exists());
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
