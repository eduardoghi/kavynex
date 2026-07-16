use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
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
/// `copy_file_atomic` so a power loss cannot leave a truncated or zero-length file at the
/// destination once the rename has been journalled. The file is opened for writing because
/// Windows' `FlushFileBuffers` (what `sync_all` maps to) requires a writable handle.
fn fsync_file(path: &Path) -> AppResult<()> {
    let file = fs::OpenOptions::new().write(true).open(path).map_err(|e| {
        AppError::from_code(
            AppErrorCode::FileCopyFailed,
            format!("failed to open copied file to flush it: {e}"),
        )
    })?;

    file.sync_all().map_err(|e| {
        AppError::from_code(
            AppErrorCode::FileCopyFailed,
            format!("failed to flush copied file to disk: {e}"),
        )
    })
}

fn file_paths_have_same_content(left: &Path, right: &Path) -> AppResult<bool> {
    if !left.exists() || !right.exists() {
        return Ok(false);
    }

    if !left.is_file() || !right.is_file() {
        return Ok(false);
    }

    let left_metadata = fs::metadata(left).map_err(|e| {
        AppError::from_code(
            AppErrorCode::SourceMetadataFailed,
            format!("failed to read left file metadata: {e}"),
        )
    })?;

    let right_metadata = fs::metadata(right).map_err(|e| {
        AppError::from_code(
            AppErrorCode::DestinationMetadataFailed,
            format!("failed to read right file metadata: {e}"),
        )
    })?;

    if left_metadata.len() != right_metadata.len() {
        return Ok(false);
    }

    Ok(file_hash(left)? == file_hash(right)?)
}

pub fn copy_file_atomic(source: &Path, destination: &Path) -> AppResult<()> {
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
        AppError::from_code(
            AppErrorCode::CreateDestinationParentFailed,
            format!("failed to create destination parent directory: {e}"),
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

    fs::copy(source, &temp_destination).map_err(|e| {
        AppError::from_code(
            AppErrorCode::FileCopyFailed,
            format!("failed to copy file: {e}"),
        )
    })?;

    // Flush the copied bytes to disk before the rename. The rename is atomic against a
    // process crash, but without this a power loss could leave a truncated or zero-length
    // file at the destination even after the rename itself was journalled.
    if let Err(error) = fsync_file(&temp_destination) {
        let _ = fs::remove_file(&temp_destination);
        return Err(error);
    }

    match fs::rename(&temp_destination, destination) {
        Ok(_) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&temp_destination);

            if destination.exists() && destination.is_file() {
                if file_paths_have_same_content(source, destination)? {
                    return Ok(());
                }

                return Err(AppError::from_code(
                    AppErrorCode::DestinationAlreadyExists,
                    format!("destination file already exists: {error}"),
                ));
            }

            Err(AppError::from_code(
                AppErrorCode::FileRenameFailed,
                format!("failed to finalize copied file: {error}"),
            ))
        }
    }
}

pub fn move_or_copy_file(source: &Path, destination: &Path) -> AppResult<()> {
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
        AppError::from_code(
            AppErrorCode::CreateDestinationParentFailed,
            format!("failed to create destination parent directory: {e}"),
        )
    })?;

    if destination.exists() {
        if destination.is_file() && file_paths_have_same_content(source, destination)? {
            fs::remove_file(source).map_err(|e| {
                AppError::from_code(
                    AppErrorCode::SourceFileRemoveFailed,
                    format!(
                        "failed to remove source file after detecting identical destination: {e}"
                    ),
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
            copy_file_atomic(source, destination)?;

            fs::remove_file(source).map_err(|e| {
                AppError::from_code(
                    AppErrorCode::SourceFileRemoveFailed,
                    format!("failed to remove source file after copy: {e}"),
                )
            })?;

            Ok(())
        }
        Err(error) => Err(AppError::from_code(
            AppErrorCode::FileMoveFailed,
            format!("failed to move file: {error}"),
        )),
    }
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
        AppError::from_code(
            AppErrorCode::CreateDestinationParentFailed,
            format!("failed to create destination parent directory: {e}"),
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
            return Err(AppError::from_code(
                AppErrorCode::DestinationBackupFailed,
                format!("failed to create destination backup before replace: {error}"),
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
        AppError::from_code(
            AppErrorCode::ReadDirFailed,
            format!("failed to read directory: {e}"),
        )
    })? {
        let entry = entry.map_err(|e| {
            AppError::from_code(
                AppErrorCode::ReadDirEntryFailed,
                format!("failed to read directory entry: {e}"),
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
            AppError::from_code(
                AppErrorCode::ReadDirFailed,
                format!("failed to read directory: {e}"),
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
            AppError::from_code(
                AppErrorCode::ReadDirFailed,
                format!("failed to read directory: {e}"),
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
            AppError::from_code(
                AppErrorCode::ReadDirFailed,
                format!("failed to read directory: {e}"),
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
        AppError::from_code(
            AppErrorCode::CreateDirectoryFailed,
            format!("failed to create directory: {e}"),
        )
    })?;

    for entry in fs::read_dir(source_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::ReadDirFailed,
            format!("failed to read directory: {e}"),
        )
    })? {
        let entry = entry.map_err(|e| {
            AppError::from_code(
                AppErrorCode::ReadDirEntryFailed,
                format!("failed to read directory entry: {e}"),
            )
        })?;

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
        AppError::from_code(
            AppErrorCode::CreateDirectoryFailed,
            format!("failed to create directory: {e}"),
        )
    })?;

    for entry in fs::read_dir(source_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::ReadDirFailed,
            format!("failed to read directory: {e}"),
        )
    })? {
        let entry = entry.map_err(|e| {
            AppError::from_code(
                AppErrorCode::ReadDirEntryFailed,
                format!("failed to read directory entry: {e}"),
            )
        })?;

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
    use std::time::{Duration, UNIX_EPOCH};

    fn unique_test_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        std::env::temp_dir().join(format!(
            "kavynex-filesystem-test-{}-{}",
            std::process::id(),
            nanos
        ))
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
    // the identical-content path may proceed. A flipped comparison here would not fail loudly -
    // it would silently overwrite a file in the user's library - so each test asserts the
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
        assert!(source.exists(), "a rejected copy must not consume the source");

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
        assert!(source.exists(), "a rejected move must not consume the source");

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
        assert!(!source.exists(), "the source should have been moved, not copied");

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
        // content - that is the whole point of the backup dance. What it must not do is leave the
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
        // directory - the destination's directory has to stay writable for the backup and the
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
        assert_eq!(leftover_backup_names(&destination_dir), Vec::<String>::new());

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

        let migrated_content = fs::read(migrated_variants.remove(0)).unwrap();
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
