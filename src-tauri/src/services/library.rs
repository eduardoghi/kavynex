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

pub fn open_path_in_system_sync(path: &str, library_path: Option<&str>) -> AppResult<()> {
    let normalized = path.trim();

    if normalized.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidMediaPath,
            "path is empty",
        ));
    }

    let candidate = PathBuf::from(normalized);

    let resolved_path = if candidate.is_absolute() {
        candidate
    } else if let Some(base_library_path) = library_path {
        let normalized_library_path = base_library_path.trim();

        if normalized_library_path.is_empty() {
            candidate
        } else {
            PathBuf::from(normalized_library_path).join(candidate)
        }
    } else {
        candidate
    };

    if !resolved_path.exists() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidMediaPath,
            format!("path does not exist: {}", resolved_path.to_string_lossy()),
        ));
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new("explorer");

        if resolved_path.is_file() {
            command.arg("/select,").arg(&resolved_path);
        } else {
            command.arg(&resolved_path);
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

        if resolved_path.is_file() {
            command.arg("-R").arg(&resolved_path);
        } else {
            command.arg(&resolved_path);
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
        let target = if resolved_path.is_file() {
            resolved_path
                .parent()
                .unwrap_or(&resolved_path)
                .to_path_buf()
        } else {
            resolved_path
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
