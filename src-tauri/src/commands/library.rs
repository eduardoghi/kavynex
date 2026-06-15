use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

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
    let canonical_library = library_path
        .canonicalize()
        .unwrap_or_else(|_| library_path.to_path_buf());

    let mut unique_paths = HashSet::new();

    for item in stored_paths {
        let trimmed = item.trim();

        if trimmed.is_empty() {
            continue;
        }

        unique_paths.insert(trimmed.to_string());
    }

    let mut checked_count = 0usize;
    let mut missing_count = 0usize;
    let mut missing_examples: Vec<String> = Vec::new();

    for stored_path in unique_paths {
        let candidate = PathBuf::from(&stored_path);

        // Skip paths that attempt to escape the library via parent traversal
        if candidate.components().any(|c| c == Component::ParentDir) {
            continue;
        }

        let resolved_path = resolve_stored_path(&canonical_library, &stored_path);

        // Skip paths that resolve outside the library (e.g. stale absolute paths in the DB).
        if !resolved_path.starts_with(&canonical_library) {
            continue;
        }

        checked_count += 1;

        // canonicalize resolves symlinks - re-check containment on the real path.
        // if the path doesn't exist, canonicalize fails and we treat it as missing.
        let exists_within_library = resolved_path
            .canonicalize()
            .map(|canonical| canonical.starts_with(&canonical_library))
            .unwrap_or(false);

        if !exists_within_library {
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
        let raw_root = PathBuf::from(&library_path);
        let library_root = raw_root.canonicalize().unwrap_or(raw_root);

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "kavynex-integrity-test-{}-{}-{}",
            prefix,
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn collect_missing_paths_counts_existing_relative_path_as_not_missing() {
        let library = unique_test_dir("existing");
        fs::create_dir_all(library.join("video")).unwrap();
        fs::write(library.join("video").join("a.mp4"), b"data").unwrap();

        let (checked, missing, _) =
            collect_missing_paths(&library, vec!["video/a.mp4".to_string()]);

        assert_eq!(checked, 1);
        assert_eq!(missing, 0);

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn collect_missing_paths_counts_missing_relative_path() {
        let library = unique_test_dir("missing");
        fs::create_dir_all(&library).unwrap();

        let (checked, missing, examples) =
            collect_missing_paths(&library, vec!["video/missing.mp4".to_string()]);

        assert_eq!(checked, 1);
        assert_eq!(missing, 1);
        assert_eq!(examples, vec!["video/missing.mp4"]);

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn collect_missing_paths_skips_absolute_path_outside_library() {
        let library = unique_test_dir("outside");
        fs::create_dir_all(&library).unwrap();

        let outside = std::env::temp_dir().to_string_lossy().to_string();

        let (checked, missing, _) = collect_missing_paths(&library, vec![outside]);

        assert_eq!(checked, 0);
        assert_eq!(missing, 0);

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn collect_missing_paths_skips_relative_path_with_parent_traversal() {
        let library = unique_test_dir("traversal");
        fs::create_dir_all(&library).unwrap();

        let (checked, missing, _) = collect_missing_paths(
            &library,
            vec![
                "../outside.txt".to_string(),
                "video/../../secret".to_string(),
            ],
        );

        assert_eq!(checked, 0);
        assert_eq!(missing, 0);

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    #[cfg(unix)]
    fn collect_missing_paths_treats_symlink_pointing_outside_library_as_missing() {
        use std::os::unix::fs::symlink;

        let library = unique_test_dir("symlink");
        let outside = unique_test_dir("symlink-outside");

        fs::create_dir_all(&library).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.mp4"), b"secret").unwrap();

        // Create a symlink inside the library that points outside
        symlink(&outside, library.join("link")).unwrap();

        let (checked, missing, _) =
            collect_missing_paths(&library, vec!["link/secret.mp4".to_string()]);

        // The path appears to be inside the library via starts_with, but after
        // canonicalization it resolves outside — must be treated as missing
        assert_eq!(checked, 1);
        assert_eq!(missing, 1);

        let _ = fs::remove_dir_all(&library);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn collect_missing_paths_deduplicates_repeated_paths() {
        let library = unique_test_dir("dedup");
        fs::create_dir_all(&library).unwrap();

        let (checked, missing, _) = collect_missing_paths(
            &library,
            vec![
                "video/a.mp4".to_string(),
                "video/a.mp4".to_string(),
                "  video/a.mp4  ".to_string(),
            ],
        );

        assert_eq!(checked, 1);
        assert_eq!(missing, 1);

        let _ = fs::remove_dir_all(&library);
    }
}
