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

/// The Windows errors a file just created or written tends to return for a moment while an antivirus
/// scanner or the search indexer holds it: access denied, sharing violation, lock violation.
#[cfg(windows)]
fn is_held_by_another_program(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(5) | Some(32) | Some(33))
}

/// Runs `op`, and on Windows runs it again a few times, a little later each time, while it fails
/// because another program is holding the file.
///
/// A scanner opens every new file the moment it appears, so the rename that follows a copy, or
/// reopening the copy to flush it, failed now and then for a reason that was gone a second later,
/// and took a whole import, download or marker write with it. Elsewhere `op` runs once.
pub(crate) fn retry_while_held<T>(op: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    retry_while_held_with(&[50, 100, 200, 400], op)
}

/// [`retry_while_held`] with a longer wait, for a file of gigabytes a scanner is still reading when
/// the rename comes. Under a second of retries is enough for a thumbnail and not for a finished
/// download, whose failed placement used to leave it only in the run folder that is deleted next.
pub(crate) fn retry_while_held_patiently<T>(
    op: impl FnMut() -> std::io::Result<T>,
) -> std::io::Result<T> {
    retry_while_held_with(&[100, 250, 500, 1_000, 2_000, 4_000], op)
}

#[cfg_attr(not(windows), allow(unused_variables))]
fn retry_while_held_with<T>(
    delays_ms: &[u64],
    mut op: impl FnMut() -> std::io::Result<T>,
) -> std::io::Result<T> {
    #[cfg(windows)]
    {
        for &delay_ms in delays_ms {
            match op() {
                Err(error) if is_held_by_another_program(&error) => {
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                }
                result => return result,
            }
        }
    }

    op()
}

/// `fs::rename` through [`retry_while_held`].
pub(crate) fn rename_retrying(from: &Path, to: &Path) -> std::io::Result<()> {
    retry_while_held(|| fs::rename(from, to))
}

/// `fs::rename` through [`retry_while_held_patiently`], for a media file.
pub(crate) fn rename_retrying_patiently(from: &Path, to: &Path) -> std::io::Result<()> {
    retry_while_held_patiently(|| fs::rename(from, to))
}

/// Flushes a freshly written file's data and metadata to disk. Called before the rename in
/// `copy_file_atomic` (and by the db-backup staging copies) so a power loss cannot leave a
/// truncated or zero-length file that a following rename then makes the live file. The file is
/// opened for writing because Windows' `FlushFileBuffers` (what `sync_all` maps to) requires a
/// writable handle.
pub(crate) fn fsync_file(path: &Path) -> AppResult<()> {
    let file = retry_while_held(|| fs::OpenOptions::new().write(true).open(path)).map_err(|e| {
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
/// power-loss window on NTFS with write caching enabled that the Unix path closes. Best effort. A
/// failure is ignored, as on Unix.
#[cfg(windows)]
pub(crate) fn fsync_parent_dir(path: &Path) {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            let _ = flush_directory(parent);
        }
    }
}

/// Flushes `dir`'s entries to disk and says whether that happened.
///
/// The handle is opened for writing as well as reading. `FlushFileBuffers` refuses a handle without
/// write access, and this used to open the directory read-only, so every call failed with access
/// denied and nothing was flushed, while the callers' comments relied on it.
#[cfg(windows)]
fn flush_directory(dir: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;

    let wide: Vec<u16> = dir
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
    const GENERIC_WRITE: u32 = 0x4000_0000;
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
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        );

        if handle.is_null() || handle == invalid_handle {
            return false;
        }

        let flushed = FlushFileBuffers(handle) != 0;
        let _ = CloseHandle(handle);

        flushed
    }
}

#[cfg(not(any(unix, windows)))]
fn fsync_parent_dir(_path: &Path) {}

/// Writes `contents` to `path` so that a crash leaves either the previous file or the new one, never
/// a truncated mix, and so that the new one survives a power loss once this returns.
///
/// The bytes go to a hidden sibling first, are flushed, and only then take the name, and the
/// directory entry is flushed after the rename. Writing in place truncated the file before the new
/// bytes were down, so a crash in between left an empty or half-written file under the real name.
/// For the crash markers that is the one file their recovery reads.
pub(crate) fn write_file_durably(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(ErrorKind::InvalidInput, "the file has no parent directory")
    })?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let staging = parent.join(format!(".{file_name}.tmp-{}", unique_temp_suffix()));

    let written = (|| {
        let mut file = fs::File::create(&staging)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        rename_retrying(&staging, path)
    })();

    if let Err(error) = written {
        let _ = fs::remove_file(&staging);
        return Err(error);
    }

    fsync_parent_dir(path);
    Ok(())
}

