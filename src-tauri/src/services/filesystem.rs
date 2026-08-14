use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::SystemTime;

use crate::utils::hash::file_hash;
use crate::utils::naming::unique_temp_suffix;
use crate::{AppError, AppErrorCode, AppResult};

#[cfg(unix)]
fn is_cross_device_error(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(18)
}

#[cfg(windows)]
fn is_cross_device_error(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(17)
}

#[cfg(not(any(unix, windows)))]
fn is_cross_device_error(_: &std::io::Error) -> bool {
    false
}

fn build_temp_destination_path(destination: &Path) -> AppResult<PathBuf> {
    let parent = destination.parent().ok_or_else(|| {
        AppError::from_code(
            AppErrorCode::InvalidDestinationPath,
            "destination path has no parent directory",
        )
    })?;

    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("file");

    Ok(parent.join(format!(".{}.tmp-{}", file_name, unique_temp_suffix())))
}

/// Flushes a freshly written file's data and metadata to disk. Called before the rename in
/// `copy_file_atomic` (and by the db-backup staging copies) so a power loss cannot leave a
/// truncated or zero-length file that a following rename then makes the live file. The file is
/// opened for writing because Windows' `FlushFileBuffers` (what `sync_all` maps to) requires a
/// writable handle.
pub(crate) fn fsync_file(path: &Path) -> AppResult<()> {
    let file = fs::OpenOptions::new().write(true).open(path).map_err(|e| {
        AppError::fs_error(
            AppErrorCode::FileCopyFailed,
            "failed to open copied file to flush it",
            path,
            &e,
        )
    })?;

    file.sync_all().map_err(|e| {
        AppError::fs_error(
            AppErrorCode::FileCopyFailed,
            "failed to flush copied file to disk",
            path,
            &e,
        )
    })
}

/// Flushes the directory entry a create or rename produced to disk. On common Linux/Unix
/// filesystems a crash right after a create/rename can otherwise lose the new directory entry
/// even though the file's own data was already fsynced, so the file could vanish after a power
/// loss. Shared by `copy_file_atomic` and by the db-backup / library-recovery marker writes and
/// swaps, which need the same directory-entry durability for the files their crash recovery reads.
/// Best effort: any failure is ignored.
#[cfg(unix)]
pub(crate) fn fsync_parent_dir(path: &Path) {
    if let Some(parent) = path.parent() {
        if let Ok(dir) = fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }
}

/// Windows counterpart. `std` cannot open a directory as a `File`, so the handle is obtained via
/// `CreateFileW` with `FILE_FLAG_BACKUP_SEMANTICS` (required to open a directory) and flushed with
/// `FlushFileBuffers`. The same operation `sync_all` performs for a file. This closes the same
/// power-loss window on NTFS with write caching enabled that the Unix path closes; the previous
/// no-op assumed NTFS never needed it, which is not something the code could demonstrate. Best
/// effort: any failure degrades to the previous no-op behavior and is ignored.
#[cfg(windows)]
pub(crate) fn fsync_parent_dir(path: &Path) {
    use std::os::windows::ffi::OsStrExt;

    let Some(parent) = path.parent() else {
        return;
    };

    if parent.as_os_str().is_empty() {
        return;
    }

    let wide: Vec<u16> = parent
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(
            lp_file_name: *const u16,
            dw_desired_access: u32,
            dw_share_mode: u32,
            lp_security_attributes: *mut core::ffi::c_void,
            dw_creation_disposition: u32,
            dw_flags_and_attributes: u32,
            h_template_file: *mut core::ffi::c_void,
        ) -> *mut core::ffi::c_void;
        fn FlushFileBuffers(h_file: *mut core::ffi::c_void) -> i32;
        fn CloseHandle(h_object: *mut core::ffi::c_void) -> i32;
    }

    const GENERIC_READ: u32 = 0x8000_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_SHARE_DELETE: u32 = 0x0000_0004;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

    let invalid_handle = usize::MAX as *mut core::ffi::c_void;

    // SAFETY: lp_file_name is a NUL-terminated UTF-16 buffer that outlives the call; the security
    // and template arguments are null as the API allows. The returned handle is checked against
    // the null/INVALID_HANDLE_VALUE sentinels and always closed before returning.
    unsafe {
        let handle = CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        );

        if handle.is_null() || handle == invalid_handle {
            return;
        }

        let _ = FlushFileBuffers(handle);
        let _ = CloseHandle(handle);
    }
}

#[cfg(not(any(unix, windows)))]
fn fsync_parent_dir(_path: &Path) {}

fn file_paths_have_same_content(left: &Path, right: &Path) -> AppResult<bool> {
    file_paths_have_same_content_using(left, right, None)
}

/// Like [`file_paths_have_same_content`], but reuses a precomputed SHA-256 of `left` when the
/// caller already has it (e.g. a content-addressed import whose destination name was derived from
/// this same hash), so a large `left` file is not hashed a second time. The size check still runs
/// first, and `right` is always hashed, so a `right` file whose bytes no longer match its name
/// (a corrupt library file) is still caught.
fn file_paths_have_same_content_using(
    left: &Path,
    right: &Path,
    left_hash: Option<&str>,
) -> AppResult<bool> {
    if !left.exists() || !right.exists() {
        return Ok(false);
    }

    if !left.is_file() || !right.is_file() {
        return Ok(false);
    }

    let left_metadata = fs::metadata(left).map_err(|e| {
        AppError::fs_error(
            AppErrorCode::SourceMetadataFailed,
            "failed to read left file metadata",
            left,
            &e,
        )
    })?;

    let right_metadata = fs::metadata(right).map_err(|e| {
        AppError::fs_error(
            AppErrorCode::DestinationMetadataFailed,
            "failed to read right file metadata",
            right,
            &e,
        )
    })?;

    if left_metadata.len() != right_metadata.len() {
        return Ok(false);
    }

    let left_digest = match left_hash {
        Some(hash) => hash.to_string(),
        None => file_hash(left)?,
    };

    Ok(left_digest == file_hash(right)?)
}

/// How much of the source is moved per read/write pair by [`copy_file_atomic_cancellable`], and
/// therefore how often it can notice a cancel. 1 MiB is large enough that the syscall overhead
/// stays negligible against the disk, and small enough that a cancel is felt as immediate even on a
/// slow external drive.
const CANCELLABLE_COPY_CHUNK_BYTES: usize = 1024 * 1024;

/// Copies `source` to `temp_destination` with `std::fs::copy`.
///
/// The fast path, and the one every caller but the media import takes. `fs::copy` hands the work to
/// the platform (`copy_file_range`/`sendfile` on Linux, `CopyFileEx` on Windows), which is
/// materially faster than moving the bytes through userspace, and it is also why it cannot be
/// interrupted: it returns when the whole file has been copied and not before.
fn copy_bytes_whole(source: &Path, temp_destination: &Path) -> AppResult<()> {
    fs::copy(source, temp_destination).map(|_| ()).map_err(|e| {
        AppError::fs_error(
            AppErrorCode::FileCopyFailed,
            "failed to copy file",
            temp_destination,
            &e,
        )
    })
}

