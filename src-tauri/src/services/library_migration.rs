use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, TryLockError};

use serde::Serialize;

use crate::constants::MANAGED_LIBRARY_DIRS;
use crate::services::filesystem::copy_directory_contents;
use crate::services::library_paths::ensure_library_dir;
use crate::services::logger;
use crate::{AppError, AppErrorCode, AppResult};

#[derive(Serialize, Clone, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct MigrateLibraryDirectoryResult {
    pub final_library_path: String,
    pub changed: bool,
    /// True when the migration copied the library to the new location but kept the old directory
    /// in place instead of removing it - which happens only when the crash-recovery commit marker
    /// could not be written (removing the old copy would then leave no recoverable path back). The
    /// copy succeeded and the new library is usable, but a full duplicate of the media remains on
    /// the old volume with nothing to clean it up automatically, so the frontend surfaces a notice.
    pub old_directory_retained: bool,
}

fn library_migration_lock() -> &'static Mutex<()> {
    static LIBRARY_MIGRATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LIBRARY_MIGRATION_LOCK.get_or_init(|| Mutex::new(()))
}

/// The destination must be empty, or contain only the app's managed subdirectories
/// (video/audio/thumbnails/live_chat) and nothing else. Empty is the normal case; a destination
/// that holds only managed folders is treated as a previously interrupted migration and allowed
/// to resume - the copy phase is idempotent (identical files are skipped, differing ones error
/// without overwriting), so re-running safely completes the copy. Any top-level entry that is
/// not a managed directory means the folder holds unrelated user content and is rejected, so a
/// crash mid-migration no longer wedges the retry with an opaque "not empty" error.
fn ensure_destination_is_migratable(path: &Path) -> AppResult<()> {
    let entries = fs::read_dir(path).map_err(|e| {
        AppError::from_code(
            AppErrorCode::InvalidLibraryMigration,
            format!("failed to inspect destination library directory: {e}"),
        )
    })?;

    for entry in entries {
        let entry = entry.map_err(|e| {
            AppError::from_code(
                AppErrorCode::InvalidLibraryMigration,
                format!("failed to inspect destination library directory: {e}"),
            )
        })?;

        let name = entry.file_name().to_string_lossy().to_string();
        let is_managed_dir = entry.path().is_dir() && MANAGED_LIBRARY_DIRS.contains(&name.as_str());

        if !is_managed_dir {
            return Err(AppError::from_code(
                AppErrorCode::InvalidLibraryMigration,
                "the selected library folder must be empty (or contain only a previous, interrupted Kavynex migration); choose an empty folder to continue",
            ));
        }
    }

    Ok(())
}

pub fn migrate_library_contents(old_library_dir: &Path, new_library_dir: &Path) -> AppResult<()> {
    copy_library_contents(old_library_dir, new_library_dir)?;
    remove_old_library_contents(old_library_dir);
    Ok(())
}

/// Phase 1: copy all managed directories to the new location without touching the originals.
/// If any copy fails here, the old library is still fully intact and the app continues working
/// normally against the old path.
fn copy_library_contents(old_library_dir: &Path, new_library_dir: &Path) -> AppResult<()> {
    fs::create_dir_all(new_library_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateNewLibraryDirFailed,
            format!("failed to create new library directory: {e}"),
        )
    })?;

    for dir_name in MANAGED_LIBRARY_DIRS {
        let source_dir = old_library_dir.join(dir_name);
        let destination_dir = new_library_dir.join(dir_name);

        logger::info(
            "library",
            format!(
                "copying managed directory '{}' from '{}' to '{}'",
                dir_name,
                logger::redact_path(&source_dir),
                logger::redact_path(&destination_dir)
            ),
        );

        copy_directory_contents(&source_dir, &destination_dir)?;
    }

    Ok(())
}

