use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use crate::models::yt_dlp::ImportMode;
use crate::services::filesystem::{
    copy_file_atomic_cancellable, file_paths_have_same_content_using, stage_move_cancellable,
    StagedMove,
};
use crate::services::library::paths::resolve_existing_library_dir;
use crate::services::logger;
use crate::utils::format::{
    allowed_media_extensions_label, is_allowed_media_extension, media_subdir_from_extension,
};
use crate::utils::hash::{file_hash_cancellable, is_cancelled};
use crate::utils::path::{
    absolute_path_from_relative, ensure_existing_path_inside_dir, ensure_path_parent_inside_dir,
    extension_from_path, is_network_path, relative_path_from_base, ManagedSubtree,
};
use crate::{AppError, AppErrorCode, AppResult};

/// Builds the error a cancelled import unwinds with. One place, so every check reports the same
/// code. The frontend routes it to the neutral notice channel rather than the error modal, which
/// only works if the code is exactly this one.
fn cancelled(stage: &str) -> AppError {
    AppError::from_code(
        AppErrorCode::MediaImportCancelled,
        format!("the import was cancelled {stage}"),
    )
}

/// The library name of a media file whose content hashes to `digest`.
///
/// Shared by the local import and the yt-dlp download, so the same bytes land on the same file
/// whichever way they arrived, and so the deep verification can check either against its name.
pub(crate) fn content_addressed_media_name(digest: &str, extension: &str) -> String {
    format!("media_{digest}.{extension}")
}

/// Imports a media file with no way to interrupt it. The shape the tests and any future
/// non-interactive caller want. The user-facing path goes through
/// [`stage_media_import_cancellable_sync`].
pub fn import_media_file_sync(
    path: &str,
    mode: ImportMode,
    library_path: &str,
) -> AppResult<String> {
    import_media_file_cancellable_sync(path, mode, library_path, None)
}

/// Imports a media file and, in Move mode, removes the source straight away.
///
/// For a caller with nothing to register in between. Media creation must not use this, because it
/// removes the source before any row points at the library copy, which is the window
/// [`stage_media_import_cancellable_sync`] exists to close.
pub fn import_media_file_cancellable_sync(
    path: &str,
    mode: ImportMode,
    library_path: &str,
    cancel: Option<&AtomicBool>,
) -> AppResult<String> {
    let staged = stage_media_import_cancellable_sync(path, mode, library_path, cancel)?;

    if let Some(source) = staged.source_to_remove.as_deref() {
        remove_moved_import_source_sync(source)?;
    }

    Ok(staged.relative_path)
}

/// A media file placed in the library by [`stage_media_import_cancellable_sync`], and what the
/// import still owes its source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedMediaImport {
    pub relative_path: String,
    /// The Move-mode source, still on disk. Removed with [`remove_moved_import_source_sync`] once a
    /// row points at `relative_path`. `None` in Copy mode, and in Move mode when nothing is left to
    /// remove.
    pub source_to_remove: Option<PathBuf>,
    /// True when the library file is the only copy of the user's file, so a failure must leave it in
    /// place rather than hand it to the reference-counted cleanup. Set when the source had to be
    /// renamed into the library (a volume without hard links), and when the source already was the
    /// library file.
    pub library_holds_only_copy: bool,
    /// Where the library file was renamed from, when the Move renamed the user's file into the
    /// library rather than linking or copying it. A failed registration renames it back there.
    pub renamed_from: Option<PathBuf>,
}

/// Removes a Move-mode source once the media it became is registered.
///
/// A source that is already gone is not an error. Nothing is owed to it any more.
pub fn remove_moved_import_source_sync(source: &Path) -> AppResult<()> {
    match fs::remove_file(source) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::fs_error(
            AppErrorCode::SourceFileRemoveFailed,
            "failed to remove the imported source file",
            source,
            &error,
        )),
    }
}