/// Copies `source` to `temp_destination` a chunk at a time, giving up when `cancel` is set.
///
/// This is the trade [`copy_file_atomic_cancellable`] exists to make, and it is worth stating
/// rather than leaving to be inferred: moving the bytes through userspace is slower than the
/// platform copy above, and it is chosen anyway for the one call site where the file may be tens of
/// gigabytes on a slow drive and the user needs a way out. Everywhere else keeps the fast path.
///
/// Nothing is left behind on a cancel: the partial file lives at the caller's `.tmp-` path, which
/// the caller removes on any error, exactly as it does for a failed copy.
fn copy_bytes_in_chunks(
    source: &Path,
    temp_destination: &Path,
    cancel: Option<&AtomicBool>,
) -> AppResult<()> {
    use std::io::{Read, Write};

    let copy_failed = |e: std::io::Error| {
        AppError::fs_error(
            AppErrorCode::FileCopyFailed,
            "failed to copy file",
            temp_destination,
            &e,
        )
    };

    let mut reader = fs::File::open(source).map_err(|e| {
        AppError::fs_error(
            AppErrorCode::FileOpenFailed,
            "failed to open the source file to copy it",
            source,
            &e,
        )
    })?;

    let mut writer = fs::File::create(temp_destination).map_err(copy_failed)?;
    let mut buffer = vec![0_u8; CANCELLABLE_COPY_CHUNK_BYTES];

    loop {
        // At the top of the loop, so a flag already set when the copy starts stops it before the
        // first chunk rather than after one.
        if crate::utils::hash::is_cancelled(cancel) {
            return Err(AppError::from_code(
                AppErrorCode::MediaImportCancelled,
                "the import was cancelled while copying the file into the library",
            ));
        }

        let read = reader.read(&mut buffer).map_err(copy_failed)?;

        if read == 0 {
            break;
        }

        writer.write_all(&buffer[..read]).map_err(copy_failed)?;
    }

    // Flush userspace buffering into the file before the caller's fsync, which operates on a
    // reopened handle and would otherwise have nothing to push to the platter.
    writer.flush().map_err(copy_failed)?;

    Ok(())
}

/// Copies a file into place atomically, moving the bytes with `copy_bytes`.
///
/// Every guard, the `.tmp-` staging path, the fsync before the rename, the partial-file cleanup on
/// each failure branch and the destination-already-exists recovery live here and only here, so the
/// cancellable variant differs from the plain one in exactly one thing: how the bytes are moved.
/// Splitting it any other way would mean two copies of the logic that decides whether a half-written
/// file can become the live one.
fn copy_file_atomic_with(
    source: &Path,
    destination: &Path,
    copy_bytes: impl FnOnce(&Path, &Path) -> AppResult<()>,
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
        if !destination.is_file() {
            return Err(AppError::from_code(
                AppErrorCode::InvalidDestinationFile,
                "destination path exists but is not a file",
            ));
        }

        if file_paths_have_same_content(source, destination)? {
            return Ok(());
        }

        return Err(AppError::from_code(
            AppErrorCode::DestinationAlreadyExists,
            "destination file already exists",
        ));
    }

    let temp_destination = build_temp_destination_path(destination)?;

    if let Err(error) = copy_bytes(source, &temp_destination) {
        // A failed copy (disk full, antivirus, permissions) can still leave a partial temp file
        // behind, and so can a cancelled one. Remove it here, mirroring the fsync/rename error
        // branches below, so neither a failure nor a cancel ever strands a `.tmp-` scratch file at
        // the destination.
        let _ = fs::remove_file(&temp_destination);
        return Err(error);
    }

    // Flush the copied bytes to disk before the rename. The rename is atomic against a
    // process crash, but without this a power loss could leave a truncated or zero-length
    // file at the destination even after the rename itself was journalled.
    if let Err(error) = fsync_file(&temp_destination) {
        let _ = fs::remove_file(&temp_destination);
        return Err(error);
    }

    match fs::rename(&temp_destination, destination) {
        Ok(_) => {
            // Make the rename itself durable, not just the file data flushed above.
            fsync_parent_dir(destination);
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(&temp_destination);

            if destination.exists() && destination.is_file() {
                if file_paths_have_same_content(source, destination)? {
                    return Ok(());
                }

                return Err(AppError::fs_error(
                    AppErrorCode::DestinationAlreadyExists,
                    "destination file already exists",
                    destination,
                    &error,
                ));
            }

            Err(AppError::fs_error(
                AppErrorCode::FileRenameFailed,
                "failed to finalize copied file",
                destination,
                &error,
            ))
        }
    }
}

/// Copies a file into place atomically. The platform copy, uninterruptible, which is what every
/// caller here wants, since none of them has anyone waiting on a cancel.
pub fn copy_file_atomic(source: &Path, destination: &Path) -> AppResult<()> {
    copy_file_atomic_with(source, destination, copy_bytes_whole)
}

/// Like [`copy_file_atomic`], but abandons the copy when `cancel` is set, leaving nothing behind.
///
/// One caller: the local media import, which is the only copy in this app a user waits on and the
/// only one whose source can be tens of gigabytes. Passing `None` here is not the same as calling
/// [`copy_file_atomic`] (it still takes the slower chunked path), so callers with no flag should
/// use the plain function rather than this one with `None`.
pub fn copy_file_atomic_cancellable(
    source: &Path,
    destination: &Path,
    cancel: Option<&AtomicBool>,
) -> AppResult<()> {
    copy_file_atomic_with(source, destination, |source, temp_destination| {
        copy_bytes_in_chunks(source, temp_destination, cancel)
    })
}

/// Picks the copy the caller is entitled to: the chunked, interruptible one when a cancel flag was
/// offered, and the faster platform copy when it was not. Keeping the dispatch in one place is what
/// lets the move path below take a flag without every non-cancelling caller paying for userspace
/// buffering it has no use for.
fn copy_file_atomic_maybe_cancellable(
    source: &Path,
    destination: &Path,
    cancel: Option<&AtomicBool>,
) -> AppResult<()> {
    match cancel {
        Some(_) => copy_file_atomic_cancellable(source, destination, cancel),
        None => copy_file_atomic(source, destination),
    }
}

pub fn move_or_copy_file(source: &Path, destination: &Path) -> AppResult<()> {
    move_or_copy_file_using(source, destination, None, None)
}