/// Phase 2: all copies confirmed - remove the old managed directories, then the old library
/// directory itself if nothing unrelated is left in it. Best effort: a removal failure only
/// leaves reclaimable disk behind, never lost data (the new location already holds a full copy).
fn remove_old_library_contents(old_library_dir: &Path) {
    for dir_name in MANAGED_LIBRARY_DIRS {
        let source_dir = old_library_dir.join(dir_name);

        if source_dir.exists() {
            // A partial failure here (a locked file, an AV scanner, a permission hiccup) leaves
            // the managed directory behind holding an unknown subset of its files. That is only
            // reclaimable disk - the new location already holds a full copy - but it must be
            // logged rather than swallowed: the recovery path keys off the marker target being a
            // complete copy, not off the old directory looking empty, precisely so a leftover
            // like this cannot strand the good copy.
            if let Err(error) = fs::remove_dir_all(&source_dir) {
                logger::warn(
                    "library",
                    format!(
                        "failed to remove old managed directory '{}' after migration (reclaimable disk left behind): {error}",
                        logger::redact_path(&source_dir)
                    ),
                );
            }
        }
    }

    let leftovers = list_leftover_entries(old_library_dir);

    if !leftovers.is_empty() {
        let examples = leftovers
            .iter()
            .take(5)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");

        logger::warn(
            "library",
            format!(
                "library migration left {} entr{} behind in the old library directory '{}' that were not part of the managed folders: {}",
                leftovers.len(),
                if leftovers.len() == 1 { "y" } else { "ies" },
                logger::redact_path(old_library_dir),
                examples
            ),
        );
    }

    let _ = fs::remove_dir(old_library_dir);
}

/// Runs the copy/remove phases with a durable commit marker written between them, so an
/// interrupted migration (a crash after the copy but before the frontend persists the new
/// library path) can be recovered on the next launch. When `commit_marker` is `Some` and the
/// marker cannot be written, the old directory is deliberately left intact: reclaiming its disk
/// is not worth removing the only path back to the library when recovery would be impossible.
/// `None` (used by tests) keeps the plain copy-then-remove behavior.
///
/// Returns `true` when the old directory was deliberately kept (the marker could not be written),
/// `false` when it was removed as usual, so the caller can surface the retained-copy state.
fn migrate_library_contents_with_marker(
    old_library_dir: &Path,
    new_library_dir: &Path,
    commit_marker: Option<&Path>,
) -> AppResult<bool> {
    copy_library_contents(old_library_dir, new_library_dir)?;

    if let Some(marker) = commit_marker {
        if let Err(error) = crate::services::library_recovery::write_commit_marker(
            marker,
            &new_library_dir.to_string_lossy(),
        ) {
            logger::warn(
                "library",
                format!(
                    "keeping the old library directory: failed to write the migration commit marker: {error}"
                ),
            );
            return Ok(true);
        }
    }

    remove_old_library_contents(old_library_dir);
    Ok(false)
}

/// Lists the top-level entries of `old_library_dir` that are not one of the managed library
/// folders (video/audio/thumbnails/live_chat). The library folder is normally fully owned by
/// the app, but a user can still drop files directly into it; those are never migrated, so
/// they would otherwise be silently left behind (and keep the old directory from being
/// removed) without any indication of why.
fn list_leftover_entries(old_library_dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(old_library_dir) else {
        return Vec::new();
    };

    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();

            if MANAGED_LIBRARY_DIRS.contains(&name.as_str()) {
                None
            } else {
                Some(name)
            }
        })
        .collect()
}

