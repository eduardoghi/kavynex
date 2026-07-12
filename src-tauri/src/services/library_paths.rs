use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::{AppError, AppErrorCode, AppResult};

/// Rejects a canonicalized path that has no parent, i.e. a filesystem/volume root (`C:\`,
/// `/`, a UNC share root, ...). Choosing a root as the library folder would make the asset://
/// scope recursive over the whole drive, so this is checked defense-in-depth even though the
/// frontend already rejects the selection before it reaches here.
fn reject_filesystem_root(library_dir: &std::path::Path) -> AppResult<()> {
    if library_dir.parent().is_none() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryPath,
            "library path cannot be a drive or volume root",
        ));
    }

    Ok(())
}

pub fn ensure_library_dir(path: &str) -> AppResult<PathBuf> {
    let library_dir = PathBuf::from(path.trim());

    if library_dir.as_os_str().is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryPath,
            "library path is empty",
        ));
    }

    fs::create_dir_all(&library_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateLibraryDirFailed,
            format!("failed to create library directory: {e}"),
        )
    })?;

    let canonical_dir = library_dir.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeLibraryPathFailed,
            format!("failed to canonicalize library path: {e}"),
        )
    })?;

    reject_filesystem_root(&canonical_dir)?;

    Ok(canonical_dir)
}

pub fn resolve_existing_library_dir(path: &str) -> AppResult<PathBuf> {
    let library_dir = PathBuf::from(path.trim());

    if library_dir.as_os_str().is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryPath,
            "library path is empty",
        ));
    }

    if !library_dir.exists() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryPath,
            "library path does not exist",
        ));
    }

    if !library_dir.is_dir() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryPath,
            "library path is not a directory",
        ));
    }

    let canonical_dir = library_dir.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeLibraryPathFailed,
            format!("failed to canonicalize library path: {e}"),
        )
    })?;

    reject_filesystem_root(&canonical_dir)?;

    Ok(canonical_dir)
}

pub fn resolve_default_library_directory_sync(app: &AppHandle) -> AppResult<String> {
    let video_dir = app.path().video_dir().map_err(|e| {
        AppError::from_code(
            AppErrorCode::VideoDirectoryResolveFailed,
            format!("failed to resolve video directory: {e}"),
        )
    })?;

    let library_dir = video_dir.join("Kavynex Library");
    fs::create_dir_all(&library_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateDefaultLibraryDirFailed,
            format!("failed to create default library directory: {e}"),
        )
    })?;

    let canonical_dir = library_dir.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeLibraryPathFailed,
            format!("failed to canonicalize default library directory: {e}"),
        )
    })?;

    Ok(canonical_dir.to_string_lossy().to_string())
}

pub fn ensure_directory_exists_sync(path: &str) -> AppResult<String> {
    let dir = PathBuf::from(path.trim());

    if dir.as_os_str().is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidDirectoryPath,
            "directory path is empty",
        ));
    }

    fs::create_dir_all(&dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateDirectoryFailed,
            format!("failed to create directory: {e}"),
        )
    })?;

    let canonical_dir = dir.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeDirectoryFailed,
            format!("failed to canonicalize directory path: {e}"),
        )
    })?;

    Ok(canonical_dir.to_string_lossy().to_string())
}

pub fn resolve_existing_directory_sync(path: &str) -> AppResult<String> {
    let dir = PathBuf::from(path.trim());

    if dir.as_os_str().is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidDirectoryPath,
            "directory path is empty",
        ));
    }

    if !dir.exists() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidDirectoryPath,
            "directory path does not exist",
        ));
    }

    if !dir.is_dir() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidDirectoryPath,
            "directory path is not a directory",
        ));
    }

    let canonical_dir = dir.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeDirectoryFailed,
            format!("failed to canonicalize directory path: {e}"),
        )
    })?;

    Ok(canonical_dir.to_string_lossy().to_string())
}