/// Like [`move_or_copy_file`], but reuses a precomputed SHA-256 of `source` for the
/// identical-content check taken when the destination already exists. A caller that has just
/// hashed `source` to derive a content-addressed destination name (the media import) can pass that
/// hash here instead of paying for a second full-file hash of a possibly multi-GB file. All the
/// safety of the plain variant is kept: the same-file guard, the size pre-check, and the hash of
/// the destination (so a corrupt destination whose bytes no longer match its name is still caught).
pub fn move_or_copy_file_with_known_source_hash(
    source: &Path,
    destination: &Path,
    source_hash: &str,
) -> AppResult<()> {
    move_or_copy_file_using(source, destination, Some(source_hash), None)
}

/// Like [`move_or_copy_file_with_known_source_hash`], but abandons the transfer when `cancel` is
/// set.
///
/// Only the cross-device branch can actually be interrupted, and that is the branch worth
/// interrupting: a same-volume move is a `rename`, which is instant, while a move across volumes
/// copies the whole file and is exactly as long as the Copy path. Both are reached from the same
/// import, so the flag covers the mode the user chose either way.
pub fn move_or_copy_file_cancellable(
    source: &Path,
    destination: &Path,
    source_hash: &str,
    cancel: Option<&AtomicBool>,
) -> AppResult<()> {
    move_or_copy_file_using(source, destination, Some(source_hash), cancel)
}

fn move_or_copy_file_using(
    source: &Path,
    destination: &Path,
    source_hash: Option<&str>,
    cancel: Option<&AtomicBool>,
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

    match fs::rename(source, destination) {
        Ok(_) => Ok(()),
        Err(error) if is_cross_device_error(&error) => {
            copy_file_atomic_maybe_cancellable(source, destination, cancel)?;

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
/// This costs a second full-file read, so callers gate it on a genuinely fresh write, never the
/// dedup/skip paths: the guarantee is worth one extra hash on a user-initiated import, not on
/// every no-op re-import of already-stored content.
pub(crate) fn verify_content_addressed_write(
    written: &Path,
    expected_hash: &str,
    prefix: &str,
    ext: &str,
) -> AppResult<PathBuf> {
    let actual_hash = file_hash(written)?;

    if actual_hash == expected_hash {
        return Ok(written.to_path_buf());
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
        // The real content was already stored under its correct name; discard the mis-named copy
        // rather than overwriting the catalogued bytes. Best effort. A failed remove only leaks a
        // reclaimable file, never the correct copy.
        let _ = fs::remove_file(written);
        return Ok(corrected);
    }

    fs::rename(written, &corrected).map_err(|e| {
        AppError::fs_error(
            AppErrorCode::FileRenameFailed,
            "failed to rename a content-addressed file to its verified hash",
            &corrected,
            &e,
        )
    })?;

    Ok(corrected)
}

pub fn replace_file_safely(source: &Path, destination: &Path) -> AppResult<()> {
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

    if !destination.exists() {
        return move_or_copy_file(source, destination);
    }

    if !destination.is_file() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidDestinationFile,
            "destination path exists but is not a file",
        ));
    }

    let backup_name = format!(
        ".{}.backup-{}",
        destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("file"),
        unique_temp_suffix()
    );

    let backup_path = parent.join(backup_name);

    match fs::rename(destination, &backup_path) {
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return move_or_copy_file(source, destination);
        }
        Err(error) => {
            return Err(AppError::fs_error(
                AppErrorCode::DestinationBackupFailed,
                "failed to create destination backup before replace",
                &backup_path,
                &error,
            ));
        }
    }

    match move_or_copy_file(source, destination) {
        Ok(_) => {
            let _ = fs::remove_file(&backup_path);
            Ok(())
        }
        Err(error) => {
            let restore_result = fs::rename(&backup_path, destination);

            if let Err(restore_error) = restore_result {
                return Err(AppError::from_code(
                    AppErrorCode::DestinationRestoreFailed,
                    format!(
                        "failed to replace destination: {}. backup restore also failed: {}",
                        error.message, restore_error
                    ),
                ));
            }

            Err(error)
        }
    }
}

pub fn clean_matching_files_in_dir(dir: &Path, prefix: &str) -> AppResult<()> {
    if !dir.exists() {
        return Ok(());
    }

    if !dir.is_dir() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidDirectoryPath,
            "target path is not a directory",
        ));
    }

    for entry in fs::read_dir(dir).map_err(|e| {
        AppError::fs_error(
            AppErrorCode::ReadDirFailed,
            "failed to read directory",
            dir,
            &e,
        )
    })? {
        let entry = entry.map_err(|e| {
            AppError::fs_error(
                AppErrorCode::ReadDirEntryFailed,
                "failed to read directory entry",
                dir,
                &e,
            )
        })?;

        let path = entry.path();

        let matches_prefix = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with(prefix))
            .unwrap_or(false);

        if matches_prefix && path.is_file() {
            let _ = fs::remove_file(path);
        }
    }

    Ok(())
}

fn file_modified_sort_key(path: &Path) -> SystemTime {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

fn alternative_destination_path(path: &Path) -> AppResult<PathBuf> {
    let parent = path.parent().ok_or_else(|| {
        AppError::from_code(
            AppErrorCode::InvalidDestinationPath,
            "destination path has no parent directory",
        )
    })?;

    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("file");

    let extension = path.extension().and_then(|value| value.to_str());

    let suffix = unique_temp_suffix();

    let file_name = match extension {
        Some(ext) if !ext.trim().is_empty() => format!("{stem}.migrated-{suffix}.{ext}"),
        _ => format!("{stem}.migrated-{suffix}"),
    };

    Ok(parent.join(file_name))
}

pub fn find_latest_matching_file(dir: &Path, prefix: &str) -> AppResult<PathBuf> {
    if !dir.exists() || !dir.is_dir() {
        return Err(AppError::from_code(
            AppErrorCode::MatchingFileNotFound,
            "matching file was not found",
        ));
    }

    fs::read_dir(dir)
        .map_err(|e| {
            AppError::fs_error(
                AppErrorCode::ReadDirFailed,
                "failed to read directory",
                dir,
                &e,
            )
        })?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.starts_with(prefix))
                    .unwrap_or(false)
        })
        .max_by_key(|path| file_modified_sort_key(path))
        .ok_or_else(|| {
            AppError::from_code(
                AppErrorCode::MatchingFileNotFound,
                "matching file was not found",
            )
        })
}

