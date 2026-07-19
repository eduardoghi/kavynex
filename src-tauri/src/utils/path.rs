use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::{AppError, AppErrorCode, AppResult};

pub fn extension_from_path(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().trim_start_matches('.').to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "bin".to_string())
}

/// True for a segment that names a Windows reserved device (CON, PRN, AUX, NUL, COM0-9,
/// LPT0-9), with or without an extension - Windows treats `CON`, `CON.txt`, etc. as the device.
/// Checked on every platform so a library synced from Windows behaves the same everywhere.
pub(crate) fn is_windows_reserved_name(segment: &str) -> bool {
    let stem = segment.split('.').next().unwrap_or(segment).trim();

    if matches!(
        stem.to_ascii_uppercase().as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
    ) {
        return true;
    }

    let chars: Vec<char> = stem.chars().collect();

    if chars.len() == 4 {
        let head: String = chars[..3].iter().collect::<String>().to_ascii_uppercase();

        if (head == "COM" || head == "LPT") && chars[3].is_ascii_digit() {
            return true;
        }
    }

    false
}

/// True for a UNC / network location (`\\host\share`, `//host/share`, the verbatim UNC form
/// `\\?\UNC\...`, and the mixed-separator spellings `/\host\share` / `\/host\share` that Windows
/// also resolves to a UNC path). Merely canonicalizing or opening one of these on Windows makes
/// the OS reach out to `host` over SMB and authenticate, leaking the user's NTLM hash to whoever
/// controls that host - so callers must reject network paths *before* any filesystem call
/// (`canonicalize`, `exists`, `read_dir`, `create_dir_all`) touches them.
///
/// Separators are normalized to `\` first so a mixed spelling cannot slip past a literal prefix
/// match (`/\host\share` and `\/host\share` both resolve to `\\host\share` on Windows). The device
/// namespace (`\\.\`) and the verbatim *disk* form (`\\?\C:\...`) are local and return false.
/// Checked on every platform so a library synced from Windows behaves the same everywhere.
pub fn is_network_path(value: &str) -> bool {
    let normalized = value.trim_start().replace('/', "\\");

    if let Some(rest) = normalized.strip_prefix(r"\\?\") {
        return rest.starts_with("UNC\\") || rest.starts_with("unc\\");
    }

    if normalized.starts_with(r"\\.\") {
        return false;
    }

    normalized.starts_with(r"\\")
}

pub fn sanitize_relative_path_strict(value: &str) -> AppResult<PathBuf> {
    let trimmed = value.trim();

    if trimmed.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidRelativePath,
            "relative path is empty",
        ));
    }

    let raw = Path::new(trimmed);

    if raw.is_absolute() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidRelativePath,
            "absolute paths are not allowed",
        ));
    }

    let mut sanitized = PathBuf::new();

    for component in raw.components() {
        match component {
            Component::Normal(part) => {
                let part_str = part.to_str().ok_or_else(|| {
                    AppError::from_code(
                        AppErrorCode::InvalidRelativePath,
                        "relative path contains invalid unicode",
                    )
                })?;

                if part_str.trim().is_empty() {
                    return Err(AppError::from_code(
                        AppErrorCode::InvalidRelativePath,
                        "relative path contains an empty segment",
                    ));
                }

                // Reject NTFS alternate-data-stream syntax (`name:stream`) and Windows reserved
                // device names. `Path::components` only flags a drive prefix at the very start,
                // so a `:` or a `CON`/`NUL` segment in the middle otherwise slips through as a
                // plain Normal component.
                if part_str.contains(':') {
                    return Err(AppError::from_code(
                        AppErrorCode::InvalidRelativePath,
                        "relative path segment contains a colon",
                    ));
                }

                if is_windows_reserved_name(part_str) {
                    return Err(AppError::from_code(
                        AppErrorCode::InvalidRelativePath,
                        "relative path segment is a reserved device name",
                    ));
                }

                sanitized.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(AppError::from_code(
                    AppErrorCode::InvalidRelativePath,
                    "parent directory segments are not allowed",
                ));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::from_code(
                    AppErrorCode::InvalidRelativePath,
                    "absolute path components are not allowed",
                ));
            }
        }
    }

    if sanitized.as_os_str().is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidRelativePath,
            "relative path is empty after normalization",
        ));
    }

    Ok(sanitized)
}

