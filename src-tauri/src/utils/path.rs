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
