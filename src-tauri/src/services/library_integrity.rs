use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::services::logger;
use crate::AppResult;

// usize counts are annotated `number` (serialized as JSON numbers, not the bigint ts-rs
// emits by default).
#[derive(Serialize, Clone, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct LibraryIntegrityReport {
    #[ts(type = "number")]
    pub checked_media_files: usize,
    #[ts(type = "number")]
    pub missing_media_files: usize,
    pub missing_media_examples: Vec<String>,
    #[ts(type = "number")]
    pub checked_thumbnail_files: usize,
    #[ts(type = "number")]
    pub missing_thumbnail_files: usize,
    pub missing_thumbnail_examples: Vec<String>,
    #[ts(type = "number")]
    pub orphan_media_files: usize,
    pub orphan_media_examples: Vec<String>,
    #[ts(type = "number")]
    pub orphan_thumbnail_files: usize,
    pub orphan_thumbnail_examples: Vec<String>,
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

/// Builds the set of paths the database expects to exist, normalized to forward slashes so it
/// can be compared against files discovered on disk.
fn build_expected_set(stored_paths: &[String]) -> HashSet<String> {
    stored_paths
        .iter()
        .map(|path| path.trim().replace('\\', "/"))
        .filter(|path| !path.is_empty())
        .collect()
}

/// Lists every file under `dir` as a path relative to `root`, using forward slashes.
fn list_files_relative(dir: &Path, root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    let mut stack = vec![dir.to_path_buf()];

    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };

        for entry in entries.flatten() {
            let path = entry.path();

            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                if let Ok(relative) = path.strip_prefix(root) {
                    files.push(relative.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }

    files
}

/// Finds files inside `subdirs` of the library that no database record references. Since the
/// library folder is fully owned by the app (media is copied/moved in), any such file is a
/// leftover taking up disk space.
fn collect_orphan_paths(
    library_root: &Path,
    subdirs: &[&str],
    expected: &HashSet<String>,
) -> (usize, Vec<String>) {
    let mut orphan_count = 0usize;
    let mut orphan_examples: Vec<String> = Vec::new();

    for subdir in subdirs {
        for relative in list_files_relative(&library_root.join(subdir), library_root) {
            if expected.contains(&relative) {
                continue;
            }

            orphan_count += 1;

            if orphan_examples.len() < 5 {
                orphan_examples.push(relative);
            }
        }
    }

    (orphan_count, orphan_examples)
}

/// Compares the database's media/thumbnail path records against what actually exists on disk,
/// reporting files the database references but that are missing, and files on disk that no
/// database record references (orphans).
pub fn check_library_integrity_sync(
    library_path: &str,
    media_paths: Vec<String>,
    thumbnail_paths: Vec<String>,
) -> AppResult<LibraryIntegrityReport> {
    let raw_root = PathBuf::from(library_path);
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

    let media_expected = build_expected_set(&media_paths);
    let thumbnail_expected = build_expected_set(&thumbnail_paths);

    let (checked_media_files, missing_media_files, missing_media_examples) =
        collect_missing_paths(&library_root, media_paths);

    let (checked_thumbnail_files, missing_thumbnail_files, missing_thumbnail_examples) =
        collect_missing_paths(&library_root, thumbnail_paths);

    let (orphan_media_files, orphan_media_examples) =
        collect_orphan_paths(&library_root, &["video", "audio"], &media_expected);

    let (orphan_thumbnail_files, orphan_thumbnail_examples) =
        collect_orphan_paths(&library_root, &["thumbnails"], &thumbnail_expected);

    Ok(LibraryIntegrityReport {
        checked_media_files,
        missing_media_files,
        missing_media_examples,
        checked_thumbnail_files,
        missing_thumbnail_files,
        missing_thumbnail_examples,
        orphan_media_files,
        orphan_media_examples,
        orphan_thumbnail_files,
        orphan_thumbnail_examples,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn check_library_integrity_sync_reports_missing_and_orphan_files() {
        let library = unique_test_dir("service-integrity");
        fs::create_dir_all(library.join("video")).unwrap();
        fs::write(library.join("video").join("a.mp4"), b"data").unwrap();
        // Not referenced by the database -> should be reported as an orphan.
        fs::write(library.join("video").join("orphan.mp4"), b"data").unwrap();

        let report = check_library_integrity_sync(
            library.to_string_lossy().as_ref(),
            vec!["video/a.mp4".to_string(), "video/missing.mp4".to_string()],
            vec!["thumbnails/missing.jpg".to_string()],
        )
        .unwrap();

        assert_eq!(report.checked_media_files, 2);
        assert_eq!(report.missing_media_files, 1);
        assert_eq!(report.checked_thumbnail_files, 1);
        assert_eq!(report.missing_thumbnail_files, 1);
        assert_eq!(report.orphan_media_files, 1);
        assert_eq!(report.orphan_media_examples, vec!["video/orphan.mp4"]);

        let _ = fs::remove_dir_all(&library);
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
        // canonicalization it resolves outside - must be treated as missing
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
