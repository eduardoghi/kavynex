//! Copying a file to a hidden sibling and renaming it into place, optionally in chunks that can be
//! cancelled and re-read from the disk to prove the copy matches.

use super::*;

pub(super) fn build_temp_destination_path(destination: &Path) -> AppResult<PathBuf> {
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

pub(super) fn file_paths_have_same_content(left: &Path, right: &Path) -> AppResult<bool> {
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
pub(super) const CANCELLABLE_COPY_CHUNK_BYTES: usize = 1024 * 1024;

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
pub(super) fn copy_bytes_whole(source: &Path, temp_destination: &Path) -> AppResult<()> {
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

    stamp_modified(temp_destination, std::time::SystemTime::now());

    Ok(())
}

/// Sets `path`'s modification time to `time`, and logs a warning when it cannot. Best effort. A file
/// system that refuses it (some network and cloud-synced ones do) leaves the time the file had.
///
/// Opening the file for writing is retried while another program holds it ([`retry_while_held`]).
/// On Windows an antivirus opens a file the moment it appears, which is exactly when the time is
/// set, and giving up at once left a file that had just arrived looking as old as its source.
pub(crate) fn stamp_modified(path: &Path, time: std::time::SystemTime) {
    let stamped = retry_while_held(|| fs::OpenOptions::new().write(true).open(path))
        .and_then(|file| file.set_modified(time));

    if let Err(error) = stamped {
        crate::services::logger::warn(
            "filesystem",
            format!(
                "could not set the modification time of {}: {error}",
                crate::services::logger::redact_path(path)
            ),
        );
    }
}

/// Gives the owner write access to a copy that came out read-only.
///
/// `fs::copy` carries the source's permissions over, so a read-only source (an image the user marked
/// read-only, a file on a read-only share) made a read-only copy, and the fsync that follows could
/// not open it for writing. The copy failed, and when it was a chosen thumbnail it took the whole
/// media creation with it. Nothing the app keeps has a reason to be read-only.
pub(super) fn make_owner_writable(path: &Path) -> std::io::Result<()> {
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
pub(super) fn copy_bytes_in_chunks(
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
pub(super) fn copy_bytes_in_chunks_verified(
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
pub(super) fn written_file_hash(path: &Path, cancel: Option<&AtomicBool>) -> AppResult<String> {
    match uncached_file_hash(path, cancel) {
        Some(result) => result,
        None => crate::utils::hash::file_hash_cancellable(path, cancel),
    }
}

/// Hashes what `reader` yields, stopping when `cancel` is set (with the error the cached hash gives
/// for it). `None` when a read fails, so the caller can fall back to a cached read.
#[cfg(any(windows, target_os = "macos"))]
pub(super) fn hash_reader_or_give_up(
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

// The platform bodies other than Linux's carry their own names, so the mutation gate (which runs
// on Linux and never compiles them) can exclude them without also excluding the Linux one.
#[cfg(target_os = "macos")]
pub(super) use self::uncached_file_hash_macos as uncached_file_hash;
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub(super) use self::uncached_file_hash_unsupported as uncached_file_hash;
#[cfg(windows)]
pub(super) use self::uncached_file_hash_windows as uncached_file_hash;

/// Windows reads with `FILE_FLAG_NO_BUFFERING`, which bypasses the cache and needs the buffer and
/// each read aligned to the sector size. 4096 covers the sector sizes drives report, and a read the
/// device refuses all the same falls back to a cached one.
#[cfg(windows)]
pub(super) fn uncached_file_hash_windows(
    path: &Path,
    cancel: Option<&AtomicBool>,
) -> Option<AppResult<String>> {
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
pub(super) fn uncached_file_hash(
    path: &Path,
    cancel: Option<&AtomicBool>,
) -> Option<AppResult<String>> {
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
pub(super) fn uncached_file_hash_macos(
    path: &Path,
    cancel: Option<&AtomicBool>,
) -> Option<AppResult<String>> {
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
pub(super) fn uncached_file_hash_unsupported(
    _path: &Path,
    _cancel: Option<&AtomicBool>,
) -> Option<AppResult<String>> {
    None
}

/// What is wrong with a verified copy, or `None` when it holds exactly the source's bytes.
pub(super) fn copy_verification_problem(
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
pub(super) fn copy_chunks(
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
pub(super) fn copy_file_atomic_with(
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