pub fn find_unique_matching_file(dir: &Path, prefix: &str) -> AppResult<PathBuf> {
    if !dir.exists() || !dir.is_dir() {
        return Err(AppError::from_code(
            AppErrorCode::MatchingFileNotFound,
            "matching file was not found",
        ));
    }

    let mut matches: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| {
            AppError::fs_error(
                AppErrorCode::ReadDirFailed,
                "failed to read directory",
                dir,
                &e,
            )
        })?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.starts_with(prefix))
                    .unwrap_or(false)
        })
        .collect();

    matches.sort_by_key(|path| std::cmp::Reverse(file_modified_sort_key(path)));

    match matches.len() {
        0 => Err(AppError::from_code(
            AppErrorCode::MatchingFileNotFound,
            "matching file was not found",
        )),
        1 => Ok(matches.remove(0)),
        _ => Err(AppError::from_code(
            AppErrorCode::MultipleMatchingFilesFound,
            "multiple matching files were found when only one was expected",
        )),
    }
}

pub fn find_best_matching_file(
    dir: &Path,
    prefix: &str,
    preferred_ext: Option<&str>,
) -> AppResult<PathBuf> {
    if !dir.exists() || !dir.is_dir() {
        return Err(AppError::from_code(
            AppErrorCode::MatchingFileNotFound,
            "matching file was not found",
        ));
    }

    let normalized_preferred_ext = preferred_ext
        .map(|value| value.trim().trim_start_matches('.').to_lowercase())
        .filter(|value| !value.is_empty());

    let mut matches: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| {
            AppError::fs_error(
                AppErrorCode::ReadDirFailed,
                "failed to read directory",
                dir,
                &e,
            )
        })?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.starts_with(prefix))
                    .unwrap_or(false)
        })
        .collect();

    if matches.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::MatchingFileNotFound,
            "matching file was not found",
        ));
    }

    matches.sort_by(|left, right| {
        let left_ext = left
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.trim().trim_start_matches('.').to_lowercase());

        let right_ext = right
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.trim().trim_start_matches('.').to_lowercase());

        let left_pref = normalized_preferred_ext
            .as_ref()
            .map(|preferred| left_ext.as_ref() == Some(preferred))
            .unwrap_or(false);

        let right_pref = normalized_preferred_ext
            .as_ref()
            .map(|preferred| right_ext.as_ref() == Some(preferred))
            .unwrap_or(false);

        right_pref
            .cmp(&left_pref)
            .then_with(|| file_modified_sort_key(right).cmp(&file_modified_sort_key(left)))
    });

    Ok(matches.remove(0))
}

/// True when a directory entry is a symbolic link, read from the entry's own type without
/// following it. Recursive directory scans use this to refuse to descend into a symlinked
/// directory: one pointing at an ancestor (or itself) would otherwise recurse forever, and the
/// library never creates symlinks of its own, so skipping any it finds loses nothing legitimate
/// while making a hand-edited or cloud-synced library that contains one safe to walk.
pub(crate) fn dir_entry_is_symlink(entry: &fs::DirEntry) -> bool {
    entry
        .file_type()
        .map(|file_type| file_type.is_symlink())
        .unwrap_or(false)
}

pub fn copy_directory_contents(source_dir: &Path, destination_dir: &Path) -> AppResult<()> {
    if !source_dir.exists() {
        return Ok(());
    }

    if !source_dir.is_dir() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidSourceDirectory,
            "source directory path is not a directory",
        ));
    }

    fs::create_dir_all(destination_dir).map_err(|e| {
        AppError::fs_error(
            AppErrorCode::CreateDirectoryFailed,
            "failed to create directory",
            destination_dir,
            &e,
        )
    })?;

    for entry in fs::read_dir(source_dir).map_err(|e| {
        AppError::fs_error(
            AppErrorCode::ReadDirFailed,
            "failed to read directory",
            source_dir,
            &e,
        )
    })? {
        let entry = entry.map_err(|e| {
            AppError::fs_error(
                AppErrorCode::ReadDirEntryFailed,
                "failed to read directory entry",
                source_dir,
                &e,
            )
        })?;

        // Skip symlinks before any is_dir()/is_file() check (both follow the link): a symlinked
        // directory would let the recursion escape the tree or loop forever.
        if dir_entry_is_symlink(&entry) {
            continue;
        }

        let source_path = entry.path();
        let destination_path = destination_dir.join(entry.file_name());

        if source_path.is_dir() {
            copy_directory_contents(&source_path, &destination_path)?;
            continue;
        }

        if !source_path.is_file() {
            continue;
        }

        copy_file_atomic(&source_path, &destination_path)?;
    }

    Ok(())
}

