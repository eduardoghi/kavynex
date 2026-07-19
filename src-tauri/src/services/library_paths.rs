use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::{AppError, AppErrorCode, AppResult};

/// Windows: rewrite a path to its extended-length (`\\?\`) form so filesystem calls made
/// *before* `canonicalize` (create_dir_all, exists, is_dir) are not capped at the 260-char
/// MAX_PATH limit - matching every post-canonicalize operation, which already builds off the
/// `\\?\` form `canonicalize` returns. Only a clean, absolute drive path (`C:\...`) is
/// rewritten: verbatim, UNC and device paths, and any path still carrying `.`/`..` (which are
/// literal under `\\?\`), are left untouched, so this never changes how an already-working
/// path resolves. `canonicalize` still returns the same value it did before, so nothing the
/// callers hand back to the frontend changes.
#[cfg(windows)]
fn to_extended_length_path(path: PathBuf) -> PathBuf {
    use std::path::{Component, Prefix};

    // `\\?\` requires an absolute, normalized path (no `.`/`..`, backslash separators). absolute()
    // produces that without requiring the path to exist, unlike canonicalize. On error (e.g. an
    // empty path) fall back to the input so the callers' own empty-path check still fires.
    let absolute = match std::path::absolute(&path) {
        Ok(absolute) => absolute,
        Err(_) => return path,
    };

    let is_disk = matches!(
        absolute.components().next(),
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_))
    );

    let has_dot_components = absolute
        .components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir));

    if !is_disk || has_dot_components {
        return absolute;
    }

    match absolute.to_str() {
        Some(text) if !text.starts_with(r"\\?\") => PathBuf::from(format!(r"\\?\{text}")),
        _ => absolute,
    }
}

#[cfg(not(windows))]
fn to_extended_length_path(path: PathBuf) -> PathBuf {
    path
}

/// Trims a user-provided library/directory path string and, on Windows, rewrites it to its
/// extended-length form (see [`to_extended_length_path`]). Shared by the helpers below so every
/// filesystem call they make on a caller-supplied path is long-path-safe. A no-op beyond the
/// trim on other platforms.
///
/// Deliberately does NOT reject a UNC / network path here (unlike `services::library_guard` and
/// `services::library::resolve_path_inside_library`, which do): these helpers sit on the
/// library-selection path (onboarding and change-library both call `ensure_directory_exists`/
/// `resolve_existing_directory`/`is_directory_empty` on the candidate folder), and a library kept
/// on a network share is a supported configuration (SECURITY.md - it only loses the
/// "reveal in file manager" convenience). Rejecting network paths here would break choosing such a
/// library. The NTLM-hash-leak concern that motivates the rejection elsewhere is bounded here
/// because the path always comes from a native folder picker the user drove, not from an
/// unattended IPC caller redirecting a delete/move at an arbitrary host.
fn library_input_path(path: &str) -> PathBuf {
    to_extended_length_path(PathBuf::from(path.trim()))
}

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
    let library_dir = library_input_path(path);

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
    let library_dir = library_input_path(path);

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

/// Whether `library_path` resolves to `protected_dir` or a directory inside it, comparing canonical
/// paths so a symlink or a `..`-laden path cannot dodge the check. Used to keep the library out of
/// the app's own config directory, where `kavynex.db` and every backup generation live: pointing the
/// library there would run library maintenance (which removes managed subdirectories) in the same
/// tree as the database and defeat the "backups off the library volume" intent. A path that cannot
/// be canonicalized is treated as *not* inside (fail open); callers validate existence separately,
/// so this only decides containment for a directory that does resolve.
pub fn library_path_is_inside_dir(library_path: &str, protected_dir: &Path) -> bool {
    let candidate = library_input_path(library_path);

    let (Ok(canonical_candidate), Ok(canonical_protected)) =
        (candidate.canonicalize(), protected_dir.canonicalize())
    else {
        return false;
    };

    canonical_candidate.starts_with(&canonical_protected)
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
    let dir = library_input_path(path);

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
    let dir = library_input_path(path);

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
    let dir = library_input_path(path);

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

    #[cfg(windows)]
    #[test]
    fn to_extended_length_path_prefixes_a_plain_drive_path() {
        // A normal absolute drive path gets the verbatim prefix so it is not capped at MAX_PATH.
        let prefixed = to_extended_length_path(PathBuf::from(r"C:\Users\me\Kavynex Library"));
        assert_eq!(
            prefixed.to_string_lossy(),
            r"\\?\C:\Users\me\Kavynex Library"
        );

        // A forward-slash / dotted path is normalized to backslashes and prefixed (absolute()
        // resolves the `.` before the prefix is applied, so `\\?\` never sees a literal dot).
        let normalized = to_extended_length_path(PathBuf::from(r"C:\Users\me\.\Library"));
        assert_eq!(normalized.to_string_lossy(), r"\\?\C:\Users\me\Library");
    }

    #[cfg(windows)]
    #[test]
    fn to_extended_length_path_leaves_verbatim_and_unc_paths_untouched() {
        // Already verbatim: must not be double-prefixed.
        let verbatim = PathBuf::from(r"\\?\C:\Users\me\Library");
        assert_eq!(
            to_extended_length_path(verbatim.clone()).to_string_lossy(),
            verbatim.to_string_lossy()
        );

        // A UNC share is not a drive path, so it is left as-is (the `\\?\UNC\` form is not built
        // here); open_path_in_system rejects network paths separately.
        let unc = PathBuf::from(r"\\server\share\Library");
        assert_eq!(
            to_extended_length_path(unc.clone()).to_string_lossy(),
            unc.to_string_lossy()
        );
    }

    #[cfg(windows)]
    #[test]
    fn ensure_library_dir_creates_a_path_longer_than_max_path() {
        // Build a library path whose full length exceeds the 260-char MAX_PATH limit. Without
        // the `\\?\` rewrite in ensure_library_dir, create_dir_all/canonicalize here would fail
        // on a machine that has not enabled long paths in the registry; with it, this succeeds
        // everywhere.
        let base = unique_test_dir("longpath");
        // Each segment is 40 chars; several of them push the total well past 260.
        let segment = "seg_".to_string() + &"a".repeat(36);
        let mut deep = base.clone();
        for _ in 0..8 {
            deep = deep.join(&segment);
        }
        assert!(
            deep.to_string_lossy().len() > 260,
            "test path should exceed MAX_PATH, was {}",
            deep.to_string_lossy().len()
        );

        let canonical = ensure_library_dir(deep.to_string_lossy().as_ref())
            .expect("a >260-char library path should be created via the \\\\?\\ form");

        assert!(canonical.exists());
        assert!(canonical.is_dir());
        // canonicalize on Windows returns the verbatim form, which the callers already relied on.
        assert!(canonical.to_string_lossy().starts_with(r"\\?\"));

        // Clean up via the verbatim path so removal is also not capped at MAX_PATH.
        let _ = fs::remove_dir_all(&canonical);
        let _ = fs::remove_dir_all(to_extended_length_path(base));
    }
}
