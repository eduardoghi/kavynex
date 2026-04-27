use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

use crate::services::library_migration;
use crate::services::library_paths;
use crate::services::library_summary::LibrarySummaryInfo;
use crate::services::{library, logger};
use crate::utils::task::run_blocking;
use crate::AppResult;

#[derive(Serialize, Clone, Debug)]
pub struct LibraryIntegrityReport {
    pub checked_media_files: usize,
    pub missing_media_files: usize,
    pub missing_media_examples: Vec<String>,
    pub checked_thumbnail_files: usize,
    pub missing_thumbnail_files: usize,
    pub missing_thumbnail_examples: Vec<String>,
}

fn resolve_stored_path(library_path: &Path, stored_path: &str) -> PathBuf {
    let candidate = PathBuf::from(stored_path);

    if candidate.is_absolute() {
        return candidate;
    }

    library_path.join(candidate)
}

fn collect_missing_paths(
    library_path: &Path,
    stored_paths: Vec<String>,
) -> (usize, usize, Vec<String>) {
    let mut unique_paths = HashSet::new();

    for item in stored_paths {
        let trimmed = item.trim();

        if trimmed.is_empty() {
            continue;
        }

        unique_paths.insert(trimmed.to_string());
    }

    let checked_count = unique_paths.len();
    let mut missing_count = 0usize;
    let mut missing_examples: Vec<String> = Vec::new();

    for stored_path in unique_paths {
        let resolved_path = resolve_stored_path(library_path, &stored_path);

        if !resolved_path.exists() {
            missing_count += 1;

            if missing_examples.len() < 5 {
                missing_examples.push(stored_path);
            }
        }
    }

    (checked_count, missing_count, missing_examples)
}

#[tauri::command]
pub async fn resolve_default_library_directory(app: AppHandle) -> AppResult<String> {
    run_blocking(move || library_paths::resolve_default_library_directory_sync(&app)).await
}

#[tauri::command]
pub async fn ensure_directory_exists(path: String) -> AppResult<String> {
    run_blocking(move || library_paths::ensure_directory_exists_sync(&path)).await
}

#[tauri::command]
pub async fn resolve_existing_directory(path: String) -> AppResult<String> {
    run_blocking(move || library_paths::resolve_existing_directory_sync(&path)).await
}

#[tauri::command]
pub async fn is_directory_empty(path: String) -> AppResult<bool> {
    run_blocking(move || library_paths::is_directory_empty_sync(&path)).await
}

#[tauri::command]
pub async fn migrate_library_directory(
    old_library_path: String,
    new_library_path: String,
) -> AppResult<library_migration::MigrateLibraryDirectoryResult> {
    run_blocking(move || {
        library_migration::migrate_library_directory_sync(&old_library_path, &new_library_path)
    })
    .await
}

#[tauri::command]
pub async fn get_library_summary(library_path: String) -> AppResult<LibrarySummaryInfo> {
    run_blocking(move || library::get_library_summary_sync(&library_path)).await
}

#[tauri::command]
pub async fn open_path_in_system(path: String, library_path: Option<String>) -> AppResult<()> {
    run_blocking(move || library::open_path_in_system_sync(&path, library_path.as_deref())).await
}

#[tauri::command]
pub async fn check_library_integrity(
    library_path: String,
    media_paths: Vec<String>,
    thumbnail_paths: Vec<String>,
) -> AppResult<LibraryIntegrityReport> {
    run_blocking(move || {
        let library_root = PathBuf::from(&library_path);

        logger::info(
            "library_integrity",
            format!(
                "checking integrity for library='{}', media_paths={}, thumbnail_paths={}",
                library_root.to_string_lossy(),
                media_paths.len(),
                thumbnail_paths.len()
            ),
        );

        let (checked_media_files, missing_media_files, missing_media_examples) =
            collect_missing_paths(&library_root, media_paths);

        let (checked_thumbnail_files, missing_thumbnail_files, missing_thumbnail_examples) =
            collect_missing_paths(&library_root, thumbnail_paths);

        Ok(LibraryIntegrityReport {
            checked_media_files,
            missing_media_files,
            missing_media_examples,
            checked_thumbnail_files,
            missing_thumbnail_files,
            missing_thumbnail_examples,
        })
    })
    .await
}
