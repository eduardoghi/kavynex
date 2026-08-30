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
/// Best effort. Any failure is ignored.
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
/// effort. Any failure degrades to the previous no-op behavior and is ignored.
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
/// interrupted. It returns when the whole file has been copied and not before.
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
/// rather than leaving to be inferred. Moving the bytes through userspace is slower than the
/// platform copy above, and it is chosen anyway for the one call site where the file may be tens of
/// gigabytes on a slow drive and the user needs a way out. Everywhere else keeps the fast path.
///
/// Nothing is left behind on a cancel. The partial file lives at the caller's `.tmp-` path, which
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
/// cancellable variant differs from the plain one in exactly one thing. How the bytes are moved.
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
/// One caller. The local media import, which is the only copy in this app a user waits on and the
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

/// Picks the copy the caller is entitled to. The chunked, interruptible one when a cancel flag was
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
/// safety of the plain variant is kept. The same-file guard, the size pre-check, and the hash of
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
/// interrupting. A same-volume move is a `rename`, which is instant, while a move across volumes
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
/// dedup/skip paths. The guarantee is worth one extra hash on a user-initiated import, not on
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
/// directory. One pointing at an ancestor (or itself) would otherwise recurse forever, and the
/// library never creates symlinks of its own, so skipping any it finds loses nothing legitimate
/// while making a hand-edited or cloud-synced library that contains one safe to walk.
pub(crate) fn dir_entry_is_symlink(entry: &fs::DirEntry) -> bool {
    entry
        .file_type()
        .map(|file_type| file_type.is_symlink())
        .unwrap_or(false)
}

/// True when `path` itself is a symlink, asked of the link rather than of its target
/// (`symlink_metadata`, not `metadata`).
///
/// The sibling of [`dir_entry_is_symlink`] for the paths that arrive one at a time, off a row,
/// rather than from a directory walk. `absolute_path_from_relative` resolves those lexically, so a
/// symlink planted under a managed directory would otherwise have its *target* read, hashed or
/// handed to FFmpeg as if it were the library's own file. Every walker in this family already
/// refuses to follow one; this lets the single-path readers apply the same rule. A path that cannot
/// be stat'd is reported as not a symlink, and the caller's own existence check says what it is.
pub(crate) fn path_is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
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

        // Skip symlinks before any is_dir()/is_file() check (both follow the link). A symlinked
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

#[cfg(test)]
mod tests;