/// Validates a library-relative path received over IPC before it is stored on a row (media
/// file, thumbnail, avatar, live chat). On top of `sanitize_relative_path_strict` (no `..`, no
/// absolute/root/prefix component), it requires the path to be rooted at one of the app's
/// managed subdirectories (video/audio/thumbnails/live_chat).
///
/// The managed-directory requirement is what keeps this from being a foothold for arbitrary
/// file deletion: every path the app legitimately produces is content-addressed under one of
/// those directories, so a bare name like `contract.docx` is rejected here. Without it, a
/// compromised frontend could persist such a name and - combined with a redirected library
/// directory - have a later delete/move command act on a file outside the app's own layout.
pub fn ensure_managed_library_relative_path(value: &str) -> AppResult<()> {
    let sanitized = sanitize_relative_path_strict(value)?;

    let first_component = sanitized
        .components()
        .next()
        .and_then(|component| component.as_os_str().to_str());

    let is_managed = first_component
        .map(|dir| crate::constants::MANAGED_LIBRARY_DIRS.contains(&dir))
        .unwrap_or(false);

    if !is_managed {
        return Err(AppError::from_code(
            AppErrorCode::InvalidRelativePath,
            "path must be inside a managed library directory",
        ));
    }

    Ok(())
}

/// Like [`ensure_managed_library_relative_path`], but requires the path to be rooted at one
/// specific managed subdirectory rather than any of them. Used by the live chat commands, whose
/// `relative_path` arrives raw over IPC: `sanitize_relative_path_strict` alone rejects `..`/absolute
/// paths but not a sibling managed directory, so without this a "stream/delete a live chat file"
/// call could be pointed at a video/audio/thumbnail file instead of the `live_chat/` tree it is
/// meant for.
pub fn ensure_relative_path_in_managed_dir(value: &str, expected_dir: &str) -> AppResult<()> {
    let sanitized = sanitize_relative_path_strict(value)?;

    let first_component = sanitized
        .components()
        .next()
        .and_then(|component| component.as_os_str().to_str());

    if first_component != Some(expected_dir) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidRelativePath,
            "path must be inside the expected managed library directory",
        ));
    }

    Ok(())
}

pub fn ensure_existing_path_inside_dir(path: &Path, base_dir: &Path) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::from_code(
            AppErrorCode::PathNotFound,
            "target path does not exist",
        ));
    }

    let canonical_base = base_dir.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeBaseDirFailed,
            format!("failed to canonicalize base directory: {e}"),
        )
    })?;

    let canonical_path = path.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeTargetPathFailed,
            format!("failed to canonicalize target path: {e}"),
        )
    })?;

    if !canonical_path.starts_with(&canonical_base) {
        return Err(AppError::from_code(
            AppErrorCode::PathOutsideBaseDir,
            "target path is outside the base directory",
        ));
    }

    Ok(())
}

pub fn ensure_path_parent_inside_dir(path: &Path, base_dir: &Path) -> AppResult<()> {
    if !base_dir.exists() {
        fs::create_dir_all(base_dir).map_err(|e| {
            AppError::from_code(
                AppErrorCode::CreateBaseDirFailed,
                format!("failed to create base directory: {e}"),
            )
        })?;
    }

    let canonical_base = base_dir.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeBaseDirFailed,
            format!("failed to canonicalize base directory: {e}"),
        )
    })?;

    let parent = path.parent().ok_or_else(|| {
        AppError::from_code(
            AppErrorCode::InvalidTargetPath,
            "target path has no parent directory",
        )
    })?;

    if !parent.exists() {
        fs::create_dir_all(parent).map_err(|e| {
            AppError::from_code(
                AppErrorCode::CreateTargetParentFailed,
                format!("failed to create target parent directory: {e}"),
            )
        })?;
    }

    let canonical_parent = parent.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeTargetParentFailed,
            format!("failed to canonicalize target parent directory: {e}"),
        )
    })?;

    if !canonical_parent.starts_with(&canonical_base) {
        return Err(AppError::from_code(
            AppErrorCode::PathOutsideBaseDir,
            "target path is outside the base directory",
        ));
    }

    Ok(())
}

pub fn absolute_path_from_relative(base_dir: &Path, relative_path: &str) -> AppResult<PathBuf> {
    let canonical_base = base_dir.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeBaseDirFailed,
            format!("failed to canonicalize base directory: {e}"),
        )
    })?;

    let sanitized_relative = sanitize_relative_path_strict(relative_path)?;
    let absolute = canonical_base.join(sanitized_relative);

    if let Some(parent) = absolute.parent() {
        if !parent.starts_with(&canonical_base) {
            return Err(AppError::from_code(
                AppErrorCode::PathOutsideBaseDir,
                "target path is outside the base directory",
            ));
        }
    } else {
        return Err(AppError::from_code(
            AppErrorCode::InvalidTargetPath,
            "target path has no parent directory",
        ));
    }

    Ok(absolute)
}