fn file_paths_have_same_content(left: &Path, right: &Path) -> AppResult<bool> {
    file_paths_have_same_content_using(left, right, None)
}

/// Like [`file_paths_have_same_content`], but reuses a precomputed SHA-256 of `left` when the
/// caller already has it (e.g. a content-addressed import whose destination name was derived from
/// this same hash), so a large `left` file is not hashed a second time. The size check still runs
/// first, and `right` is always hashed, so a `right` file whose bytes no longer match its name
/// (a corrupt library file) is still caught.
pub(crate) fn file_paths_have_same_content_using(
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
///
/// The copy is stamped with the time it was made. `CopyFileEx` carries the source's modification
/// time over, so an avatar persisted from an old image arrived looking years old, and the orphan
/// removal, which spares a file written in the last hour because its row lands a call later, read it
/// as long abandoned.
///
/// The stamp is best effort. A file system that refuses it (some network and cloud-synced ones do)
/// still has a complete copy, and failing the copy over the time would lose a good file for a
/// heuristic the orphan removal backs with a recount anyway.
fn copy_bytes_whole(source: &Path, temp_destination: &Path) -> AppResult<()> {
    fs::copy(source, temp_destination)
        .and_then(|_| make_owner_writable(temp_destination))
        .map_err(|e| {
            AppError::fs_error(
                AppErrorCode::FileCopyFailed,
                "failed to copy file",
                temp_destination,
                &e,
            )
        })?;

    let stamped = retry_while_held(|| fs::OpenOptions::new().write(true).open(temp_destination))
        .and_then(|file| file.set_modified(std::time::SystemTime::now()));

    if let Err(error) = stamped {
        crate::services::logger::warn(
            "filesystem",
            format!(
                "copied {} but could not set its modification time: {error}",
                crate::services::logger::redact_path(temp_destination)
            ),
        );
    }

    Ok(())
}

/// Gives the owner write access to a copy that came out read-only.
///
/// `fs::copy` carries the source's permissions over, so a read-only source (an image the user marked
/// read-only, a file on a read-only share) made a read-only copy, and the fsync that follows could
/// not open it for writing. The copy failed, and when it was a chosen thumbnail it took the whole
/// media creation with it. Nothing the app keeps has a reason to be read-only.
fn make_owner_writable(path: &Path) -> std::io::Result<()> {
    let mut permissions = fs::metadata(path)?.permissions();

    if !permissions.readonly() {
        return Ok(());
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        permissions.set_mode(permissions.mode() | 0o200);
    }

    // Only the read-only attribute on Windows, which is what `set_readonly(false)` clears there.
    #[cfg(not(unix))]
    #[allow(clippy::permissions_set_readonly_false)]
    permissions.set_readonly(false);

    fs::set_permissions(path, permissions)
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
    copy_chunks(source, temp_destination, cancel, None).map(|_| ())
}

/// [`copy_bytes_in_chunks`], then proof that the copy holds what was read.
///
/// For the library migration, which deletes the source once every copy is in. A size check alone
/// passes a copy whose bytes went wrong on the way (a flaky USB bridge, a network share that
/// acknowledged a write it lost), and a read that ended early would otherwise leave a short file
/// whose size nobody compares. So the source is hashed as it is read, its length is held to what it
/// was when the copy started, and the written file is read back and hashed before it can take the
/// destination's name.
fn copy_bytes_in_chunks_verified(
    source: &Path,
    temp_destination: &Path,
    cancel: Option<&AtomicBool>,
) -> AppResult<()> {
    use sha2::Digest;

    let expected_len = fs::metadata(source)
        .map_err(|e| {
            AppError::fs_error(
                AppErrorCode::SourceMetadataFailed,
                "failed to read the source file's size",
                source,
                &e,
            )
        })?
        .len();

    let mut hasher = sha2::Sha256::new();
    let copied = copy_chunks(source, temp_destination, cancel, Some(&mut hasher))?;
    let read_digest = crate::utils::hash::hex_digest(hasher);

    // Flushed before it is read back, and read back from the device as far as the platform allows.
    // Read back through the cache, a write the drive or the share lost is still sitting in memory
    // and hashes fine, and the migration deletes the original on the strength of that hash.
    fsync_file(temp_destination)?;
    let written_digest = written_file_hash(temp_destination, cancel)?;

    match copy_verification_problem(expected_len, copied, &read_digest, &written_digest) {
        None => Ok(()),
        Some(problem) => Err(AppError::with_details(
            AppErrorCode::FileCopyFailed,
            problem,
            format!("path: {}", crate::services::logger::redact_path(source)),
        )),
    }
}

/// Hashes a file just written and flushed, reading it from the device rather than from the OS cache
/// where the platform allows it, and through the cache otherwise.
fn written_file_hash(path: &Path, cancel: Option<&AtomicBool>) -> AppResult<String> {
    match uncached_file_hash(path, cancel) {
        Some(result) => result,
        None => crate::utils::hash::file_hash_cancellable(path, cancel),
    }
}

/// Hashes what `reader` yields, stopping when `cancel` is set (with the error the cached hash gives
/// for it). `None` when a read fails, so the caller can fall back to a cached read.
#[cfg(any(windows, target_os = "macos"))]
fn hash_reader_or_give_up(
    path: &Path,
    reader: &mut impl std::io::Read,
    buffer: &mut [u8],
    cancel: Option<&AtomicBool>,
) -> Option<AppResult<String>> {
    use sha2::Digest;

    let mut hasher = sha2::Sha256::new();

    loop {
        if crate::utils::hash::is_cancelled(cancel) {
            return Some(crate::utils::hash::file_hash_cancellable(path, cancel));
        }

        match reader.read(buffer) {
            Ok(0) => return Some(Ok(crate::utils::hash::hex_digest(hasher))),
            Ok(read) => hasher.update(&buffer[..read]),
            Err(_) => return None,
        }
    }
}

/// Windows reads with `FILE_FLAG_NO_BUFFERING`, which bypasses the cache and needs the buffer and
/// each read aligned to the sector size. 4096 covers the sector sizes drives report, and a read the
/// device refuses all the same falls back to a cached one.
#[cfg(windows)]
fn uncached_file_hash(path: &Path, cancel: Option<&AtomicBool>) -> Option<AppResult<String>> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_FLAG_NO_BUFFERING: u32 = 0x2000_0000;
    const ALIGN: usize = 4096;
    const CHUNK: usize = 1 << 20;

    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_NO_BUFFERING)
        .open(path)
        .ok()?;

    let mut storage = vec![0_u8; CHUNK + ALIGN];
    let offset = storage.as_ptr().align_offset(ALIGN);
    let buffer = &mut storage[offset..offset + CHUNK];

    hash_reader_or_give_up(path, &mut file, buffer, cancel)
}

