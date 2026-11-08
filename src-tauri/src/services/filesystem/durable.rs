//! Getting written bytes onto the disk before a rename or a return makes them count.

use super::*;

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
/// write access, so a read-only open would fail every call with access denied and flush nothing,
/// while the callers' comments rely on it.
#[cfg(windows)]
pub(super) fn flush_directory(dir: &Path) -> bool {
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

    // SAFETY: lp_file_name is a NUL-terminated UTF-16 buffer that outlives the call. The security
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
pub(super) fn fsync_parent_dir(_path: &Path) {}

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
