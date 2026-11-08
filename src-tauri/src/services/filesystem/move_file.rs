//! Moving a file into the library, by a rename when the volume allows it and a verified copy when
//! it does not.

use super::*;

pub fn move_or_copy_file(source: &Path, destination: &Path) -> AppResult<()> {
    move_or_copy_file_using(source, destination, None, rename_retrying_patiently)
}

/// [`move_or_copy_file`] with the rename passed in, so a test can make it fail the way a move
/// across volumes does.
pub(super) fn move_or_copy_file_using(
    source: &Path,
    destination: &Path,
    source_hash: Option<&str>,
    rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> AppResult<()> {
    if !source.exists() {
        return Err(AppError::from_code(
            AppErrorCode::SourceFileNotFound,
            "source file does not exist",
        ));
    }

    if !source.is_file() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidSourceFile,
            "source path is not a file",
        ));
    }

    // If the source already IS the destination (e.g. re-importing a file that is already
    // inside the library, in Move mode), this must be a no-op. Without this guard the
    // "identical content" branch below would remove the source and thus delete the only
    // copy of the file.
    if let (Ok(canonical_source), Ok(canonical_destination)) =
        (source.canonicalize(), destination.canonicalize())
    {
        if canonical_source == canonical_destination {
            return Ok(());
        }
    }

    let parent = destination.parent().ok_or_else(|| {
        AppError::from_code(
            AppErrorCode::InvalidDestinationPath,
            "destination path has no parent directory",
        )
    })?;

    fs::create_dir_all(parent).map_err(|e| {
        AppError::fs_error(
            AppErrorCode::CreateDestinationParentFailed,
            "failed to create destination parent directory",
            parent,
            &e,
        )
    })?;

    if destination.exists() {
        if destination.is_file()
            && file_paths_have_same_content_using(source, destination, source_hash)?
        {
            fs::remove_file(source).map_err(|e| {
                AppError::fs_error(
                    AppErrorCode::SourceFileRemoveFailed,
                    "failed to remove source file after detecting identical destination",
                    source,
                    &e,
                )
            })?;

            return Ok(());
        }

        return Err(AppError::from_code(
            AppErrorCode::DestinationAlreadyExists,
            "destination file already exists",
        ));
    }

    match rename(source, destination) {
        Ok(_) => Ok(()),
        Err(error) if is_cross_device_error(&error) => {
            // The source is removed right after, so the copy is the only one left. It is read back
            // and compared before it takes the destination's name, the way the library migration
            // and a staged move copy (see copy_bytes_in_chunks_verified). A copy that does not
            // match fails here, and the source stays where it was.
            copy_file_atomic_verified(source, destination, None)?;

            fs::remove_file(source).map_err(|e| {
                AppError::fs_error(
                    AppErrorCode::SourceFileRemoveFailed,
                    "failed to remove source file after copy",
                    source,
                    &e,
                )
            })?;

            Ok(())
        }
        Err(error) => Err(AppError::fs_error(
            AppErrorCode::FileMoveFailed,
            "failed to move file",
            destination,
            &error,
        )),
    }
}

/// What [`stage_move_cancellable`] did with the source, and therefore what the caller still owes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StagedMove {
    /// The destination holds the content and the source is still where it was. The caller removes
    /// the source once it has committed to keeping the destination, so a failure before that point
    /// costs nothing but the destination.
    SourceKept,
    /// The source was renamed onto the destination, which is now the only copy. Only reached when
    /// the volume cannot give the file a second name (FAT32 and exFAT have no hard links), because
    /// the alternative there is copying the whole file within one disk.
    SourceConsumed,
    /// The source already is the destination. Nothing was placed and nothing is owed.
    SameFile,
}

/// The first half of a move. Puts `source`'s content at `destination` without giving up `source`.
///
/// The media import's Move mode, which must not remove the user's file until a row points at the
/// library copy. Until then a refused insert, or a crash, hands that copy to a cleanup that deletes
/// unreferenced files. On one volume the destination is a hard link, as instant as a rename and
/// costing no space. Across volumes it is the same atomic copy [`move_or_copy_file`] falls back to.
///
/// A symlinked source is copied rather than linked. Linking it would put the link itself in the
/// library (hard-linking a symlink does not follow it on Linux), and every library walker refuses
/// symlinks, so the file would read as missing.
pub(crate) fn stage_move_cancellable(
    source: &Path,
    destination: &Path,
    source_hash: &str,
    cancel: Option<&AtomicBool>,
) -> AppResult<StagedMove> {
    stage_move_using(source, destination, source_hash, cancel, |from, to| {
        fs::hard_link(from, to)
    })
}