/// Linux drops the file's pages from the cache once the flush has made them clean, so the read that
/// follows goes to the device.
#[cfg(target_os = "linux")]
fn uncached_file_hash(path: &Path, cancel: Option<&AtomicBool>) -> Option<AppResult<String>> {
    use std::os::unix::io::AsRawFd;

    let file = fs::File::open(path).ok()?;

    // SAFETY: the descriptor is open for the whole call. The advice only drops clean cached pages.
    let advised = unsafe { libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };

    if advised != 0 {
        return None;
    }

    drop(file);

    Some(crate::utils::hash::file_hash_cancellable(path, cancel))
}

/// macOS reads through a descriptor with `F_NOCACHE` set, which keeps the read out of the cache.
#[cfg(target_os = "macos")]
fn uncached_file_hash(path: &Path, cancel: Option<&AtomicBool>) -> Option<AppResult<String>> {
    use std::os::unix::io::AsRawFd;

    let mut file = fs::File::open(path).ok()?;

    // SAFETY: the descriptor is open for the whole call, and F_NOCACHE only changes its caching.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_NOCACHE, 1) } == -1 {
        return None;
    }

    let mut buffer = vec![0_u8; 1 << 20];

    hash_reader_or_give_up(path, &mut file, &mut buffer, cancel)
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn uncached_file_hash(_path: &Path, _cancel: Option<&AtomicBool>) -> Option<AppResult<String>> {
    None
}

/// What is wrong with a verified copy, or `None` when it holds exactly the source's bytes.
fn copy_verification_problem(
    expected_len: u64,
    copied: u64,
    read_digest: &str,
    written_digest: &str,
) -> Option<&'static str> {
    if copied != expected_len {
        return Some("the source file changed size while it was copied");
    }

    if written_digest != read_digest {
        return Some("the copy does not hold the bytes read from the source");
    }

    None
}

