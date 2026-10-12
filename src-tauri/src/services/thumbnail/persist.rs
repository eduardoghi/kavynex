use std::fs;
use std::path::{Path, PathBuf};

use crate::constants::LIBRARY_DIR_THUMBNAILS;
use crate::services::filesystem::copy_file_atomic;
use crate::services::library::lock::LibraryPass;
use crate::services::library::paths::resolve_existing_library_dir;
use crate::utils::format::{allowed_thumbnail_extensions_label, is_allowed_thumbnail_extension};
use crate::utils::hash::file_hash;
use crate::utils::path::{
    absolute_path_from_relative, ensure_existing_path_inside_dir, ensure_path_parent_inside_dir,
    extension_from_path, is_network_path, relative_path_from_base, ManagedSubtree,
};
use crate::{AppError, AppErrorCode, AppResult};

/// The largest image accepted as a thumbnail or an avatar. YouTube's largest thumbnail is well under
/// a megabyte, and anything this large was copied into the library and hashed whole before.
pub(crate) const MAX_PERSISTED_THUMBNAIL_BYTES: u64 = 25 * 1024 * 1024;

pub fn persist_thumbnail_from_source(source: &Path, library_dir: &Path) -> AppResult<String> {
    persist_thumbnail_guarded(source, library_dir, None)
}

/// [`persist_thumbnail_from_source`] for a caller that resolved `library_dir` at the start of a
/// longer operation (a download that fetches for up to a minute first). A library migration that
/// completed in that time leaves `library_dir` naming the old library, and writing there would give
/// the row a path missing from the new one. Refused instead, through the pass begun when the folder
/// was resolved (see [`LibraryPass`]).
pub fn persist_thumbnail_from_source_in_pass(
    source: &Path,
    library_dir: &Path,
    pass: LibraryPass,
) -> AppResult<String> {
    persist_thumbnail_guarded(source, library_dir, Some(pass))
}

fn persist_thumbnail_guarded(
    source: &Path,
    library_dir: &Path,
    pass: Option<LibraryPass>,
) -> AppResult<String> {
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
    let _library_guard = match pass {
        None => crate::services::library::lock::library_read_guard(),
        Some(pass) => pass.file_guard().ok_or_else(|| {
            AppError::from_code(
                AppErrorCode::InvalidLibraryPath,
                "the library was moved while the thumbnail was being fetched; try again",
            )
        })?,
    };

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

    // The bytes as well as the name, as the picked-preview path already checks. The persisted file
    // is drawn by the webview and scaled by FFmpeg, which both go by content.
    if fs::metadata(source).map_or(true, |metadata| {
        metadata.len() > MAX_PERSISTED_THUMBNAIL_BYTES
    }) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidThumbnailFile,
            "the image is too large to use as a thumbnail (25 MB at most)",
        ));
    }

    if !crate::services::thumbnail::picked::file_starts_like_an_image(source) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidThumbnailFile,
            "the file is not an image, whatever its name says",
        ));
    }

    let thumbs_dir = library_dir.join(LIBRARY_DIR_THUMBNAILS);
    crate::services::library::paths::create_dir_in_existing_library(library_dir, &thumbs_dir)
        .map_err(|e| {
            AppError::from_code(
                AppErrorCode::CreateThumbnailsDirFailed,
                format!("failed to create thumbnails directory: {e}"),
            )
        })?;

    let hash = file_hash(source)?;
    let destination = thumbs_dir.join(format!("thumb_{hash}.{ext}"));

    ensure_path_parent_inside_dir(&destination, library_dir)?;

    // On a fresh write, re-hash the written file and correct its name if the source changed between
    // the hash above and the copy (see verify_content_addressed_write). A destination already there
    // is reused only when its bytes match its name. One that does not (a truncated copy, a bad
    // sector) is written over, which repairs it for every row naming it, since they all expect the
    // bytes being persisted now. Reused unchecked, it stayed broken, and fetching the thumbnail
    // again landed on the same damaged file.
    let destination_is_intact =
        destination.is_file() && file_hash(&destination).is_ok_and(|stored| stored == hash);

    let destination = if destination_is_intact {
        destination
    } else {
        if destination.exists() {
            replace_damaged_thumbnail(source, &destination)?;
        } else {
            copy_file_atomic(source, &destination)?;
        }

        crate::services::filesystem::verify_content_addressed_write(
            &destination,
            &hash,
            "thumb",
            &ext,
        )?
    };

    relative_path_from_base(library_dir, &destination)
}

/// Writes `source` over a thumbnail whose bytes no longer match its name. Copied next to it first,
/// since the replace consumes what it is given and `source` is the user's file or a download still
/// in use. A copy left by a failure carries the `.tmp-` name the library sweep removes.
fn replace_damaged_thumbnail(source: &Path, destination: &Path) -> AppResult<()> {
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("thumb");
    let staging = destination.with_file_name(format!(
        ".{file_name}.tmp-{}",
        crate::utils::naming::unique_temp_suffix()
    ));

    copy_file_atomic(source, &staging)?;

    crate::services::filesystem::replace_file_safely(&staging, destination).inspect_err(|_| {
        let _ = fs::remove_file(&staging);
    })
}