pub fn migrate_directory_contents(source_dir: &Path, destination_dir: &Path) -> AppResult<()> {
    if !source_dir.exists() {
        return Ok(());
    }

    if !source_dir.is_dir() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidSourceDirectory,
            "source directory path is not a directory",
        ));
    }

    fs::create_dir_all(destination_dir).map_err(|e| {
        AppError::fs_error(
            AppErrorCode::CreateDirectoryFailed,
            "failed to create directory",
            destination_dir,
            &e,
        )
    })?;

    for entry in fs::read_dir(source_dir).map_err(|e| {
        AppError::fs_error(
            AppErrorCode::ReadDirFailed,
            "failed to read directory",
            source_dir,
            &e,
        )
    })? {
        let entry = entry.map_err(|e| {
            AppError::fs_error(
                AppErrorCode::ReadDirEntryFailed,
                "failed to read directory entry",
                source_dir,
                &e,
            )
        })?;

        // Skip symlinks before any is_dir()/is_file() check (both follow the link): a symlinked
        // directory would let the recursion escape the tree or loop forever, and it must never be
        // removed as if it were a real subdirectory of the library being migrated.
        if dir_entry_is_symlink(&entry) {
            continue;
        }

        let source_path = entry.path();
        let destination_path = destination_dir.join(entry.file_name());

        if source_path.is_dir() {
            migrate_directory_contents(&source_path, &destination_path)?;

            if let Err(error) = fs::remove_dir(&source_path) {
                if error.kind() != ErrorKind::NotFound {
                    eprintln!(
                        "skipping non-empty or locked source directory removal during migration: {} ({})",
                        source_path.to_string_lossy(),
                        error
                    );
                }
            }

            continue;
        }

        if !source_path.is_file() {
            continue;
        }

        if destination_path.exists() {
            if !destination_path.is_file() {
                return Err(AppError::from_code(
                    AppErrorCode::InvalidDestinationFile,
                    "destination path exists but is not a file",
                ));
            }

            if file_paths_have_same_content(&source_path, &destination_path)? {
                let _ = fs::remove_file(&source_path);
                continue;
            }

            let renamed_destination = alternative_destination_path(&destination_path)?;
            move_or_copy_file(&source_path, &renamed_destination)?;
            continue;
        }

        move_or_copy_file(&source_path, &destination_path)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;
    use std::time::Duration;

    #[test]
    fn the_cancellable_copy_chunk_is_one_mebibyte() {
        // Pinned by value rather than re-derived from the same multiplication the constant uses,
        // matching `the_live_chat_decompression_ceiling_is_512_mib` in `live_chat_storage`. An
        // arithmetic slip here is invisible to every behavioral test: 1024 + 1024 is 2048 bytes and
        // 1024 / 1024 is 1, and a copy still produces a byte-identical destination at any of those
        // sizes. What changes is only how often a cancel can be noticed. A one-byte chunk turns
        // the cancellable import into a syscall per byte, which is a hang the user reads as a
        // freeze rather than as a slow copy. A literal is the only thing that catches it.
        assert_eq!(CANCELLABLE_COPY_CHUNK_BYTES, 1_048_576);
    }

    /// How many `.tmp-` staging files the copy left behind in `dir`. A cancel that stranded one
    /// would be invisible to an assertion on the destination alone, and the whole point of staging
    /// through a sibling is that nothing survives a copy that did not finish.
    fn staging_files_in(dir: &Path) -> usize {
        std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
                    .count()
            })
            .unwrap_or(0)
    }

    #[test]
    fn a_cancelled_copy_leaves_neither_a_destination_nor_a_staging_file() {
        // The property the whole staging design rests on, applied to the new exit. A cancel is the
        // one failure that arrives while the temp file is perfectly healthy (it is simply
        // incomplete), so the branch that removes it has to fire for a cancel exactly as it does
        // for a disk-full or a permission error. Leaving a partial `.tmp-` behind would strand
        // scratch in the user's library; leaving the destination behind would be far worse, since
        // its name is a content hash of bytes it does not hold.
        let dir = unique_test_dir();
        std::fs::create_dir_all(&dir).unwrap();

        let source = dir.join("source.mp4");
        std::fs::write(&source, b"some media bytes").unwrap();
        let destination = dir.join("video").join("media_abc.mp4");

        let cancel = AtomicBool::new(true);
        let error = copy_file_atomic_cancellable(&source, &destination, Some(&cancel)).unwrap_err();

        assert_eq!(error.code, AppErrorCode::MediaImportCancelled.as_str());
        assert!(
            !destination.exists(),
            "a cancelled copy must produce nothing"
        );
        assert_eq!(
            staging_files_in(destination.parent().unwrap()),
            0,
            "a cancelled copy must not strand its staging file"
        );
        assert!(
            source.exists(),
            "a cancelled copy must not touch the source"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_cancellable_copy_produces_the_same_file_as_the_plain_one() {
        // The chunked loop replaces `fs::copy` on this path, so it has to be byte-for-byte
        // equivalent. A content-addressed name is a hash of these bytes, so a copy that dropped or
        // duplicated a chunk would store a file under a name that no longer describes it, and every
        // later lookup by hash would miss it. Sized past one chunk on purpose: a single-chunk file
        // would pass even if the loop only ever ran once.
        let dir = unique_test_dir();
        std::fs::create_dir_all(&dir).unwrap();

        let payload: Vec<u8> = (0..(CANCELLABLE_COPY_CHUNK_BYTES * 2 + 1234))
            .map(|index| (index % 251) as u8)
            .collect();

        let source = dir.join("source.mp4");
        std::fs::write(&source, &payload).unwrap();

        let chunked = dir.join("chunked.mp4");
        let whole = dir.join("whole.mp4");

        let cancel = AtomicBool::new(false);
        copy_file_atomic_cancellable(&source, &chunked, Some(&cancel)).unwrap();
        copy_file_atomic(&source, &whole).unwrap();

        assert_eq!(std::fs::read(&chunked).unwrap(), payload);
        assert_eq!(
            std::fs::read(&chunked).unwrap(),
            std::fs::read(&whole).unwrap()
        );
        assert_eq!(file_hash(&chunked).unwrap(), file_hash(&source).unwrap());
        assert_eq!(staging_files_in(&dir), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn unique_test_dir() -> PathBuf {
        // Via unique_temp_suffix rather than pid + nanos: that pair is not collision-proof, because
        // tests run concurrently and share the pid, so two calls landing in the same nanosecond (more
        // likely on a coarser macOS timer) would get the same directory and clobber each other's
        // files. A real intermittent CI failure. The suffix's monotonic counter is what makes every
        // call distinct regardless of timer resolution.
        std::env::temp_dir().join(format!(
            "kavynex-filesystem-test-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    #[test]
    fn verify_content_addressed_write_keeps_a_matching_name() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        let content = b"the real bytes";
        let scratch = dir.join("scratch");
        fs::write(&scratch, content).unwrap();
        let hash = file_hash(&scratch).unwrap();
        let _ = fs::remove_file(&scratch);

        let written = dir.join(format!("media_{hash}.mp4"));
        fs::write(&written, content).unwrap();

        // The name already matches the content, so nothing moves.
        let result = verify_content_addressed_write(&written, &hash, "media", "mp4").unwrap();
        assert_eq!(result, written);
        assert!(written.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_content_addressed_write_corrects_a_name_built_from_a_stale_hash() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        // The name was built from a hash of the source taken before the write, but the bytes that
        // actually landed differ (a source changed in the TOCTOU window).
        let written = dir.join("media_stalehash.mp4");
        fs::write(&written, b"the bytes that actually landed").unwrap();
        let actual = file_hash(&written).unwrap();

        let result = verify_content_addressed_write(&written, "stalehash", "media", "mp4").unwrap();

        let corrected = dir.join(format!("media_{actual}.mp4"));
        assert_eq!(result, corrected);
        assert!(
            corrected.exists(),
            "the file must be renamed to its real hash"
        );
        assert!(!written.exists(), "the mis-named file must be gone");
        assert_eq!(
            fs::read(&corrected).unwrap(),
            b"the bytes that actually landed"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_content_addressed_write_drops_a_mis_named_copy_when_the_correct_name_exists() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        let content = b"already-catalogued bytes";
        let mis_named = dir.join("media_stalehash.mp4");
        fs::write(&mis_named, content).unwrap();
        let actual = file_hash(&mis_named).unwrap();

        // The real content was already stored under its correct name before this fresh, mis-named
        // copy landed, so the mis-named one is dropped rather than overwriting the catalogued bytes.
        let correct = dir.join(format!("media_{actual}.mp4"));
        fs::write(&correct, content).unwrap();

        let result =
            verify_content_addressed_write(&mis_named, "stalehash", "media", "mp4").unwrap();

        assert_eq!(result, correct);
        assert!(
            !mis_named.exists(),
            "the redundant mis-named copy must be dropped"
        );
        assert!(correct.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    // Symlink creation is unprivileged on Unix but needs Developer Mode/admin on Windows, so the
    // cycle-safety test runs on Unix only. The guarded code (`dir_entry_is_symlink`) is
    // platform-independent; this exercises it where a symlink can always be created.
    #[cfg(unix)]
    #[test]
    fn copy_directory_contents_does_not_follow_a_symlink_cycle() {
        use std::os::unix::fs::symlink;

        let base = unique_test_dir();
        let source = base.join("source");
        let nested = source.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(source.join("real.txt"), b"data").unwrap();

        // A symlink inside the tree pointing back at its own root: following it would recurse
        // forever. Without the symlink guard this call would overflow the stack rather than return.
        symlink(&source, nested.join("loop")).unwrap();

        let destination = base.join("destination");
        copy_directory_contents(&source, &destination).unwrap();

        // The real file is copied; the symlink is skipped, so no `loop` entry is carried over.
        assert!(destination.join("real.txt").is_file());
        assert!(!destination.join("nested").join("loop").exists());

        let _ = fs::remove_dir_all(&base);
    }

    /// Names of the `.<file>.backup-<suffix>` scratch files `replace_file_safely` creates, so a
    /// test can assert it cleaned up after itself rather than leaving one in the library.
    fn leftover_backup_names(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(".backup-"))
            .collect()
    }

    // The guard these three functions exist for: a destination that already holds *different*
    // bytes is someone else's file, and must come back as an error with the file untouched. Only
    // the identical-content path may proceed. A flipped comparison here would not fail loudly (// it would silently overwrite a file in the user's library), so each test asserts the
    // destination's bytes are unchanged, not just that an error came back.

    #[test]
    fn copy_file_atomic_rejects_a_destination_holding_different_content() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        let source = dir.join("source.mp4");
        let destination = dir.join("destination.mp4");
        fs::write(&source, b"incoming bytes").unwrap();
        fs::write(&destination, b"an existing user file").unwrap();

        let error = copy_file_atomic(&source, &destination).unwrap_err();

        assert_eq!(error.code, AppErrorCode::DestinationAlreadyExists.as_str());
        assert_eq!(fs::read(&destination).unwrap(), b"an existing user file");
        assert!(
            source.exists(),
            "a rejected copy must not consume the source"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn move_or_copy_file_rejects_a_destination_holding_different_content() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        let source = dir.join("source.mp4");
        let destination = dir.join("destination.mp4");
        fs::write(&source, b"incoming bytes").unwrap();
        fs::write(&destination, b"an existing user file").unwrap();

        let error = move_or_copy_file(&source, &destination).unwrap_err();

        assert_eq!(error.code, AppErrorCode::DestinationAlreadyExists.as_str());
        assert_eq!(fs::read(&destination).unwrap(), b"an existing user file");
        // A move that refused to happen must leave the source in place: removing it here would
        // destroy the only copy of the file the caller asked to move.
        assert!(
            source.exists(),
            "a rejected move must not consume the source"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn replace_file_safely_moves_the_source_in_when_no_destination_exists() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        let source = dir.join("source.json");
        let destination = dir.join("nested").join("destination.json");
        fs::write(&source, b"fresh content").unwrap();

        replace_file_safely(&source, &destination).unwrap();

        assert_eq!(fs::read(&destination).unwrap(), b"fresh content");
        assert!(
            !source.exists(),
            "the source should have been moved, not copied"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn replace_file_safely_overwrites_an_existing_destination_and_leaves_no_backup() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        let source = dir.join("source.json");
        let destination = dir.join("destination.json");
        fs::write(&source, b"new content").unwrap();
        fs::write(&destination, b"stale content").unwrap();

        replace_file_safely(&source, &destination).unwrap();

        assert_eq!(fs::read(&destination).unwrap(), b"new content");
        // Unlike copy_file_atomic/move_or_copy_file, this one is *meant* to replace differing
        // content. That is the whole point of the backup dance. What it must not do is leave the
        // scratch backup behind once the replace succeeded.
        assert_eq!(leftover_backup_names(&dir), Vec::<String>::new());

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn replace_file_safely_restores_the_original_when_the_replace_fails() {
        // The branch that justifies the backup dance existing at all: the destination has already
        // been renamed aside when the replace fails, so without the restore the user is left with
        // no file at all where their data used to be.
        //
        // Unix-only because making the replace fail *after* the backup succeeded needs the rename
        // of the source to be refused, which means taking write permission off the source's own
        // directory. The destination's directory has to stay writable for the backup and the
        // restore themselves. Windows has no portable equivalent (its read-only attribute does not
        // block a rename), so this branch is covered on Linux/macOS CI only.
        use std::os::unix::fs::PermissionsExt;

        let dir = unique_test_dir();
        let source_dir = dir.join("source-dir");
        let destination_dir = dir.join("destination-dir");
        fs::create_dir_all(&source_dir).unwrap();
        fs::create_dir_all(&destination_dir).unwrap();

        let source = source_dir.join("source.json");
        let destination = destination_dir.join("destination.json");
        fs::write(&source, b"new content").unwrap();
        fs::write(&destination, b"the original file").unwrap();

        // Renaming a file out of a directory needs write permission on that directory.
        fs::set_permissions(&source_dir, fs::Permissions::from_mode(0o555)).unwrap();

        let error = replace_file_safely(&source, &destination).unwrap_err();

        // The original error is reported, not a restore failure.
        assert_eq!(error.code, AppErrorCode::FileMoveFailed.as_str());
        // What actually matters: the destination is back, byte for byte, and no backup is orphaned.
        assert_eq!(fs::read(&destination).unwrap(), b"the original file");
        assert_eq!(
            leftover_backup_names(&destination_dir),
            Vec::<String>::new()
        );

        fs::set_permissions(&source_dir, fs::Permissions::from_mode(0o755)).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_best_matching_file_prefers_requested_extension() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        let png = dir.join("thumb_test.png");
        let jpg = dir.join("thumb_test.jpg");

        fs::write(&jpg, b"jpg").unwrap();
        sleep(Duration::from_millis(5));
        fs::write(&png, b"png").unwrap();

        let found = find_best_matching_file(&dir, "thumb_test.", Some("png")).unwrap();
        assert_eq!(
            found.file_name().unwrap().to_string_lossy(),
            "thumb_test.png"
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn find_best_matching_file_falls_back_to_most_recent_when_preferred_missing() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        let older = dir.join("media_test.webm");
        let newer = dir.join("media_test.mkv");

        fs::write(&older, b"older").unwrap();
        sleep(Duration::from_millis(5));
        fs::write(&newer, b"newer").unwrap();

        let found = find_best_matching_file(&dir, "media_test.", Some("mp4")).unwrap();
        assert_eq!(
            found.file_name().unwrap().to_string_lossy(),
            "media_test.mkv"
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn find_best_matching_file_returns_error_when_no_match_exists() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        let result = find_best_matching_file(&dir, "missing_prefix.", Some("png"));
        assert!(result.is_err());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn find_best_matching_file_prefers_the_extension_over_a_newer_non_preferred_file() {
        // The existing preference test writes the preferred file last, so recency alone would pick
        // it too, which lets a flipped preference comparison slip through. Make the preferred file
        // the *older* one so preference has to beat recency, pinning that comparison.
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        let png = dir.join("thumb_x.png");
        let jpg = dir.join("thumb_x.jpg");
        fs::write(&png, b"png").unwrap(); // preferred, but older
        sleep(Duration::from_millis(20));
        fs::write(&jpg, b"jpg").unwrap(); // newer, not preferred

        let found = find_best_matching_file(&dir, "thumb_x.", Some("png")).unwrap();
        assert_eq!(found.file_name().unwrap().to_string_lossy(), "thumb_x.png");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn matching_helpers_ignore_a_prefix_named_subdirectory() {
        // A subdirectory whose name starts with the prefix is not a "matching file": the filters
        // pair starts_with(prefix) with is_file(). The directory is made *newer* than the file, so
        // a filter that dropped the is_file() half (matching the directory too) would return or
        // count it. Each helper must still resolve to the file.
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("media_x.mp4");
        fs::write(&file, b"real").unwrap();
        sleep(Duration::from_millis(20));
        fs::create_dir_all(dir.join("media_x_dir")).unwrap();

        assert_eq!(find_latest_matching_file(&dir, "media_x").unwrap(), file);
        assert_eq!(find_unique_matching_file(&dir, "media_x").unwrap(), file);
        assert_eq!(
            find_best_matching_file(&dir, "media_x", None).unwrap(),
            file
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn matching_helpers_reject_a_non_directory_path() {
        // A path that exists but is a file must come back as the catalogued MatchingFileNotFound,
        // not an attempt to read it as a directory (which would surface a different error).
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("not_a_dir");
        fs::write(&file, b"x").unwrap();

        for result in [
            find_latest_matching_file(&file, "x"),
            find_unique_matching_file(&file, "x"),
            find_best_matching_file(&file, "x", None),
        ] {
            let error = result.expect_err("a file path is not a searchable directory");
            assert_eq!(error.code, AppErrorCode::MatchingFileNotFound.as_str());
        }

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn find_latest_matching_file_returns_the_most_recent_match() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();
        let older = dir.join("run_a.log");
        let newer = dir.join("run_b.log");
        fs::write(&older, b"a").unwrap();
        sleep(Duration::from_millis(20));
        fs::write(&newer, b"b").unwrap();

        assert_eq!(find_latest_matching_file(&dir, "run_").unwrap(), newer);
        assert!(find_latest_matching_file(&dir, "none_").is_err());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn find_unique_matching_file_distinguishes_none_one_and_many() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        // None: the catalogued not-found code, not a silent success.
        let none = find_unique_matching_file(&dir, "only_").unwrap_err();
        assert_eq!(none.code, AppErrorCode::MatchingFileNotFound.as_str());

        // Exactly one: returned.
        let one = dir.join("only_1.txt");
        fs::write(&one, b"1").unwrap();
        assert_eq!(find_unique_matching_file(&dir, "only_").unwrap(), one);

        // Two: the distinct multiple-match error, never a quiet pick of one.
        fs::write(dir.join("only_2.txt"), b"2").unwrap();
        let many = find_unique_matching_file(&dir, "only_").unwrap_err();
        assert_eq!(many.code, AppErrorCode::MultipleMatchingFilesFound.as_str());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn clean_matching_files_in_dir_removes_only_prefix_matches() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();
        let matching = dir.join("tmp_a");
        let other = dir.join("keep_b");
        fs::write(&matching, b"a").unwrap();
        fs::write(&other, b"b").unwrap();

        clean_matching_files_in_dir(&dir, "tmp_").unwrap();

        assert!(!matching.exists(), "a prefix match must be removed");
        assert!(other.exists(), "a non-matching file must be left alone");

        // A missing directory is a no-op, not an error.
        clean_matching_files_in_dir(&unique_test_dir(), "tmp_").unwrap();

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn copy_file_atomic_writes_destination_with_source_content() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        let source = dir.join("source.bin");
        // A nested destination whose parent does not exist yet, to also cover create_dir_all.
        let destination = dir.join("nested").join("copied.bin");

        fs::write(&source, b"durable-bytes").unwrap();

        copy_file_atomic(&source, &destination).unwrap();

        assert!(destination.exists());
        assert_eq!(fs::read(&destination).unwrap(), b"durable-bytes");
        // The source must remain in place (copy, not move).
        assert!(source.exists());
        // No leftover temp file next to the destination.
        let leftover_temp = fs::read_dir(destination.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".copied.bin.tmp-")
            });
        assert!(!leftover_temp, "temp file should have been renamed away");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn copy_file_atomic_is_idempotent_when_destination_already_has_same_content() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        let source = dir.join("source.txt");
        let destination = dir.join("destination.txt");

        fs::write(&source, b"same-content").unwrap();
        fs::write(&destination, b"same-content").unwrap();

        let result = copy_file_atomic(&source, &destination);
        assert!(result.is_ok());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn find_unique_matching_file_returns_single_match() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        let target = dir.join("media_abc.mp4");
        fs::write(&target, b"abc").unwrap();

        let result = find_unique_matching_file(&dir, "media_").unwrap();

        assert_eq!(
            result.file_name().and_then(|v| v.to_str()),
            Some("media_abc.mp4")
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn find_unique_matching_file_rejects_multiple_matches() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        fs::write(dir.join("media_a.mp4"), b"a").unwrap();
        fs::write(dir.join("media_b.mp4"), b"b").unwrap();

        let result = find_unique_matching_file(&dir, "media_");

        assert!(result.is_err());
        assert_eq!(
            result.err().unwrap().code,
            AppErrorCode::MultipleMatchingFilesFound.as_str()
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn find_best_matching_file_prefers_extension_when_available() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        fs::write(dir.join("video_001.webm"), b"webm").unwrap();
        fs::write(dir.join("video_001.mp4"), b"mp4").unwrap();

        let result = find_best_matching_file(&dir, "video_001.", Some("mp4")).unwrap();

        assert_eq!(
            result.file_name().and_then(|v| v.to_str()),
            Some("video_001.mp4")
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn migrate_directory_contents_moves_files_recursively() {
        let source_dir = unique_test_dir();
        let destination_dir = unique_test_dir();

        let nested_source = source_dir.join("nested");
        fs::create_dir_all(&nested_source).unwrap();

        fs::write(source_dir.join("root.txt"), b"root").unwrap();
        fs::write(nested_source.join("child.txt"), b"child").unwrap();

        migrate_directory_contents(&source_dir, &destination_dir).unwrap();

        assert!(destination_dir.join("root.txt").exists());
        assert!(destination_dir.join("nested").join("child.txt").exists());

        let _ = fs::remove_dir_all(source_dir);
        let _ = fs::remove_dir_all(destination_dir);
    }

    #[test]
    fn migrate_directory_contents_renames_when_destination_file_exists_with_different_content() {
        let source_dir = unique_test_dir();
        let destination_dir = unique_test_dir();

        fs::create_dir_all(&source_dir).unwrap();
        fs::create_dir_all(&destination_dir).unwrap();

        fs::write(source_dir.join("same_name.txt"), b"source-content").unwrap();
        fs::write(
            destination_dir.join("same_name.txt"),
            b"destination-content",
        )
        .unwrap();

        migrate_directory_contents(&source_dir, &destination_dir).unwrap();

        let mut migrated_variants = fs::read_dir(&destination_dir)
            .unwrap()
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .filter(|path| {
                path.file_name()
                    .and_then(|v| v.to_str())
                    .map(|name| name.starts_with("same_name.migrated-"))
                    .unwrap_or(false)
            })
            .collect::<Vec<_>>();

        migrated_variants.sort();

        assert!(destination_dir.join("same_name.txt").exists());
        assert_eq!(migrated_variants.len(), 1);

        let migrated = migrated_variants.remove(0);
        // The alternative name preserves the original extension, so the migrated copy stays a usable
        // .txt rather than an extension-less file (pins the ext guard in alternative_destination_path).
        assert!(
            migrated
                .file_name()
                .and_then(|v| v.to_str())
                .is_some_and(|name| name.ends_with(".txt")),
            "migrated variant must keep the .txt extension: {migrated:?}"
        );

        let migrated_content = fs::read(&migrated).unwrap();
        assert_eq!(migrated_content, b"source-content");

        let _ = fs::remove_dir_all(source_dir);
        let _ = fs::remove_dir_all(destination_dir);
    }

    #[test]
    fn migrate_directory_contents_removes_source_when_destination_has_same_content() {
        let source_dir = unique_test_dir();
        let destination_dir = unique_test_dir();

        fs::create_dir_all(&source_dir).unwrap();
        fs::create_dir_all(&destination_dir).unwrap();

        let source_file = source_dir.join("same.txt");
        let destination_file = destination_dir.join("same.txt");

        fs::write(&source_file, b"identical-content").unwrap();
        fs::write(&destination_file, b"identical-content").unwrap();

        migrate_directory_contents(&source_dir, &destination_dir).unwrap();

        assert!(!source_file.exists());
        assert!(destination_file.exists());

        let _ = fs::remove_dir_all(source_dir);
        let _ = fs::remove_dir_all(destination_dir);
    }

    #[test]
    fn migrate_directory_contents_rejects_non_directory_source() {
        let source_dir = unique_test_dir();
        let destination_dir = unique_test_dir();

        fs::create_dir_all(&destination_dir).unwrap();
        fs::write(&source_dir, b"not-a-directory").unwrap();

        let result = migrate_directory_contents(&source_dir, &destination_dir);

        assert!(result.is_err());
        assert_eq!(
            result.err().unwrap().code,
            AppErrorCode::InvalidSourceDirectory.as_str()
        );

        let _ = fs::remove_file(source_dir);
        let _ = fs::remove_dir_all(destination_dir);
    }

    #[test]
    fn copy_directory_contents_copies_files_without_deleting_source() {
        let source_dir = unique_test_dir();
        let destination_dir = unique_test_dir();

        let nested = source_dir.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(source_dir.join("root.txt"), b"root").unwrap();
        fs::write(nested.join("child.txt"), b"child").unwrap();

        copy_directory_contents(&source_dir, &destination_dir).unwrap();

        assert!(destination_dir.join("root.txt").exists());
        assert!(destination_dir.join("nested").join("child.txt").exists());

        // source must remain intact
        assert!(source_dir.join("root.txt").exists());
        assert!(nested.join("child.txt").exists());

        let _ = fs::remove_dir_all(source_dir);
        let _ = fs::remove_dir_all(destination_dir);
    }

    #[test]
    fn copy_directory_contents_is_idempotent_for_same_content() {
        let source_dir = unique_test_dir();
        let destination_dir = unique_test_dir();

        fs::create_dir_all(&source_dir).unwrap();
        fs::write(source_dir.join("a.txt"), b"same").unwrap();
        fs::create_dir_all(&destination_dir).unwrap();
        fs::write(destination_dir.join("a.txt"), b"same").unwrap();

        // second copy of the same file is a no-op, not an error
        copy_directory_contents(&source_dir, &destination_dir).unwrap();

        assert!(source_dir.join("a.txt").exists());
        assert!(destination_dir.join("a.txt").exists());

        let _ = fs::remove_dir_all(source_dir);
        let _ = fs::remove_dir_all(destination_dir);
    }

    #[test]
    fn copy_directory_contents_returns_ok_when_source_does_not_exist() {
        let source_dir = unique_test_dir();
        let destination_dir = unique_test_dir();

        let result = copy_directory_contents(&source_dir, &destination_dir);
        assert!(result.is_ok());

        let _ = fs::remove_dir_all(destination_dir);
    }

    #[test]
    fn copy_directory_contents_rejects_non_directory_source() {
        let source_dir = unique_test_dir();
        let destination_dir = unique_test_dir();

        fs::create_dir_all(&destination_dir).unwrap();
        fs::write(&source_dir, b"not-a-directory").unwrap();

        let result = copy_directory_contents(&source_dir, &destination_dir);
        assert!(result.is_err());
        assert_eq!(
            result.err().unwrap().code,
            AppErrorCode::InvalidSourceDirectory.as_str()
        );

        let _ = fs::remove_file(source_dir);
        let _ = fs::remove_dir_all(destination_dir);
    }

    #[test]
    fn move_or_copy_file_is_noop_when_source_equals_destination() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        let file = dir.join("media_hash.mp4");
        fs::write(&file, b"the only copy").unwrap();

        // Moving a file onto itself must never delete it.
        move_or_copy_file(&file, &file).unwrap();

        assert!(file.exists());
        assert_eq!(fs::read(&file).unwrap(), b"the only copy");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn move_or_copy_file_removes_source_when_destination_has_same_content() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        let source = dir.join("source.mp4");
        let destination = dir.join("media_hash.mp4");
        fs::write(&source, b"same bytes").unwrap();
        fs::write(&destination, b"same bytes").unwrap();

        // Distinct paths with identical content: the source is a redundant duplicate and is
        // removed, leaving the destination intact.
        move_or_copy_file(&source, &destination).unwrap();

        assert!(!source.exists());
        assert!(destination.exists());
        assert_eq!(fs::read(&destination).unwrap(), b"same bytes");

        let _ = fs::remove_dir_all(dir);
    }
}
