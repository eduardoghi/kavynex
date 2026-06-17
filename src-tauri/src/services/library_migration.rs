use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::constants::MANAGED_LIBRARY_DIRS;
use crate::services::filesystem::copy_directory_contents;
use crate::services::library_paths::ensure_library_dir;
use crate::services::logger;
use crate::{AppError, AppErrorCode, AppResult};

#[derive(Serialize, Clone, Debug)]
pub struct MigrateLibraryDirectoryResult {
    pub final_library_path: String,
    pub changed: bool,
}

fn library_migration_lock() -> &'static Mutex<()> {
    static LIBRARY_MIGRATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LIBRARY_MIGRATION_LOCK.get_or_init(|| Mutex::new(()))
}

fn ensure_directory_is_empty(path: &Path) -> AppResult<()> {
    let mut entries = fs::read_dir(path).map_err(|e| {
        AppError::from_code(
            AppErrorCode::InvalidLibraryMigration,
            format!("failed to inspect destination library directory: {e}"),
        )
    })?;

    if entries.next().is_some() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryMigration,
            "the selected library folder is not empty; choose an empty folder to continue",
        ));
    }

    Ok(())
}

pub fn migrate_library_contents(old_library_dir: &Path, new_library_dir: &Path) -> AppResult<()> {
    fs::create_dir_all(new_library_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateNewLibraryDirFailed,
            format!("failed to create new library directory: {e}"),
        )
    })?;

    // Phase 1: copy all files to the new location without touching the originals.
    // If any copy fails here, the old library is still fully intact and the app
    // continues working normally against the old path.
    for dir_name in MANAGED_LIBRARY_DIRS {
        let source_dir = old_library_dir.join(dir_name);
        let destination_dir = new_library_dir.join(dir_name);

        logger::info(
            "library",
            format!(
                "copying managed directory '{}' from '{}' to '{}'",
                dir_name,
                source_dir.to_string_lossy(),
                destination_dir.to_string_lossy()
            ),
        );

        copy_directory_contents(&source_dir, &destination_dir)?;
    }

    // Phase 2: all copies confirmed — remove old directories.
    for dir_name in MANAGED_LIBRARY_DIRS {
        let source_dir = old_library_dir.join(dir_name);

        if source_dir.exists() {
            let _ = fs::remove_dir_all(&source_dir);
        }
    }

    let _ = fs::remove_dir(old_library_dir);

    Ok(())
}