pub fn is_directory_empty_sync(path: &str) -> AppResult<bool> {
    let dir = PathBuf::from(path.trim());

    if dir.as_os_str().is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidDirectoryPath,
            "directory path is empty",
        ));
    }

    if !dir.exists() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidDirectoryPath,
            "directory path does not exist",
        ));
    }

    if !dir.is_dir() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidDirectoryPath,
            "directory path is not a directory",
        ));
    }

    let mut entries = fs::read_dir(&dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::InvalidDirectoryPath,
            format!("failed to read directory entries: {e}"),
        )
    })?;

    Ok(entries.next().is_none())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        std::env::temp_dir().join(format!(
            "kavynex-library-paths-test-{}-{}-{}",
            prefix,
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn ensure_library_dir_creates_and_canonicalizes_directory() {
        let dir = unique_test_dir("ensure-library");

        let result = ensure_library_dir(dir.to_string_lossy().as_ref()).unwrap();

        assert!(result.exists());
        assert!(result.is_dir());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ensure_library_dir_rejects_empty_path() {
        let result = ensure_library_dir("   ");
        assert!(result.is_err());
    }

    /// The topmost ancestor of any path is the filesystem/volume root (`C:\` on Windows,
    /// `/` on Unix). It always exists, so this needs no directory setup or cleanup.
    fn drive_root() -> PathBuf {
        std::env::temp_dir()
            .ancestors()
            .last()
            .unwrap()
            .to_path_buf()
    }

    #[test]
    fn ensure_library_dir_rejects_a_drive_root() {
        let result = ensure_library_dir(drive_root().to_string_lossy().as_ref());

        assert!(result.is_err());
        assert_eq!(
            result.err().unwrap().code,
            AppErrorCode::InvalidLibraryPath.as_str()
        );
    }

    #[test]
    fn resolve_existing_library_dir_rejects_a_drive_root() {
        let result = resolve_existing_library_dir(drive_root().to_string_lossy().as_ref());

        assert!(result.is_err());
        assert_eq!(
            result.err().unwrap().code,
            AppErrorCode::InvalidLibraryPath.as_str()
        );
    }

    #[test]
    fn resolve_existing_library_dir_returns_canonical_path() {
        let dir = unique_test_dir("resolve-library");
        fs::create_dir_all(&dir).unwrap();

        let result = resolve_existing_library_dir(dir.to_string_lossy().as_ref()).unwrap();

        assert!(result.exists());
        assert!(result.is_dir());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn resolve_existing_library_dir_rejects_missing_path() {
        let dir = unique_test_dir("missing-library");

        let result = resolve_existing_library_dir(dir.to_string_lossy().as_ref());

        assert!(result.is_err());
    }

    #[test]
    fn ensure_directory_exists_sync_creates_directory() {
        let dir = unique_test_dir("ensure-dir");

        let result = ensure_directory_exists_sync(dir.to_string_lossy().as_ref()).unwrap();

        let canonical = PathBuf::from(result);
        assert!(canonical.exists());
        assert!(canonical.is_dir());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn resolve_existing_directory_sync_rejects_file_path() {
        let dir = unique_test_dir("resolve-dir-file");
        fs::create_dir_all(&dir).unwrap();

        let file_path = dir.join("file.txt");
        fs::write(&file_path, b"abc").unwrap();

        let result = resolve_existing_directory_sync(file_path.to_string_lossy().as_ref());

        assert!(result.is_err());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn is_directory_empty_sync_returns_true_for_empty_directory() {
        let dir = unique_test_dir("empty-dir");
        fs::create_dir_all(&dir).unwrap();

        let result = is_directory_empty_sync(dir.to_string_lossy().as_ref()).unwrap();

        assert!(result);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn is_directory_empty_sync_returns_false_for_non_empty_directory() {
        let dir = unique_test_dir("non-empty-dir");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("file.txt"), b"abc").unwrap();

        let result = is_directory_empty_sync(dir.to_string_lossy().as_ref()).unwrap();

        assert!(!result);

        let _ = fs::remove_dir_all(dir);
    }
}