/// Places a media file in the library, abandoning the work when `cancel` is set. In Move mode the
/// source is left where it was whenever the volume allows it, and [`StagedMediaImport`] says what
/// is still owed to it.
///
/// Without the flag, a local import would be the only long operation in this app the user has no
/// way out of. A yt-dlp download has a stall detector, a timeout, a tree-kill and a Cancel button,
/// but an import of a 50 GB file from a slow external drive has none of that, and the add-media
/// modal stays locked while it runs, so the only exit would be killing the app, which the crash
/// marker then has to clean up after.
///
/// The flag is polled at three places, which between them cover the whole of the wall clock. Before
/// any work starts, throughout the hash (a full read pass over the source, and the *first* long
/// step), and throughout the copy. What is deliberately not interruptible is the small tail after
/// the bytes are in place (the fsync, the rename, the post-write verification), because
/// abandoning *there* is what would leave a half-finished file where the atomic write was about to
/// succeed.
///
/// Nothing is left behind by a cancel. The hash writes nothing. The copy stages through a `.tmp-`
/// sibling that its own error path removes, and a cancel before the rename means the library never
/// saw the file at all.
pub fn stage_media_import_cancellable_sync(
    path: &str,
    mode: ImportMode,
    library_path: &str,
    cancel: Option<&AtomicBool>,
) -> AppResult<StagedMediaImport> {
    let trimmed = path.trim();

    // Reject a UNC / network source before any filesystem call touches it. The source is
    // caller-supplied (the user picks a file anywhere on disk), and in Move mode the original is
    // removed, so a `\\host\share` source would both make Windows authenticate to `host` over SMB
    // (leaking the NTLM hash) and let a delete land on a network file. The picker never yields such a
    // path for a normal selection. This closes the value a compromised frontend could inject. It does
    // not make Move safe against an arbitrary *local* source a compromised renderer names (that is
    // inherent to importing a user-picked file and is the subject of the separate path-authority
    // hardening), but it removes the network/NTLM angle here, matching the thumbnail source guard.
    if is_network_path(trimmed) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidSourceMedia,
            "network locations are not allowed as an import source",
        ));
    }

    let source = PathBuf::from(trimmed);

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
        // The accepted list travels in `details` rather than in the message. The frontend shows a
        // catalogued sentence for this code and appends `details` after it, so this is what puts
        // the answer ("which files does it take, then?") in front of the user instead of leaving
        // it in the log.
        return Err(AppError::from_code_with_details(
            AppErrorCode::UnsupportedMediaExtension,
            format!("unsupported media file extension: {ext}"),
            format!("accepted: {}", allowed_media_extensions_label()),
        ));
    }

    // Refused before the library lock is taken, so a cancel that lands while the request is queued
    // does not first make a concurrent migration wait on a transfer nobody wants any more.
    if is_cancelled(cancel) {
        return Err(cancelled("before any file was touched"));
    }

    // Serialize this write against a concurrent library migration so the imported file cannot be
    // dropped in the window between the migration copying and removing the old directory.
    let _library_guard = crate::services::library::lock::library_read_guard();

    let library_dir = resolve_existing_library_dir(library_path)?;
    let media_subdir = media_subdir_from_extension(&ext);
    let media_dir = library_dir.join(media_subdir);

    fs::create_dir_all(&media_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateMediaDirFailed,
            format!("failed to create media directory: {e}"),
        )
    })?;

    let hash = file_hash_cancellable(&source, cancel)?;
    let destination = media_dir.join(content_addressed_media_name(&hash, &ext));

    ensure_path_parent_inside_dir(&destination, &library_dir)?;

    logger::info(
        "library",
        format!(
            "importing media: source='{}', mode='{}', destination='{}'",
            logger::redact_path(&source),
            mode.as_str(),
            logger::redact_path(&destination)
        ),
    );

    // Whether the content-addressed destination already held this content before the transfer.
    // Captured up front so the post-write hash verification below runs only on a genuinely fresh
    // write, never on a dedup/skip path (which writes nothing and would only re-hash a possibly
    // multi-GB file for no reason).
    let destination_existed = destination.exists();

    // A Move of a file that is already in the library is imported as a Copy. Removing the source
    // would take the file another row points at (`video/youtube_<id>_<fmt>.mp4` picked in the dialog
    // and imported again under `media_<hash>`), leaving that row on a missing file. The one exception
    // is a source that *is* the destination, which the staged move recognizes and keeps as the
    // user's only copy.
    let mode = if matches!(mode, ImportMode::Move)
        && source_is_another_library_file(&source, &destination, &library_dir)
    {
        logger::info(
            "library",
            "the import source is already in the library, so it is copied rather than moved",
        );
        ImportMode::Copy
    } else {
        mode
    };

    let (source_to_remove, library_holds_only_copy, renamed_from) = match mode {
        ImportMode::Copy => {
            if destination_existed {
                // A file under this content's name is already in the library. Its name is a claim
                // about its bytes, not proof of them, so it is compared before the import adopts
                // it. Taking it on its name let a truncated or damaged file stand in for the
                // user's intact original, which they then believed was backed up. The hash already
                // computed is reused, so only the library file is read.
                if !file_paths_have_same_content_using(&source, &destination, Some(&hash))? {
                    return Err(damaged_destination(&destination));
                }

                logger::info(
                    "library",
                    format!(
                        "media import reuses the identical file already in the library: '{}'",
                        crate::services::logger::redact_path(&destination)
                    ),
                );
            } else {
                copy_file_atomic_cancellable(&source, &destination, cancel)?;
            }

            (None, false, None)
        }
        ImportMode::Move => {
            // Always staged, even when the destination already exists, so an identical-by-hash
            // source is still owed its removal and the Move actually frees it. Pass the hash we
            // already computed above so the identical-content check does not re-hash the
            // (possibly multi-GB) source a second time.
            let staged =
                stage_move_cancellable(&source, &destination, &hash, cancel).map_err(|error| {
                    if error.code == AppErrorCode::DestinationAlreadyExists.as_str() {
                        damaged_destination(&destination)
                    } else {
                        error
                    }
                })?;

            match staged {
                StagedMove::SourceKept => (Some(source.clone()), false, None),
                StagedMove::SourceConsumed => (None, true, Some(source.clone())),
                // The user's file is the library file. If no row ends up pointing at it, it is
                // still theirs and must not be cleaned up.
                StagedMove::SameFile => (None, true, None),
            }
        }
    };

    // A fresh write's name was built from a hash of the source taken before the transfer, so a
    // source changed in that window could leave the name describing the wrong content. Re-hash the
    // written file and correct the name if they differ. A `destination_existed` path wrote nothing
    // (Copy skip, Move dedup, or Move source==destination no-op), so it is not re-hashed.
    let destination = if destination_existed {
        destination
    } else {
        crate::services::filesystem::verify_content_addressed_write(
            &destination,
            source_to_compare(&source, library_holds_only_copy),
            &hash,
            "media",
            &ext,
        )?
    };

    let relative_path = relative_path_from_base(&library_dir, &destination)?;

    logger::info(
        "library",
        format!("media import finished: '{}'", relative_path),
    );

    Ok(StagedMediaImport {
        relative_path,
        source_to_remove,
        library_holds_only_copy,
        renamed_from,
    })
}