pub fn migrate_library_directory_sync(
    old_library_path: &str,
    new_library_path: &str,
) -> AppResult<MigrateLibraryDirectoryResult> {
    let migration_guard = library_migration_lock().try_lock().map_err(|_| {
        AppError::from_code(
            AppErrorCode::LibraryMigrationAlreadyRunning,
            "a library migration is already running",
        )
    })?;

    let canonical_new = ensure_library_dir(new_library_path)?;
    let old_library_dir = PathBuf::from(old_library_path.trim());

    logger::info(
        "library",
        format!(
            "requested library migration from '{}' to '{}'",
            old_library_path.trim(),
            canonical_new.to_string_lossy()
        ),
    );

    if old_library_dir.as_os_str().is_empty() {
        ensure_directory_is_empty(&canonical_new)?;

        drop(migration_guard);
        return Ok(MigrateLibraryDirectoryResult {
            final_library_path: canonical_new.to_string_lossy().to_string(),
            changed: true,
        });
    }

    if !old_library_dir.exists() {
        ensure_directory_is_empty(&canonical_new)?;

        drop(migration_guard);
        return Ok(MigrateLibraryDirectoryResult {
            final_library_path: canonical_new.to_string_lossy().to_string(),
            changed: true,
        });
    }

    let canonical_old = old_library_dir.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeLibraryPathFailed,
            format!("failed to canonicalize current library path: {e}"),
        )
    })?;

    if canonical_old == canonical_new {
        logger::info(
            "library",
            format!(
                "library migration skipped because paths are identical: '{}'",
                canonical_new.to_string_lossy()
            ),
        );
        drop(migration_guard);
        return Ok(MigrateLibraryDirectoryResult {
            final_library_path: canonical_new.to_string_lossy().to_string(),
            changed: false,
        });
    }

    if canonical_new.starts_with(&canonical_old) {
        drop(migration_guard);
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryMigration,
            "new library path cannot be inside the current library path",
        ));
    }

    if canonical_old.starts_with(&canonical_new) {
        drop(migration_guard);
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryMigration,
            "new library path cannot be a parent directory of the current library path",
        ));
    }

    ensure_directory_is_empty(&canonical_new)?;

    let migration_result = migrate_library_contents(&canonical_old, &canonical_new);

    match &migration_result {
        Ok(_) => logger::info(
            "library",
            format!(
                "library migration finished successfully from '{}' to '{}'",
                canonical_old.to_string_lossy(),
                canonical_new.to_string_lossy()
            ),
        ),
        Err(error) => logger::error(
            "library",
            format!(
                "library migration failed from '{}' to '{}': {}",
                canonical_old.to_string_lossy(),
                canonical_new.to_string_lossy(),
                error
            ),
        ),
    }

    drop(migration_guard);

    migration_result?;

    Ok(MigrateLibraryDirectoryResult {
        final_library_path: canonical_new.to_string_lossy().to_string(),
        changed: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn migration_test_lock() -> &'static Mutex<()> {
        static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        TEST_LOCK.get_or_init(|| Mutex::new(()))
    }

    fn unique_test_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        std::env::temp_dir().join(format!(
            "kavynex-library-migration-test-{}-{}-{}",
            prefix,
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn migrate_library_contents_moves_managed_directories() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("old");
        let new_root = unique_test_dir("new");

        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::create_dir_all(old_root.join("audio")).unwrap();
        fs::create_dir_all(old_root.join("thumbnails")).unwrap();

        fs::write(old_root.join("video").join("a.mp4"), b"video").unwrap();
        fs::write(old_root.join("audio").join("a.mp3"), b"audio").unwrap();
        fs::write(old_root.join("thumbnails").join("a.jpg"), b"thumb").unwrap();

        migrate_library_contents(&old_root, &new_root).unwrap();

        assert!(new_root.join("video").join("a.mp4").exists());
        assert!(new_root.join("audio").join("a.mp3").exists());
        assert!(new_root.join("thumbnails").join("a.jpg").exists());

        let _ = fs::remove_dir_all(new_root);
        let _ = fs::remove_dir_all(old_root);
    }

    #[test]
    fn migrate_library_directory_sync_returns_new_path_when_old_is_empty() {
        let _guard = migration_test_lock().lock().unwrap();

        let new_root = unique_test_dir("empty-old");
        let result =
            migrate_library_directory_sync("   ", new_root.to_string_lossy().as_ref()).unwrap();

        let canonical_new = new_root
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_string();

        assert_eq!(result.final_library_path, canonical_new);
        assert!(result.changed);

        let _ = fs::remove_dir_all(new_root);
    }

    #[test]
    fn migrate_library_directory_sync_returns_new_path_when_old_does_not_exist() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("missing-old");
        let new_root = unique_test_dir("missing-new");

        let result = migrate_library_directory_sync(
            old_root.to_string_lossy().as_ref(),
            new_root.to_string_lossy().as_ref(),
        )
        .unwrap();

        let canonical_new = new_root
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_string();

        assert_eq!(result.final_library_path, canonical_new);
        assert!(result.changed);

        let _ = fs::remove_dir_all(new_root);
    }

    #[test]
    fn migrate_library_directory_sync_skips_when_paths_are_identical() {
        let _guard = migration_test_lock().lock().unwrap();

        let root = unique_test_dir("same");
        fs::create_dir_all(&root).unwrap();

        let result = migrate_library_directory_sync(
            root.to_string_lossy().as_ref(),
            root.to_string_lossy().as_ref(),
        )
        .unwrap();

        let canonical = root.canonicalize().unwrap().to_string_lossy().to_string();
        assert_eq!(result.final_library_path, canonical);
        assert!(!result.changed);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn migrate_library_directory_sync_rejects_child_destination() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("old-child");
        let new_root = old_root.join("nested").join("library");

        fs::create_dir_all(&old_root).unwrap();

        let result = migrate_library_directory_sync(
            old_root.to_string_lossy().as_ref(),
            new_root.to_string_lossy().as_ref(),
        );

        assert!(result.is_err());
        assert_eq!(
            result.err().unwrap().code,
            AppErrorCode::InvalidLibraryMigration.as_str()
        );

        let _ = fs::remove_dir_all(old_root);
    }

    #[test]
    fn migrate_library_directory_sync_rejects_parent_destination() {
        let _guard = migration_test_lock().lock().unwrap();

        let parent_root = unique_test_dir("parent");
        let old_root = parent_root.join("current");

        fs::create_dir_all(&old_root).unwrap();

        let result = migrate_library_directory_sync(
            old_root.to_string_lossy().as_ref(),
            parent_root.to_string_lossy().as_ref(),
        );

        assert!(result.is_err());
        assert_eq!(
            result.err().unwrap().code,
            AppErrorCode::InvalidLibraryMigration.as_str()
        );

        let _ = fs::remove_dir_all(parent_root);
    }

    #[test]
    fn migrate_library_contents_preserves_source_when_copy_fails_mid_migration() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("preserve-old");
        let new_root = unique_test_dir("preserve-new");

        // video dir is processed first; audio dir second
        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::create_dir_all(old_root.join("audio")).unwrap();
        fs::write(old_root.join("video").join("a.mp4"), b"video-data").unwrap();
        fs::write(old_root.join("audio").join("a.mp3"), b"audio-data").unwrap();

        // Pre-create a conflicting audio file in the destination so the copy fails
        // after the video directory has already been processed
        fs::create_dir_all(new_root.join("audio")).unwrap();
        fs::write(new_root.join("audio").join("a.mp3"), b"conflicting-content").unwrap();

        let result = migrate_library_contents(&old_root, &new_root);
        assert!(result.is_err());

        // Both source files must still exist — no data was lost despite partial progress
        assert!(
            old_root.join("video").join("a.mp4").exists(),
            "video file must remain in source after failed migration"
        );
        assert!(
            old_root.join("audio").join("a.mp3").exists(),
            "audio file must remain in source after failed migration"
        );

        let _ = fs::remove_dir_all(&old_root);
        let _ = fs::remove_dir_all(&new_root);
    }

    #[test]
    fn migrate_library_directory_sync_rejects_non_empty_destination() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("old-non-empty");
        let new_root = unique_test_dir("new-non-empty");

        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::create_dir_all(&new_root).unwrap();
        fs::write(new_root.join("already-here.txt"), b"occupied").unwrap();

        let result = migrate_library_directory_sync(
            old_root.to_string_lossy().as_ref(),
            new_root.to_string_lossy().as_ref(),
        );

        assert!(result.is_err());
        assert_eq!(
            result.err().unwrap().code,
            AppErrorCode::InvalidLibraryMigration.as_str()
        );

        let _ = fs::remove_dir_all(old_root);
        let _ = fs::remove_dir_all(new_root);
    }
}