pub fn writable_path_from_relative(base_dir: &Path, relative_path: &str) -> AppResult<PathBuf> {
    if !base_dir.exists() {
        fs::create_dir_all(base_dir).map_err(|e| {
            AppError::from_code(
                AppErrorCode::CreateBaseDirFailed,
                format!("failed to create base directory: {e}"),
            )
        })?;
    }

    let absolute = absolute_path_from_relative(base_dir, relative_path)?;
    ensure_path_parent_inside_dir(&absolute, base_dir)?;
    Ok(absolute)
}

pub fn relative_path_from_base(base_dir: &Path, absolute_path: &Path) -> AppResult<String> {
    let canonical_base = base_dir.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeBaseDirFailed,
            format!("failed to canonicalize base directory: {e}"),
        )
    })?;

    let canonical_absolute = absolute_path.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeTargetPathFailed,
            format!("failed to canonicalize target path: {e}"),
        )
    })?;

    if !canonical_absolute.starts_with(&canonical_base) {
        return Err(AppError::from_code(
            AppErrorCode::PathOutsideBaseDir,
            "target path is outside the base directory",
        ));
    }

    let relative = canonical_absolute
        .strip_prefix(&canonical_base)
        .map_err(|e| {
            AppError::from_code(
                AppErrorCode::RelativePathResolveFailed,
                format!("failed to resolve relative path: {e}"),
            )
        })?
        .to_path_buf();

    let relative_str = relative
        .to_str()
        .ok_or_else(|| {
            AppError::from_code(
                AppErrorCode::RelativePathResolveFailed,
                "relative path contains invalid unicode",
            )
        })?
        .replace('\\', "/");

    if relative_str.trim().is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::RelativePathResolveFailed,
            "relative path is empty",
        ));
    }

    Ok(relative_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        std::env::temp_dir().join(format!(
            "kavynex-path-test-{}-{}",
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn is_network_path_flags_unc_forward_slash_and_mixed_separator_shares() {
        for value in [
            r"\\server\share",
            r"\\server\share\clip.mp4",
            "//server/share",
            r"\\?\UNC\server\share", // verbatim UNC is still a network share
            // Mixed separators that Windows normalizes to a UNC path; a literal `\\`/`//` prefix
            // match misses these, which is exactly the bypass this normalization closes.
            r"/\server\share",
            r"\/server\share",
            "  \\\\server\\share  ", // surrounding whitespace is trimmed before the check
        ] {
            assert!(is_network_path(value), "should flag: {value}");
        }

        for value in [
            r"C:\Users\me\video.mp4",
            "/home/me/video.mp4",
            "video/clip.mp4",
            r"\\?\C:\Users\me\video.mp4", // extended-length local path, not a network share
            r"\\.\PhysicalDrive0",        // device namespace, local
        ] {
            assert!(!is_network_path(value), "should not flag: {value}");
        }
    }

    #[test]
    fn sanitize_relative_path_rejects_parent_dir() {
        let result = sanitize_relative_path_strict("../outside/file.txt");
        assert!(result.is_err());
    }

    #[test]
    fn sanitize_relative_path_accepts_normal_relative_path() {
        let result = sanitize_relative_path_strict("video/file.mp4").unwrap();
        assert_eq!(result, PathBuf::from("video/file.mp4"));
    }

    #[test]
    fn sanitize_relative_path_rejects_a_colon_segment() {
        // NTFS alternate data stream syntax.
        let error = sanitize_relative_path_strict("thumbnails/thumb.jpg:hidden").unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidRelativePath.as_str());
    }

    #[test]
    fn sanitize_relative_path_rejects_windows_reserved_device_names() {
        for path in [
            "video/CON",
            "video/con.mp4",
            "video/NUL.txt",
            "audio/COM1",
            "thumbnails/LPT9.jpg",
        ] {
            let error = sanitize_relative_path_strict(path)
                .expect_err(&format!("{path} should be rejected"));
            assert_eq!(error.code, AppErrorCode::InvalidRelativePath.as_str());
        }
    }

    #[test]
    fn sanitize_relative_path_allows_names_that_only_start_like_a_reserved_name() {
        // "console" / "computer" are not reserved even though they start with CON/COM.
        for path in ["video/console.mp4", "video/computer.mp4", "audio/lpt.m4a"] {
            sanitize_relative_path_strict(path)
                .unwrap_or_else(|error| panic!("{path} should be accepted: {error}"));
        }
    }

    #[test]
    fn sanitize_relative_path_allows_four_char_names_ending_in_a_digit() {
        // A four-character stem that ends in a digit but does not start with COM/LPT (e.g.
        // "pic1", "km2x" is five, "abc9") is a normal name, not a reserved device: the device
        // check must require *both* the COM/LPT head and the trailing digit, so this must be
        // accepted while COM1/LPT9 stay rejected.
        for path in ["video/pic1.mp4", "audio/abc9.m4a", "thumbnails/xyz0.jpg"] {
            sanitize_relative_path_strict(path)
                .unwrap_or_else(|error| panic!("{path} should be accepted: {error}"));
        }

        // The genuine device names with the same 4-char digit shape stay rejected.
        for path in ["video/COM1", "audio/lpt9.m4a"] {
            sanitize_relative_path_strict(path).expect_err(&format!("{path} should be rejected"));
        }
    }

    #[test]
    fn ensure_managed_library_relative_path_accepts_paths_under_managed_dirs() {
        for path in [
            "video/media_abc.mp4",
            "audio/media_abc.m4a",
            "thumbnails/thumb_abc.jpg",
            "live_chat/clip.live_chat.json.gz",
        ] {
            ensure_managed_library_relative_path(path)
                .unwrap_or_else(|error| panic!("{path} should be accepted: {error}"));
        }
    }

    #[test]
    fn ensure_managed_library_relative_path_rejects_bare_and_unmanaged_paths() {
        // A bare filename at the (possibly redirected) library root, an unmanaged directory,
        // a traversal attempt, and an absolute path must all be rejected.
        for path in [
            "contract.docx",
            "Documents/secret.txt",
            "video/../../secret.txt",
            "../secret.txt",
            "config/app.ini",
        ] {
            let error = ensure_managed_library_relative_path(path)
                .expect_err(&format!("{path} should be rejected"));
            assert_eq!(error.code, AppErrorCode::InvalidRelativePath.as_str());
        }
    }

    #[test]
    fn absolute_path_from_relative_resolves_inside_base_without_creating_parent() {
        let base_dir = unique_test_dir();
        fs::create_dir_all(&base_dir).unwrap();

        let nested_parent = base_dir.join("video");
        assert!(!nested_parent.exists());

        let absolute = absolute_path_from_relative(&base_dir, "video/test.mp4").unwrap();
        assert!(absolute.starts_with(base_dir.canonicalize().unwrap()));
        assert!(!nested_parent.exists());

        let _ = fs::remove_dir_all(base_dir);
    }

    #[test]
    fn ensure_path_parent_inside_dir_creates_a_missing_base_dir() {
        // When the base directory does not exist yet, the function must create it (and the
        // target's parent) rather than fail: the containment check that follows canonicalizes the
        // base, which errors on a missing directory. This pins the defensive create-if-missing
        // branch that callers pre-creating the base would otherwise leave unexercised.
        let base_dir = unique_test_dir();
        assert!(!base_dir.exists());

        let target = base_dir.join("video").join("clip.mp4");
        ensure_path_parent_inside_dir(&target, &base_dir).unwrap();

        assert!(base_dir.exists());
        assert!(base_dir.join("video").exists());

        let _ = fs::remove_dir_all(&base_dir);
    }

    #[test]
    fn writable_path_from_relative_creates_parent_inside_base() {
        let base_dir = unique_test_dir();
        fs::create_dir_all(&base_dir).unwrap();

        let absolute = writable_path_from_relative(&base_dir, "video/test.mp4").unwrap();
        assert!(absolute.starts_with(base_dir.canonicalize().unwrap()));
        assert!(base_dir.join("video").exists());

        let _ = fs::remove_dir_all(base_dir);
    }

    #[test]
    fn writable_path_from_relative_creates_base_dir_when_missing() {
        let base_dir = unique_test_dir();

        let absolute = writable_path_from_relative(&base_dir, "video/test.mp4").unwrap();
        assert!(base_dir.exists());
        assert!(absolute.starts_with(base_dir.canonicalize().unwrap()));
        assert!(base_dir.join("video").exists());

        let _ = fs::remove_dir_all(base_dir);
    }

    #[test]
    fn relative_path_from_base_returns_forward_slashes() {
        let base_dir = unique_test_dir();
        let nested_dir = base_dir.join("video");
        let target_path = nested_dir.join("test.mp4");

        fs::create_dir_all(&nested_dir).unwrap();
        fs::write(&target_path, b"abc").unwrap();

        let relative = relative_path_from_base(&base_dir, &target_path).unwrap();
        assert_eq!(relative, "video/test.mp4");

        let _ = fs::remove_dir_all(base_dir);
    }
}