/// [`stage_move_cancellable`] with the link step injected, so the branch a FAT32/exFAT volume takes
/// can be driven by a test on a filesystem that does support links.
pub(super) fn stage_move_using(
    source: &Path,
    destination: &Path,
    source_hash: &str,
    cancel: Option<&AtomicBool>,
    link: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> AppResult<StagedMove> {
    if !source.exists() {
        return Err(AppError::from_code(
            AppErrorCode::SourceFileNotFound,
            "source file does not exist",
        ));
    }

    if !source.is_file() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidSourceFile,
            "source path is not a file",
        ));
    }

    if let (Ok(canonical_source), Ok(canonical_destination)) =
        (source.canonicalize(), destination.canonicalize())
    {
        if canonical_source == canonical_destination {
            return Ok(StagedMove::SameFile);
        }
    }

    let parent = destination.parent().ok_or_else(|| {
        AppError::from_code(
            AppErrorCode::InvalidDestinationPath,
            "destination path has no parent directory",
        )
    })?;

    fs::create_dir_all(parent).map_err(|e| {
        AppError::fs_error(
            AppErrorCode::CreateDestinationParentFailed,
            "failed to create destination parent directory",
            parent,
            &e,
        )
    })?;

    if destination.exists() {
        return staged_onto_existing_destination(source, destination, source_hash);
    }

    // A move that has to copy is followed by the source's removal, so the copy is the only one
    // left. It is read back and compared before it takes the destination's name, the way the
    // library migration copies (see copy_bytes_in_chunks_verified).
    if path_is_symlink(source) {
        copy_file_atomic_verified(source, destination, cancel)?;
        return Ok(StagedMove::SourceKept);
    }

    let link_error = match link(source, destination) {
        Ok(()) => {
            fsync_parent_dir(destination);
            return Ok(StagedMove::SourceKept);
        }
        Err(error) => error,
    };

    // Something took the name between the existence check and the link. Rename would replace it
    // on Unix, so it gets the same identical-content test as a destination that was already there.
    if link_error.kind() == ErrorKind::AlreadyExists {
        return staged_onto_existing_destination(source, destination, source_hash);
    }

    if is_cross_device_error(&link_error) {
        copy_file_atomic_verified(source, destination, cancel)?;
        return Ok(StagedMove::SourceKept);
    }

    match rename_retrying_patiently(source, destination) {
        Ok(()) => {
            fsync_parent_dir(destination);
            // A rename keeps the source's modification time, and the orphan removal spares only a
            // file written in the last hour. This one is the user's only copy, so it gets the time
            // it arrived at, like every copied file does.
            stamp_modified(destination, std::time::SystemTime::now());
            Ok(StagedMove::SourceConsumed)
        }
        Err(error) if is_cross_device_error(&error) => {
            copy_file_atomic_verified(source, destination, cancel)?;
            Ok(StagedMove::SourceKept)
        }
        Err(error) => Err(AppError::fs_error(
            AppErrorCode::FileMoveFailed,
            "failed to move file",
            destination,
            &error,
        )),
    }
}

/// A destination that already exists is accepted only when it holds the source's exact content, and
/// then the source is left for the caller to remove, like any other staged move.
pub(super) fn staged_onto_existing_destination(
    source: &Path,
    destination: &Path,
    source_hash: &str,
) -> AppResult<StagedMove> {
    if destination.is_file()
        && file_paths_have_same_content_using(source, destination, Some(source_hash))?
    {
        return Ok(StagedMove::SourceKept);
    }

    Err(AppError::from_code(
        AppErrorCode::DestinationAlreadyExists,
        "destination file already exists",
    ))
}

/// Re-reads a freshly written content-addressed file and confirms its real SHA-256 matches
/// `expected_hash`. The hash the destination name was built from. That name is computed from a
/// hash of the *source* taken before the copy/move, so a source changed in that window (a file
/// another process was still finalizing, an edit mid-import) would leave the library holding a
/// file whose name no longer describes its content, silently breaking the content-addressed
/// dedup/cleanup invariant everything else relies on. When they differ, the file is renamed to
/// `<prefix>_<actual_hash>.<ext>` so the name is truthful again, or, if a file already sits at
/// that corrected name (the real content was stored before), the mis-named fresh copy is dropped
/// in favor of it. Returns the final path (unchanged in the overwhelmingly common matching case).
///
/// A changed source is not the only way to get there. A copy whose bytes went wrong on the way (a
/// flaky USB bridge, a write a share lost) differs from its name too, and renaming it would make a
/// damaged file look sound. So when `source` is still there, it is hashed again. Still holding
/// `expected_hash` means the source did not change and the copy is what went wrong, which is an
/// error, and the copy is removed. `None` for a source the transfer consumed (a rename moves the
/// bytes rather than copying them).
///
/// This costs a second full-file read, so callers gate it on a genuinely fresh write, never the
/// dedup/skip paths. The guarantee is worth one extra hash on a user-initiated import, not on
/// every no-op re-import of already-stored content.
pub(crate) fn verify_content_addressed_write(
    written: &Path,
    source: Option<&Path>,
    expected_hash: &str,
    prefix: &str,
    ext: &str,
) -> AppResult<PathBuf> {
    let actual_hash = file_hash(written)?;

    if actual_hash == expected_hash {
        return Ok(written.to_path_buf());
    }

    if let Some(source) = source.filter(|source| source.is_file()) {
        if file_hash(source)? == expected_hash {
            let _ = fs::remove_file(written);

            return Err(AppError::from_code(
                AppErrorCode::FileCopyFailed,
                "the copy written to the library does not hold the bytes of the original, so it \
                 was removed and the original was left where it was",
            ));
        }
    }

    let parent = written.parent().ok_or_else(|| {
        AppError::from_code(
            AppErrorCode::InvalidDestinationPath,
            "written file has no parent directory",
        )
    })?;

    let corrected = parent.join(format!("{prefix}_{actual_hash}.{ext}"));

    if corrected == *written {
        return Ok(corrected);
    }

    if corrected.exists() {
        // The real content was already stored under its correct name. Discard the mis-named copy
        // rather than overwriting the catalogued bytes. Best effort. A failed remove only leaks a
        // reclaimable file, never the correct copy.
        let _ = fs::remove_file(written);
        return Ok(corrected);
    }

    rename_retrying_patiently(written, &corrected).map_err(|e| {
        AppError::fs_error(
            AppErrorCode::FileRenameFailed,
            "failed to rename a content-addressed file to its verified hash",
            &corrected,
            &e,
        )
    })?;

    Ok(corrected)
}