/// True when `source` sits inside the library and is not the content-addressed `destination`
/// itself. Both are canonicalized, so a different spelling of a library path still counts.
fn source_is_another_library_file(source: &Path, destination: &Path, library_dir: &Path) -> bool {
    let Ok(canonical_source) = source.canonicalize() else {
        return false;
    };

    if destination
        .canonicalize()
        .is_ok_and(|canonical_destination| canonical_destination == canonical_source)
    {
        return false;
    }

    library_dir
        .canonicalize()
        .is_ok_and(|canonical_library| canonical_source.starts_with(canonical_library))
}

/// The refusal for a library file whose name says it holds the imported content and whose bytes
/// say otherwise. Neither copy is touched. Which one is right is the user's call, and the deep check
/// in Diagnostics is what tells them which library files no longer match their names.
fn damaged_destination(destination: &Path) -> AppError {
    AppError::from_code_with_details(
        AppErrorCode::DestinationAlreadyExists,
        "a library file is named for this content but holds different bytes",
        format!(
            "{} in the library is named for this file's content but does not match it, so it may \
             be damaged. Nothing was changed. The deep check in Diagnostics lists the library files \
             that no longer match their names.",
            destination
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        ),
    )
}

pub fn delete_media_file_sync(file_path: &str, library_path: &str) -> AppResult<()> {
    // Serialize against a concurrent library migration (see library::lock). Acquired once per
    // call, so the per-artifact loop in library::cleanup releases between files rather than
    // nesting. The migration can interleave harmlessly, since a file it removed just makes the
    // next delete a no-op.
    let _library_guard = crate::services::library::lock::library_read_guard();

    let library_dir = resolve_existing_library_dir(library_path)?;
    let target_path = absolute_path_from_relative(&library_dir, file_path, ManagedSubtree::Media)?;

    if !target_path.exists() {
        logger::warn(
            "library",
            format!(
                "media delete skipped because file does not exist: '{}'",
                crate::services::logger::redact_path(&target_path)
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
        format!(
            "deleting media file '{}'",
            logger::redact_path(&target_path)
        ),
    );

    fs::remove_file(&target_path).map_err(|e| {
        AppError::from_code(
            AppErrorCode::RemoveMediaFailed,
            format!("failed to remove media file: {e}"),
        )
    })?;

    logger::info(
        "library",
        format!("media file deleted '{}'", logger::redact_path(&target_path)),
    );

    Ok(())
}

/// The source a fresh write is compared against, or `None` when the source was consumed. A source
/// renamed into the library rather than copied is no longer where it was, so there is nothing to
/// compare against.
fn source_to_compare(source: &Path, library_holds_only_copy: bool) -> Option<&Path> {
    (!library_holds_only_copy).then_some(source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_copy_is_compared_with_its_source_and_a_consumed_source_is_not() {
        let source = Path::new("/elsewhere/clip.mp4");

        assert_eq!(source_to_compare(source, false), Some(source));
        assert_eq!(source_to_compare(source, true), None);
    }

    fn unique_test_dir(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-library-media-test-{prefix}-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    #[test]
    fn import_media_file_sync_rejects_unsupported_extension() {
        let root = unique_test_dir("unsupported-ext");
        let source_dir = root.join("source");
        let library_dir = root.join("library");
        fs::create_dir_all(&library_dir).unwrap();
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
    fn import_media_file_sync_rejects_a_unc_network_source() {
        // A UNC source must be rejected before any exists/hash/remove touches the SMB stack, so a
        // Move can never delete a network file or leak the NTLM hash. Checked ahead of the
        // extension gate, so a media extension does not matter.
        for unc in [r"\\server\share\clip.mp4", "//server/share/clip.mp4"] {
            let error = import_media_file_sync(unc, ImportMode::Move, "/library").unwrap_err();
            assert_eq!(error.code, AppErrorCode::InvalidSourceMedia.as_str());
        }
    }

    #[test]
    fn import_media_file_sync_copy_mode_preserves_source_file() {
        let root = unique_test_dir("copy-preserves");
        let source_dir = root.join("source");
        let library_dir = root.join("library");
        fs::create_dir_all(&library_dir).unwrap();
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
        fs::create_dir_all(&library_dir).unwrap();
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
    fn a_staged_move_import_leaves_the_source_until_the_caller_removes_it() {
        // Media creation registers the row between these two steps. Whatever happens to the
        // library copy before that, the user's file is still at its original path.
        let root = unique_test_dir("staged-move");
        let source_dir = root.join("source");
        let library_dir = root.join("library");
        fs::create_dir_all(&library_dir).unwrap();
        fs::create_dir_all(&source_dir).unwrap();

        let source = source_dir.join("video.mp4");
        fs::write(&source, b"video-bytes").unwrap();

        let staged = stage_media_import_cancellable_sync(
            source.to_string_lossy().as_ref(),
            ImportMode::Move,
            library_dir.to_string_lossy().as_ref(),
            None,
        )
        .unwrap();

        assert!(source.is_file(), "staging must not remove the source");
        assert_eq!(staged.source_to_remove.as_deref(), Some(source.as_path()));
        assert!(!staged.library_holds_only_copy);

        let library_file = library_dir.join(&staged.relative_path);
        assert_eq!(fs::read(&library_file).unwrap(), b"video-bytes");

        remove_moved_import_source_sync(&source).unwrap();

        assert!(!source.exists());
        assert_eq!(fs::read(&library_file).unwrap(), b"video-bytes");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_move_of_a_file_already_in_the_library_keeps_it_for_the_row_that_owns_it() {
        // Picking a downloaded video (`youtube_<id>_<fmt>.mp4`) in the dialog and importing it in
        // Move mode removed it once the new row landed, leaving its own row on a missing file.
        let root = unique_test_dir("move-from-library");
        let library_dir = root.join("library");
        let video_dir = library_dir.join("video");
        fs::create_dir_all(&video_dir).unwrap();

        let owned = video_dir.join("youtube_abc_137.mp4");
        fs::write(&owned, b"downloaded-bytes").unwrap();

        let staged = stage_media_import_cancellable_sync(
            owned.to_string_lossy().as_ref(),
            ImportMode::Move,
            library_dir.to_string_lossy().as_ref(),
            None,
        )
        .unwrap();

        assert_eq!(
            staged.source_to_remove, None,
            "the library file is not the import's to remove"
        );
        assert!(!staged.library_holds_only_copy);
        assert_eq!(fs::read(&owned).unwrap(), b"downloaded-bytes");
        assert_eq!(
            fs::read(library_dir.join(&staged.relative_path)).unwrap(),
            b"downloaded-bytes"
        );

        let _ = fs::remove_dir_all(root);
    }

    /// A library holding `media_<hash of content>.mp4` whose bytes are not `content`.
    fn library_with_a_damaged_copy_of(root: &Path, content: &[u8]) -> (PathBuf, PathBuf, PathBuf) {
        let source_dir = root.join("source");
        let library_dir = root.join("library");
        let video_dir = library_dir.join("video");
        fs::create_dir_all(&source_dir).unwrap();
        fs::create_dir_all(&video_dir).unwrap();

        let source = source_dir.join("video.mp4");
        fs::write(&source, content).unwrap();

        let hash = crate::utils::hash::file_hash(&source).unwrap();
        let damaged = video_dir.join(format!("media_{hash}.mp4"));
        fs::write(&damaged, b"truncat").unwrap();

        (source, library_dir, damaged)
    }

    #[test]
    fn a_copy_import_refuses_a_library_file_named_for_its_content_that_holds_other_bytes() {
        // Adopted on its name alone, the damaged file became the "backup" of the user's intact one.
        let root = unique_test_dir("copy-damaged");
        let (source, library_dir, damaged) = library_with_a_damaged_copy_of(&root, b"intact-bytes");

        let error = stage_media_import_cancellable_sync(
            source.to_string_lossy().as_ref(),
            ImportMode::Copy,
            library_dir.to_string_lossy().as_ref(),
            None,
        )
        .expect_err("a damaged library file must not stand in for the import");

        assert_eq!(error.code, AppErrorCode::DestinationAlreadyExists.as_str());
        assert!(
            error
                .details
                .as_deref()
                .unwrap_or_default()
                .contains("may be damaged"),
            "{error:?}"
        );
        assert_eq!(
            fs::read(&damaged).unwrap(),
            b"truncat",
            "neither copy is touched"
        );
        assert_eq!(fs::read(&source).unwrap(), b"intact-bytes");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_move_import_explains_the_same_refusal() {
        let root = unique_test_dir("move-damaged");
        let (source, library_dir, _) = library_with_a_damaged_copy_of(&root, b"intact-bytes");

        let error = stage_media_import_cancellable_sync(
            source.to_string_lossy().as_ref(),
            ImportMode::Move,
            library_dir.to_string_lossy().as_ref(),
            None,
        )
        .expect_err("a damaged library file must not stand in for the import");

        assert_eq!(error.code, AppErrorCode::DestinationAlreadyExists.as_str());
        assert!(error
            .details
            .as_deref()
            .unwrap_or_default()
            .contains("may be damaged"));
        assert!(source.is_file());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_staged_copy_import_owes_the_source_nothing() {
        let root = unique_test_dir("staged-copy");
        let source_dir = root.join("source");
        let library_dir = root.join("library");
        fs::create_dir_all(&library_dir).unwrap();
        fs::create_dir_all(&source_dir).unwrap();

        let source = source_dir.join("video.mp4");
        fs::write(&source, b"video-bytes").unwrap();

        let staged = stage_media_import_cancellable_sync(
            source.to_string_lossy().as_ref(),
            ImportMode::Copy,
            library_dir.to_string_lossy().as_ref(),
            None,
        )
        .unwrap();

        assert_eq!(staged.source_to_remove, None);
        assert!(!staged.library_holds_only_copy);
        assert!(source.is_file());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn moving_the_library_file_onto_itself_marks_it_as_the_only_copy() {
        // The source already is the content-addressed library file. If no row ends up pointing
        // at it, it is still the user's file, so the failure path must not clean it up.
        let root = unique_test_dir("staged-same-file");
        let source_dir = root.join("source");
        let library_dir = root.join("library");
        fs::create_dir_all(&library_dir).unwrap();
        fs::create_dir_all(&source_dir).unwrap();

        let original = source_dir.join("video.mp4");
        fs::write(&original, b"video-bytes").unwrap();

        let first = import_media_file_sync(
            original.to_string_lossy().as_ref(),
            ImportMode::Copy,
            library_dir.to_string_lossy().as_ref(),
        )
        .unwrap();
        let library_file = library_dir.join(&first);

        let staged = stage_media_import_cancellable_sync(
            library_file.to_string_lossy().as_ref(),
            ImportMode::Move,
            library_dir.to_string_lossy().as_ref(),
            None,
        )
        .unwrap();

        assert_eq!(staged.relative_path, first);
        assert_eq!(staged.source_to_remove, None);
        assert!(staged.library_holds_only_copy);
        assert!(library_file.is_file());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn removing_a_source_that_is_already_gone_is_not_an_error() {
        let missing = unique_test_dir("source-gone").join("video.mp4");

        remove_moved_import_source_sync(&missing).unwrap();
    }

    #[test]
    fn a_source_that_cannot_be_removed_is_reported_rather_than_ignored() {
        // Only "already gone" is forgiven. Anything else has to reach the caller, which logs that
        // the Move left the original in place.
        let dir = unique_test_dir("source-unremovable");
        fs::create_dir_all(&dir).unwrap();

        let error = remove_moved_import_source_sync(&dir).unwrap_err();

        assert_eq!(error.code, AppErrorCode::SourceFileRemoveFailed.as_str());
        assert!(dir.is_dir());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn import_media_file_sync_is_a_noop_when_destination_already_exists() {
        let root = unique_test_dir("noop-existing");
        let source_dir = root.join("source");
        let library_dir = root.join("library");
        fs::create_dir_all(&library_dir).unwrap();
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
    fn a_cancelled_import_puts_nothing_in_the_library_and_keeps_the_source() {
        // Both modes, because the consequence of getting Move wrong is not recoverable. A cancel
        // that removed the source without landing the destination would delete the user's file to
        // honour a request to *not* import it. Copy is asserted alongside it so the shared refusal
        // cannot be weakened for one mode only.
        for mode in [ImportMode::Copy, ImportMode::Move] {
            let root = unique_test_dir("cancelled");
            let source_dir = root.join("source");
            let library_dir = root.join("library");
            fs::create_dir_all(&library_dir).unwrap();
            fs::create_dir_all(&source_dir).unwrap();

            let source = source_dir.join("video.mp4");
            fs::write(&source, b"video-bytes").unwrap();

            let cancel = AtomicBool::new(true);
            let error = import_media_file_cancellable_sync(
                source.to_string_lossy().as_ref(),
                mode,
                library_dir.to_string_lossy().as_ref(),
                Some(&cancel),
            )
            .unwrap_err();

            assert_eq!(error.code, AppErrorCode::MediaImportCancelled.as_str());
            assert!(
                source.exists(),
                "a cancelled {mode:?} import must leave the source file alone"
            );
            assert!(
                !library_dir.join("video").exists(),
                "a cancelled {mode:?} import must not populate the library"
            );

            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn an_import_that_is_never_cancelled_behaves_exactly_as_the_plain_one() {
        // The flag must be inert when it is not set, including for the content-addressed name,
        // which is a hash taken through the cancellable reader now, so a check placed one step
        // wrong would change the name every existing row is stored under.
        let root = unique_test_dir("not-cancelled");
        let source_dir = root.join("source");
        fs::create_dir_all(&source_dir).unwrap();
        fs::create_dir_all(root.join("with-flag")).unwrap();
        fs::create_dir_all(root.join("without-flag")).unwrap();

        let source = source_dir.join("video.mp4");
        fs::write(&source, b"video-bytes").unwrap();

        let cancel = AtomicBool::new(false);
        let with_flag = import_media_file_cancellable_sync(
            source.to_string_lossy().as_ref(),
            ImportMode::Copy,
            root.join("with-flag").to_string_lossy().as_ref(),
            Some(&cancel),
        )
        .unwrap();

        let without_flag = import_media_file_sync(
            source.to_string_lossy().as_ref(),
            ImportMode::Copy,
            root.join("without-flag").to_string_lossy().as_ref(),
        )
        .unwrap();

        assert_eq!(with_flag, without_flag);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_import_into_a_library_folder_that_is_gone_is_refused_without_recreating_it() {
        // The drive holding the library unmounted, or the folder was moved away. Recreating it put
        // new media in an empty folder of the same name while every existing row named files that
        // were somewhere else.
        let root = unique_test_dir("library-gone");
        let source_dir = root.join("source");
        fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("video.mp4");
        fs::write(&source, b"video-bytes").unwrap();
        let library_dir = root.join("library");

        let error = import_media_file_sync(
            source.to_string_lossy().as_ref(),
            ImportMode::Copy,
            library_dir.to_string_lossy().as_ref(),
        )
        .unwrap_err();

        assert_eq!(error.code, AppErrorCode::InvalidLibraryPath.as_str());
        assert!(!library_dir.exists());
        assert!(source.is_file());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn delete_media_file_sync_returns_ok_for_missing_file() {
        let root = unique_test_dir("delete-missing");
        let library_dir = root.join("library");
        fs::create_dir_all(&library_dir).unwrap();
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
