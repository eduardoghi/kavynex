//! Finding files in a folder and walking a tree, never following a link.

use super::*;

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

pub(super) fn file_modified_sort_key(path: &Path) -> SystemTime {
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
        .map(crate::utils::format::normalize_extension)
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
            .map(crate::utils::format::normalize_extension);

        let right_ext = right
            .extension()
            .and_then(|value| value.to_str())
            .map(crate::utils::format::normalize_extension);

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

/// Calls `visit` with every regular file under `dir`, at any depth, until it returns
/// [`ControlFlow::Break`]. A folder that cannot be read is skipped, so a folder that is not there
/// holds nothing.
///
/// A link is never followed, neither a symlink nor, on Windows, a junction (see
/// [`dir_entry_is_symlink`]), so a link pointing at an ancestor cannot make the walk loop, and one
/// pointing outside the folder cannot make it report what is there. Each entry's type is read
/// from the listing itself rather than asked of the disk again, which on a library on a slow drive
/// is most of what a walk costs.
pub(crate) fn walk_regular_files(
    dir: &Path,
    mut visit: impl FnMut(&fs::DirEntry) -> ControlFlow<()>,
) {
    let mut pending = vec![dir.to_path_buf()];

    while let Some(current) = pending.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };

        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };

            if file_type.is_symlink() {
                continue;
            }

            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() && visit(&entry).is_break() {
                return;
            }
        }
    }
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
/// refuses to follow one. This lets the single-path readers apply the same rule. A path that cannot
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