pub fn persist_thumbnail_file_sync(path: &str, library_path: &str) -> AppResult<String> {
    let source = PathBuf::from(path.trim());

    // Refused here as well as in `persist_thumbnail_from_source`, ahead of `resolve_existing_library_dir`.
    // The source is the value that arrived over IPC, and nothing should run on its account (not
    // even resolving the library directory) before it is known to be one this app will read.
    if is_network_path(&source.to_string_lossy()) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidSourceThumbnail,
            "source thumbnail must not be a network location",
        ));
    }

    let library_dir = resolve_existing_library_dir(library_path)?;
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
        // not exist. The refusal has to come before anything (the stat of the source, the creation
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
    fn a_thumbnail_is_not_persisted_into_a_library_that_is_not_there() {
        let source_dir = unique_test_dir();
        fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("cover.jpg");
        fs::write(&source, b"\xFF\xD8\xFFjpeg bytes").unwrap();
        let library = unique_test_dir();

        let error = persist_thumbnail_from_source(&source, &library)
            .expect_err("a missing library must be refused");

        assert_eq!(error.code, AppErrorCode::CreateThumbnailsDirFailed.as_str());
        assert!(
            !library.exists(),
            "the library folder must not be recreated"
        );

        let _ = fs::remove_dir_all(&source_dir);
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
        fs::write(&source, b"\x89PNG\r\n\x1a\npng-data").unwrap();

        let relative = persist_thumbnail_from_source(&source, &library_dir).unwrap();

        assert!(relative.starts_with("thumbnails/thumb_"));
        assert!(relative.ends_with(".png"));

        let final_path = library_dir.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        assert!(final_path.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_damaged_thumbnail_named_for_the_same_content_is_written_over() {
        // A truncated `thumb_<hash>` is the state Diagnostics reports as corrupt. Persisting the
        // same image again has to repair it rather than reuse it, or the card stays blank for good.
        let root = unique_test_dir();
        let library_dir = root.join("library");
        fs::create_dir_all(&library_dir).unwrap();
        let source = root.join("thumb.png");
        let bytes = b"\x89PNG\r\n\x1a\nthe-whole-image";
        fs::write(&source, bytes).unwrap();

        let relative = persist_thumbnail_from_source(&source, &library_dir).unwrap();
        let stored = library_dir.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        fs::write(&stored, b"\x89PNG").unwrap();

        let again = persist_thumbnail_from_source(&source, &library_dir).unwrap();

        assert_eq!(again, relative);
        assert_eq!(fs::read(&stored).unwrap(), bytes);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_file_named_like_an_image_that_is_not_one_is_not_persisted() {
        let root = unique_test_dir();
        let library_dir = root.join("library");
        fs::create_dir_all(&library_dir).unwrap();
        let source = root.join("notes.jpg");
        fs::write(&source, b"#EXTM3U\nfile:///etc/passwd\n").unwrap();

        let error = persist_thumbnail_from_source(&source, &library_dir)
            .expect_err("a playlist renamed .jpg is not an image");

        assert_eq!(error.code, AppErrorCode::InvalidThumbnailFile.as_str());
        assert!(!library_dir.join("thumbnails").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_pass_that_saw_a_migration_complete_refuses_to_write_into_the_old_library() {
        let root = unique_test_dir();
        let library_dir = root.join("library");
        fs::create_dir_all(&library_dir).unwrap();
        let source = root.join("thumb.png");
        fs::write(&source, b"\x89PNG\r\n\x1a\n0000000000").unwrap();

        let pass = LibraryPass::begin();
        // What a library migration does when it finishes.
        drop(crate::services::library::lock::library_write_guard());

        let error = persist_thumbnail_from_source_in_pass(&source, &library_dir, pass)
            .expect_err("the library moved after the pass began");
        assert_eq!(error.code, AppErrorCode::InvalidLibraryPath.as_str());
        assert!(!library_dir.join(LIBRARY_DIR_THUMBNAILS).exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_image_past_the_size_ceiling_is_not_persisted() {
        let root = unique_test_dir();
        let library_dir = root.join("library");
        fs::create_dir_all(&library_dir).unwrap();
        let source = root.join("huge.png");
        let file = fs::File::create(&source).unwrap();
        file.set_len(MAX_PERSISTED_THUMBNAIL_BYTES + 1).unwrap();
        drop(file);

        let error = persist_thumbnail_from_source(&source, &library_dir)
            .expect_err("too large to be a thumbnail");

        assert_eq!(error.code, AppErrorCode::InvalidThumbnailFile.as_str());

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