/// The chunk loop behind both copies above. Returns how many bytes were copied, and feeds them to
/// `hasher` when one is given.
fn copy_chunks(
    source: &Path,
    temp_destination: &Path,
    cancel: Option<&AtomicBool>,
    mut hasher: Option<&mut sha2::Sha256>,
) -> AppResult<u64> {
    use sha2::Digest;
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
    let mut copied: u64 = 0;

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

        if let Some(hasher) = hasher.as_deref_mut() {
            hasher.update(&buffer[..read]);
        }

        copied += read as u64;
    }

    // Flush userspace buffering into the file before the caller's fsync, which operates on a
    // reopened handle and would otherwise have nothing to push to the platter.
    writer.flush().map_err(copy_failed)?;

    Ok(copied)
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

    match rename_retrying(&temp_destination, destination) {
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

/// Like [`copy_file_atomic_cancellable`], but the copy only takes the destination's name once it
/// was read back and found to hold exactly the source's bytes. See [`copy_bytes_in_chunks_verified`].
pub(crate) fn copy_file_atomic_verified(
    source: &Path,
    destination: &Path,
    cancel: Option<&AtomicBool>,
) -> AppResult<()> {
    copy_file_atomic_with(source, destination, |source, temp_destination| {
        copy_bytes_in_chunks_verified(source, temp_destination, cancel)
    })
}

/// Picks the copy the caller is entitled to. The chunked, interruptible one when a cancel flag was
/// offered, and the faster platform copy when it was not. Keeping the dispatch in one place is what
/// lets the staged move below take a flag without every non-cancelling caller paying for userspace
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
    move_or_copy_file_using(source, destination, None)
}

fn move_or_copy_file_using(
    source: &Path,
    destination: &Path,
    source_hash: Option<&str>,
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

    match rename_retrying_patiently(source, destination) {
        Ok(_) => Ok(()),
        Err(error) if is_cross_device_error(&error) => {
            copy_file_atomic(source, destination)?;

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
fn stage_move_using(
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

    if path_is_symlink(source) {
        copy_file_atomic_maybe_cancellable(source, destination, cancel)?;
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
        copy_file_atomic_maybe_cancellable(source, destination, cancel)?;
        return Ok(StagedMove::SourceKept);
    }

    match rename_retrying_patiently(source, destination) {
        Ok(()) => {
            fsync_parent_dir(destination);
            Ok(StagedMove::SourceConsumed)
        }
        Err(error) if is_cross_device_error(&error) => {
            copy_file_atomic_maybe_cancellable(source, destination, cancel)?;
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
fn staged_onto_existing_destination(
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

    match rename_retrying(destination, &backup_path) {
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
            let restore_result = rename_retrying(&backup_path, destination);

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

#[cfg(test)]
pub fn copy_directory_contents(source_dir: &Path, destination_dir: &Path) -> AppResult<()> {
    copy_directory_contents_tracked(source_dir, destination_dir, None, &mut |_| {})
}

/// [`copy_directory_contents`] for a copy someone is watching. `on_copied` gets the size of each
/// file once it is in place, and a set `cancel` stops the walk before the next file and the copy of
/// the current one partway (the chunked copy, which leaves nothing behind).
///
/// Every file is copied with [`copy_file_atomic_verified`], and an entry that is neither a file nor
/// a directory, or whose type cannot be read, fails the copy instead of being passed over. The
/// library migration removes the source tree after this returns, so an entry skipped here would be
/// deleted without ever having been copied.
pub(crate) fn copy_directory_contents_tracked(
    source_dir: &Path,
    destination_dir: &Path,
    cancel: Option<&AtomicBool>,
    on_copied: &mut dyn FnMut(u64),
) -> AppResult<()> {
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

        let file_type = entry.file_type().map_err(|e| {
            AppError::fs_error(
                AppErrorCode::ReadDirEntryFailed,
                "failed to read the type of a directory entry",
                &source_path,
                &e,
            )
        })?;

        if file_type.is_dir() {
            copy_directory_contents_tracked(&source_path, &destination_path, cancel, on_copied)?;
            continue;
        }

        if !file_type.is_file() {
            return Err(AppError::with_details(
                AppErrorCode::InvalidSourceFile,
                "found an entry that is neither a file nor a folder",
                format!(
                    "path: {}",
                    crate::services::logger::redact_path(&source_path)
                ),
            ));
        }

        if cancel.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::SeqCst)) {
            return Err(AppError::from_code(
                AppErrorCode::FileCopyFailed,
                "the copy was cancelled",
            ));
        }

        copy_file_atomic_verified(&source_path, &destination_path, cancel)?;

        let size = source_path.metadata().map_err(|e| {
            AppError::fs_error(
                AppErrorCode::SourceMetadataFailed,
                "failed to read the size of a copied file",
                &source_path,
                &e,
            )
        })?;

        on_copied(size.len());
    }

    Ok(())
}

#[cfg(test)]
mod tests;
