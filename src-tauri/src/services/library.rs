pub use crate::services::library_media::{delete_media_file_sync, import_media_file_sync};
pub use crate::services::library_migration::migrate_library_directory_sync;
pub use crate::services::library_paths::{
    ensure_directory_exists_sync, ensure_library_dir, resolve_default_library_directory_sync,
    resolve_existing_directory_sync, resolve_existing_library_dir,
};
pub use crate::services::library_summary::LibrarySummaryInfo;

use std::path::PathBuf;

use crate::services::library_summary::summarize_library;
use crate::{AppError, AppErrorCode, AppResult};

pub fn get_library_summary_sync(library_path: &str) -> AppResult<LibrarySummaryInfo> {
    let library_dir = resolve_existing_library_dir(library_path)?;
    summarize_library(&library_dir)
}

/// Resolves `path` relative to `library_path` (or as-is if absolute), verifies that
/// the result exists and is contained within the library, and returns the canonical path.
pub fn resolve_path_inside_library(
    path: &str,
    library_path: Option<&str>,
) -> AppResult<PathBuf> {
    let normalized = path.trim();

    if normalized.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidMediaPath,
            "path is empty",
        ));
    }

    let base_library = match library_path.map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => p,
        None => {
            return Err(AppError::from_code(
                AppErrorCode::InvalidMediaPath,
                "library_path is required",
            ))
        }
    };

    let candidate = PathBuf::from(normalized);

    let resolved_path = if candidate.is_absolute() {
        candidate
    } else {
        PathBuf::from(base_library).join(candidate)
    };

    let canonical_library =
        std::fs::canonicalize(base_library).map_err(|_| {
            AppError::from_code(
                AppErrorCode::InvalidMediaPath,
                "library path does not exist or cannot be resolved",
            )
        })?;

    let canonical_path =
        std::fs::canonicalize(&resolved_path).map_err(|_| {
            AppError::from_code(
                AppErrorCode::InvalidMediaPath,
                format!("path does not exist: {}", resolved_path.to_string_lossy()),
            )
        })?;

    if !canonical_path.starts_with(&canonical_library) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidMediaPath,
            "path is outside the library directory",
        ));
    }

    Ok(canonical_path)
}

pub fn open_path_in_system_sync(path: &str, library_path: Option<&str>) -> AppResult<()> {
    let canonical_path = resolve_path_inside_library(path, library_path)?;

    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new("explorer");

        if canonical_path.is_file() {
            command.arg("/select,").arg(&canonical_path);
        } else {
            command.arg(&canonical_path);
        }

        command.spawn().map_err(|error| {
            AppError::from_code(
                AppErrorCode::InvalidMediaPath,
                format!("failed to open path in system explorer: {error}"),
            )
        })?;

        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");

        if canonical_path.is_file() {
            command.arg("-R").arg(&canonical_path);
        } else {
            command.arg(&canonical_path);
        }

        command.spawn().map_err(|error| {
            AppError::from_code(
                AppErrorCode::InvalidMediaPath,
                format!("failed to open path in Finder: {error}"),
            )
        })?;

        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = if canonical_path.is_file() {
            canonical_path
                .parent()
                .unwrap_or(&canonical_path)
                .to_path_buf()
        } else {
            canonical_path
        };

        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|error| {
                AppError::from_code(
                    AppErrorCode::InvalidMediaPath,
                    format!("failed to open path in file manager: {error}"),
                )
            })?;

        return Ok(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn make_temp_library(suffix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kavynex-library-test-{suffix}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_when_library_path_is_none() {
        let result = resolve_path_inside_library("video.mp4", None);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("library_path is required"));
    }

    #[test]
    fn rejects_when_library_path_is_empty() {
        let result = resolve_path_inside_library("video.mp4", Some(""));
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("library_path is required"));
    }

    #[test]
    fn rejects_absolute_path_outside_library() {
        let library = make_temp_library("outside-check");

        #[cfg(target_os = "windows")]
        let outside = "C:\\Windows\\System32";
        #[cfg(not(target_os = "windows"))]
        let outside = "/etc";

        let result = resolve_path_inside_library(outside, Some(library.to_str().unwrap()));
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("outside the library directory")
                || msg.contains("does not exist"),
            "unexpected error: {msg}"
        );
        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn rejects_relative_traversal_outside_library() {
        let library = make_temp_library("traversal-check");

        let result = resolve_path_inside_library(
            "../../etc/passwd",
            Some(library.to_str().unwrap()),
        );
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("outside the library directory")
                || msg.contains("does not exist"),
            "unexpected error: {msg}"
        );
        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn accepts_relative_path_inside_library() {
        let library = make_temp_library("in-library-check");
        let file_path = library.join("video.mp4");
        fs::write(&file_path, b"").unwrap();

        let result = resolve_path_inside_library("video.mp4", Some(library.to_str().unwrap()));
        assert!(result.is_ok(), "expected Ok but got: {:?}", result.err());
        assert_eq!(result.unwrap(), file_path.canonicalize().unwrap());
        let _ = fs::remove_dir_all(&library);
    }
}