pub fn migrate_library_directory_sync(
    old_library_path: &str,
    new_library_path: &str,
    commit_marker: Option<&Path>,
) -> AppResult<MigrateLibraryDirectoryResult> {
    let migration_guard = match library_migration_lock().try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::WouldBlock) => {
            return Err(AppError::from_code(
                AppErrorCode::LibraryMigrationAlreadyRunning,
                "a library migration is already running",
            ));
        }
        // A previous migration panicked while holding this lock. The mutex guards no shared
        // state (`Mutex<()>`; it only serializes migrations), so the poison carries no
        // corrupted data - recover the guard and proceed. Treating poison as "already
        // running" would instead wedge every future migration until the app is restarted.
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
    };

    let canonical_new = ensure_library_dir(new_library_path)?;
    let old_library_dir = PathBuf::from(old_library_path.trim());

    logger::info(
        "library",
        format!(
            "requested library migration from '{}' to '{}'",
            logger::redact_path(old_library_path.trim()),
            logger::redact_path(&canonical_new)
        ),
    );

    if old_library_dir.as_os_str().is_empty() {
        ensure_destination_is_migratable(&canonical_new)?;

        drop(migration_guard);
        return Ok(MigrateLibraryDirectoryResult {
            final_library_path: canonical_new.to_string_lossy().to_string(),
            changed: true,
            old_directory_retained: false,
        });
    }

    if !old_library_dir.exists() {
        ensure_destination_is_migratable(&canonical_new)?;

        drop(migration_guard);
        return Ok(MigrateLibraryDirectoryResult {
            final_library_path: canonical_new.to_string_lossy().to_string(),
            changed: true,
            old_directory_retained: false,
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
                logger::redact_path(&canonical_new)
            ),
        );
        drop(migration_guard);
        return Ok(MigrateLibraryDirectoryResult {
            final_library_path: canonical_new.to_string_lossy().to_string(),
            changed: false,
            old_directory_retained: false,
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

    ensure_destination_is_migratable(&canonical_new)?;

    // Hold the exclusive library gate across the copy/remove phase: it drains any in-flight
    // import/download/delete and blocks new ones, so a file can never be written into the old
    // directory in the window between it being copied to the new location and removed. Only the
    // destructive phase needs it; the validation above is read-only. See services/library_lock.
    let migration_result = {
        let _library_write_guard = crate::services::library_lock::library_write_guard();
        migrate_library_contents_with_marker(&canonical_old, &canonical_new, commit_marker)
    };

    match &migration_result {
        Ok(retained) => logger::info(
            "library",
            format!(
                "library migration finished successfully from '{}' to '{}'{}",
                logger::redact_path(&canonical_old),
                logger::redact_path(&canonical_new),
                if *retained {
                    " (the old directory was kept because the commit marker could not be written)"
                } else {
                    ""
                }
            ),
        ),
        Err(error) => logger::error(
            "library",
            format!(
                "library migration failed from '{}' to '{}': {}",
                logger::redact_path(&canonical_old),
                logger::redact_path(&canonical_new),
                error
            ),
        ),
    }

    drop(migration_guard);

    let old_directory_retained = migration_result?;

    Ok(MigrateLibraryDirectoryResult {
        final_library_path: canonical_new.to_string_lossy().to_string(),
        changed: true,
        old_directory_retained,
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
    fn list_leftover_entries_finds_files_outside_managed_dirs() {
        let old_root = unique_test_dir("leftovers");

        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::create_dir_all(old_root.join("thumbnails")).unwrap();
        fs::write(old_root.join("stray-file.txt"), b"leftover").unwrap();

        let leftovers = list_leftover_entries(&old_root);

        assert_eq!(leftovers, vec!["stray-file.txt".to_string()]);

        let _ = fs::remove_dir_all(old_root);
    }

    #[test]
    fn list_leftover_entries_is_empty_when_only_managed_dirs_are_present() {
        let old_root = unique_test_dir("no-leftovers");

        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::create_dir_all(old_root.join("audio")).unwrap();
        fs::create_dir_all(old_root.join("thumbnails")).unwrap();
        fs::create_dir_all(old_root.join("live_chat")).unwrap();

        let leftovers = list_leftover_entries(&old_root);

        assert!(leftovers.is_empty());

        let _ = fs::remove_dir_all(old_root);
    }

    #[test]
    fn migrate_library_contents_keeps_old_dir_when_a_stray_file_is_left_behind() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("stray");
        let new_root = unique_test_dir("stray-new");

        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::write(old_root.join("video").join("a.mp4"), b"video").unwrap();
        // Not part of any managed directory: the migration never touches it, so it stays
        // behind and the old directory can no longer be removed.
        fs::write(old_root.join("notes.txt"), b"leftover notes").unwrap();

        migrate_library_contents(&old_root, &new_root).unwrap();

        assert!(new_root.join("video").join("a.mp4").exists());
        // The stray file (and therefore the old directory) is left in place, best-effort.
        assert!(old_root.join("notes.txt").exists());
        assert!(old_root.exists());

        let _ = fs::remove_dir_all(new_root);
        let _ = fs::remove_dir_all(old_root);
    }

    #[test]
    fn migrate_library_directory_sync_returns_new_path_when_old_is_empty() {
        let _guard = migration_test_lock().lock().unwrap();

        let new_root = unique_test_dir("empty-old");
        let result =
            migrate_library_directory_sync("   ", new_root.to_string_lossy().as_ref(), None)
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
    fn migrate_library_directory_sync_returns_new_path_when_old_does_not_exist() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("missing-old");
        let new_root = unique_test_dir("missing-new");

        let result = migrate_library_directory_sync(
            old_root.to_string_lossy().as_ref(),
            new_root.to_string_lossy().as_ref(),
            None,
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
            None,
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
            None,
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
            None,
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

        // Both source files must still exist - no data was lost despite partial progress
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
    fn migrate_library_directory_sync_resumes_an_interrupted_migration() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("resume-old");
        let new_root = unique_test_dir("resume-new");

        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::write(old_root.join("video").join("a.mp4"), b"video-data").unwrap();
        fs::write(old_root.join("video").join("b.mp4"), b"video-b").unwrap();

        // Simulate a prior migration interrupted mid-copy: the destination already holds the
        // managed "video" dir with one file (identical content) and nothing unrelated.
        fs::create_dir_all(new_root.join("video")).unwrap();
        fs::write(new_root.join("video").join("a.mp4"), b"video-data").unwrap();

        let result = migrate_library_directory_sync(
            old_root.to_string_lossy().as_ref(),
            new_root.to_string_lossy().as_ref(),
            None,
        )
        .unwrap();

        assert!(result.changed);
        // The remaining file is copied and the migration completes instead of failing with a
        // "not empty" error.
        assert!(new_root.join("video").join("a.mp4").exists());
        assert!(new_root.join("video").join("b.mp4").exists());

        let _ = fs::remove_dir_all(old_root);
        let _ = fs::remove_dir_all(new_root);
    }

    #[test]
    fn migrate_library_directory_sync_writes_the_commit_marker_when_it_removes_the_old_library() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("marker-old");
        let new_root = unique_test_dir("marker-new");
        let marker = unique_test_dir("marker-file");
        fs::create_dir_all(marker.parent().unwrap()).unwrap();

        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::write(old_root.join("video").join("a.mp4"), b"video-data").unwrap();

        let result = migrate_library_directory_sync(
            old_root.to_string_lossy().as_ref(),
            new_root.to_string_lossy().as_ref(),
            Some(&marker),
        )
        .unwrap();

        assert!(result.changed);
        // The marker was written, so phase 2 ran and the old directory was not retained.
        assert!(!result.old_directory_retained);
        assert!(new_root.join("video").join("a.mp4").exists());
        // The old managed directory is removed (phase 2 ran)...
        assert!(!old_root.join("video").exists());
        // ...and only because the durable commit marker recording the new path was written
        // first, so a crash before the frontend persisted the new path stays recoverable.
        let recorded = fs::read_to_string(&marker).unwrap();
        assert_eq!(recorded.trim(), result.final_library_path);

        let _ = fs::remove_dir_all(&old_root);
        let _ = fs::remove_dir_all(&new_root);
        let _ = fs::remove_file(&marker);
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
            None,
        );

        assert!(result.is_err());
        assert_eq!(
            result.err().unwrap().code,
            AppErrorCode::InvalidLibraryMigration.as_str()
        );

        let _ = fs::remove_dir_all(old_root);
        let _ = fs::remove_dir_all(new_root);
    }

    #[test]
    fn migrate_library_directory_sync_recovers_from_a_poisoned_lock() {
        let _guard = migration_test_lock().lock().unwrap();

        // Simulate a previous migration that panicked mid-flight while holding the lock.
        let poisoning = std::thread::spawn(|| {
            let _held = library_migration_lock().lock().unwrap();
            panic!("simulated migration panic while holding the lock");
        })
        .join();
        assert!(poisoning.is_err(), "the helper thread should have panicked");
        assert!(library_migration_lock().is_poisoned());

        // The next migration must still succeed: the poison guards no real state, so it is
        // recovered instead of surfacing as a misleading "already running" error that would
        // wedge every future migration until the app restarts.
        let new_root = unique_test_dir("poison-recover");
        let result =
            migrate_library_directory_sync("   ", new_root.to_string_lossy().as_ref(), None)
                .unwrap();
        assert!(result.changed);

        // Leave the shared lock clean for any test that runs after this one.
        library_migration_lock().clear_poison();

        let _ = fs::remove_dir_all(new_root);
    }
}
