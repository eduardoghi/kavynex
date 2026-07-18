//! Durable recovery of an interrupted library-directory migration.
//!
//! A migration copies the whole library to the new location and only then removes the old one
//! (`library_migration`). The frontend persists the new `library_path` in a separate IPC call
//! after the migrate command returns. If the process dies between the copy and that persist,
//! the settings still point at the old (now emptied) directory even though a complete copy
//! exists at the new one - the app looks like it lost the entire library.
//!
//! To make that recoverable, the migration writes a small commit marker recording the new path
//! just before it removes the old directory. On the next settings read, if the configured
//! library no longer has any content but the marker points at a populated directory, the marker
//! path is adopted (see `commands::settings::get_app_settings`). The marker is cleared once a
//! working library path is observed, so it never lingers past the crash it exists to cover.

use std::path::{Path, PathBuf};

use sqlx::SqlitePool;

use crate::constants::MANAGED_LIBRARY_DIRS;
use crate::services::database::{get_app_settings_from_pool, set_library_path_in_pool};
use crate::services::library_guard::paths_refer_to_same_location;
use crate::services::logger;
use crate::utils::task::run_blocking;

const COMMIT_MARKER_FILE_NAME: &str = "library-migration-commit";

/// The commit-marker path for a given app config directory (the directory that also holds the
/// database file). Kept next to the database so it shares the same per-user, writable location.
pub fn commit_marker_path(config_dir: &Path) -> PathBuf {
    config_dir.join(COMMIT_MARKER_FILE_NAME)
}

/// Records the canonical new library path in the commit marker. Written just before the old
/// directory is removed. Returns the underlying I/O error so the migration can decide to keep
/// the old directory when the marker cannot be persisted.
///
/// `sync_all` matters here, exactly as it does for `db_backup`'s import marker: the window this
/// guards is a crash moments after the write, and the very next step removes the old library
/// directory. A marker still sitting in the OS write cache when the machine loses power would be
/// gone on reboot while the old directory was already emptied - the recovery could not adopt the
/// new path, and the library would look lost even though the copy at it is complete.
///
/// `fsync_parent_dir` on top of that flushes the directory entry itself: on common Linux/Unix
/// filesystems a crash right after the create can lose the new entry even though the file's own
/// bytes were fsynced, so the marker would be absent on reboot despite `sync_all` succeeding.
pub fn write_commit_marker(marker_path: &Path, new_library_path: &str) -> std::io::Result<()> {
    use std::io::Write;

    let mut file = std::fs::File::create(marker_path)?;
    file.write_all(new_library_path.trim().as_bytes())?;
    file.sync_all()?;
    crate::services::filesystem::fsync_parent_dir(marker_path);
    Ok(())
}

/// Removes the commit marker. Best effort: a failure only leaves a stale marker that the next
/// evaluation will re-examine and drop.
pub fn clear_commit_marker(marker_path: &Path) {
    let _ = std::fs::remove_file(marker_path);
}

fn read_commit_marker(marker_path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(marker_path).ok()?;
    let trimmed = content.trim().to_string();

    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// True when `dir` holds actual content in at least one of the app's managed subdirectories.
///
/// Deliberately checks for a *file*, not merely the directory's existence: a migration whose
/// `remove_dir_all` failed partway leaves a managed directory behind (possibly with a subset of
/// its files), and an empty leftover shell must not read as a real library. This is what lets the
/// recovery below tell a genuine copy from a half-removed remnant.
fn is_populated_library(dir: &Path) -> bool {
    MANAGED_LIBRARY_DIRS
        .iter()
        .any(|name| dir_contains_a_file(&dir.join(name)))
}

/// True when `dir` exists and contains at least one regular file at any depth. Walks lazily and
/// stops at the first file found, so it is cheap on a populated library.
fn dir_contains_a_file(dir: &Path) -> bool {
    let mut stack = vec![dir.to_path_buf()];

    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };

        for entry in entries.flatten() {
            let path = entry.path();

            if path.is_file() {
                return true;
            } else if path.is_dir() {
                stack.push(path);
            }
        }
    }

    false
}

/// What to do with the commit marker for the currently stored library path.
#[derive(Debug, PartialEq, Eq)]
pub enum MarkerOutcome {
    /// Adopt this path as the library path: the configured library lost its content but the
    /// marker points at a populated directory (a migration that was interrupted before the new
    /// path was persisted).
    Recover(String),
    /// The stored library is fine (or the marker points nowhere useful); drop the stale marker.
    ClearStale,
    /// No marker present; nothing to do.
    None,
}

/// Decides how to reconcile the stored library path with the commit marker. Pure (only reads
/// the filesystem), so it can be unit-tested without a database or a Tauri runtime.
pub fn evaluate_recovery(stored_library_path: &str, marker_path: &Path) -> MarkerOutcome {
    let Some(new_path) = read_commit_marker(marker_path) else {
        return MarkerOutcome::None;
    };

    let stored = stored_library_path.trim();

    // The app already points at the migration target: the migration completed and its new path
    // was persisted, so the marker is stale.
    if !stored.is_empty() && paths_refer_to_same_location(stored, &new_path) {
        return MarkerOutcome::ClearStale;
    }

    // The marker is written only *after* the copy to `new_path` finishes (see
    // `library_migration::migrate_library_contents_with_marker`), so a populated target is a
    // complete copy of the library. Adopt it whenever the app is still pointed elsewhere -
    // including when the old directory only *looks* intact because its removal failed partway
    // through (a partial `remove_dir_all`). Trusting a still-populated old directory here is
    // exactly what would strand the complete copy and leave the app on incomplete data.
    if is_populated_library(Path::new(&new_path)) {
        return MarkerOutcome::Recover(new_path);
    }

    // The marker target no longer holds a usable copy (deleted, or a copy that never finished);
    // there is nothing to recover, so drop the marker rather than keep re-checking it.
    MarkerOutcome::ClearStale
}

/// Reconciles the stored library path with the migration commit marker: if the configured
/// library lost its content but the marker points at a populated directory, the marker path is
/// adopted so an interrupted migration does not look like a lost library. Every failure is logged
/// and swallowed - recovery must never keep the settings from being read. Runs on each settings
/// read (see `commands::settings::get_app_settings`); cheap in the common case (a single stat of a
/// missing marker).
pub async fn reconcile_interrupted_migration(pool: &SqlitePool, config_dir: &Path) {
    let marker = commit_marker_path(config_dir);

    // Common case: no interrupted migration, so a single stat and we are done.
    if !marker.exists() {
        return;
    }

    let stored_library_path = match get_app_settings_from_pool(pool).await {
        Ok(settings) => settings.library_path.unwrap_or_default(),
        Err(_) => return,
    };

    // evaluate_recovery only reads the filesystem; keep those stats off the async worker threads.
    let marker_for_eval = marker.clone();
    let outcome =
        run_blocking(move || Ok(evaluate_recovery(&stored_library_path, &marker_for_eval))).await;

    match outcome {
        Ok(MarkerOutcome::Recover(new_path)) => {
            match set_library_path_in_pool(pool, &new_path).await {
                Ok(()) => {
                    clear_commit_marker(&marker);
                    logger::info(
                        "library",
                        format!(
                        "recovered the library path from an interrupted migration: '{new_path}'"
                    ),
                    );
                }
                Err(error) => logger::warn(
                    "library",
                    format!("failed to persist the recovered library path: {error}"),
                ),
            }
        }
        Ok(MarkerOutcome::ClearStale) => clear_commit_marker(&marker),
        Ok(MarkerOutcome::None) | Err(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        std::env::temp_dir().join(format!(
            "kavynex-library-recovery-{tag}-{}-{}",
            std::process::id(),
            nanos
        ))
    }

    fn make_populated_library(dir: &Path) {
        let video_dir = dir.join("video");
        fs::create_dir_all(&video_dir).unwrap();
        // A real library holds content, not just the managed directory: `is_populated_library`
        // checks for a file so a half-removed shell does not read as populated.
        fs::write(video_dir.join("clip.mp4"), b"data").unwrap();
    }

    #[test]
    fn commit_marker_round_trips() {
        let dir = unique_dir("marker");
        fs::create_dir_all(&dir).unwrap();
        let marker = commit_marker_path(&dir);

        assert_eq!(read_commit_marker(&marker), None);

        write_commit_marker(&marker, "  /library/new  ").unwrap();
        assert_eq!(read_commit_marker(&marker).as_deref(), Some("/library/new"));

        clear_commit_marker(&marker);
        assert_eq!(read_commit_marker(&marker), None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn evaluate_recovery_returns_none_without_a_marker() {
        let dir = unique_dir("no-marker");
        fs::create_dir_all(&dir).unwrap();
        let marker = commit_marker_path(&dir);

        assert_eq!(
            evaluate_recovery(&dir.to_string_lossy(), &marker),
            MarkerOutcome::None
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn evaluate_recovery_recovers_when_stored_lost_its_content() {
        let base = unique_dir("recover");
        let old = base.join("old");
        let new = base.join("new");
        // The old library survives as an empty shell (its managed dirs were removed by the
        // migration); the new library is fully populated.
        fs::create_dir_all(&old).unwrap();
        make_populated_library(&new);

        let marker = commit_marker_path(&base);
        write_commit_marker(&marker, &new.to_string_lossy()).unwrap();

        match evaluate_recovery(&old.to_string_lossy(), &marker) {
            MarkerOutcome::Recover(path) => assert_eq!(path, new.to_string_lossy()),
            other => panic!("expected recovery, got {other:?}"),
        }

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn evaluate_recovery_clears_marker_when_stored_is_already_the_migration_target() {
        let base = unique_dir("already-target");
        let new = base.join("new");
        // The app already points at the migration target: the migration completed and its new
        // path was persisted, so the marker is stale and there is nothing to recover.
        make_populated_library(&new);

        let marker = commit_marker_path(&base);
        write_commit_marker(&marker, &new.to_string_lossy()).unwrap();

        assert_eq!(
            evaluate_recovery(&new.to_string_lossy(), &marker),
            MarkerOutcome::ClearStale
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn evaluate_recovery_recovers_when_the_old_library_was_only_partially_removed() {
        // The CRITICO regression: `remove_dir_all` failed partway, so the old library still holds
        // some content while the new location holds the complete copy. The old code trusted the
        // still-populated old directory and dropped the marker, stranding the good copy; recovery
        // must instead adopt the marker target, which the marker guarantees is a complete copy.
        let base = unique_dir("partial-removal");
        let old = base.join("old");
        let new = base.join("new");

        // Old library with a leftover file its failed removal did not delete.
        let old_video = old.join("video");
        fs::create_dir_all(&old_video).unwrap();
        fs::write(old_video.join("leftover.mp4"), b"partial").unwrap();

        make_populated_library(&new);

        let marker = commit_marker_path(&base);
        write_commit_marker(&marker, &new.to_string_lossy()).unwrap();

        match evaluate_recovery(&old.to_string_lossy(), &marker) {
            MarkerOutcome::Recover(path) => assert_eq!(path, new.to_string_lossy()),
            other => panic!("expected recovery of the complete copy, got {other:?}"),
        }

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn is_populated_library_ignores_an_empty_managed_directory_shell() {
        // A directory that exists but holds no files is a half-removed shell, not a real library.
        let dir = unique_dir("empty-shell");
        fs::create_dir_all(dir.join("video")).unwrap();

        assert!(!is_populated_library(&dir));

        make_populated_library(&dir);
        assert!(is_populated_library(&dir));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn evaluate_recovery_clears_marker_pointing_at_a_gone_target() {
        let base = unique_dir("gone-target");
        let old = base.join("old");
        fs::create_dir_all(&old).unwrap();

        let marker = commit_marker_path(&base);
        write_commit_marker(&marker, &base.join("never-existed").to_string_lossy()).unwrap();

        assert_eq!(
            evaluate_recovery(&old.to_string_lossy(), &marker),
            MarkerOutcome::ClearStale
        );

        let _ = fs::remove_dir_all(&base);
    }

    async fn memory_settings_pool(library_path: &str) -> sqlx::SqlitePool {
        use sqlx::sqlite::SqlitePoolOptions;

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create sqlite memory pool");

        sqlx::query(
            "CREATE TABLE app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("create app_settings table");

        sqlx::query("INSERT INTO app_settings (key, value) VALUES ('library_path', ?)")
            .bind(library_path)
            .execute(&pool)
            .await
            .expect("seed library_path");

        pool
    }

    #[tokio::test]
    async fn reconcile_adopts_the_marker_path_when_the_stored_library_lost_its_content() {
        let base = unique_dir("reconcile-recover");
        let config_dir = base.join("config");
        let old = base.join("old"); // survives the migration as an empty shell
        let new = base.join("new");
        fs::create_dir_all(&config_dir).unwrap();
        fs::create_dir_all(&old).unwrap();
        make_populated_library(&new);

        let marker = commit_marker_path(&config_dir);
        write_commit_marker(&marker, &new.to_string_lossy()).unwrap();

        let pool = memory_settings_pool(&old.to_string_lossy()).await;

        reconcile_interrupted_migration(&pool, &config_dir).await;

        // The stored library path was adopted from the marker, and the marker was cleared.
        let (stored,): (String,) =
            sqlx::query_as("SELECT value FROM app_settings WHERE key = 'library_path'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored, new.to_string_lossy());
        assert!(
            !marker.exists(),
            "the commit marker must be cleared after recovery"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn reconcile_clears_a_stale_marker_when_the_stored_library_is_already_the_target() {
        let base = unique_dir("reconcile-stale");
        let config_dir = base.join("config");
        let new = base.join("new");
        fs::create_dir_all(&config_dir).unwrap();
        // The configured library already is the migration target: the migration completed and
        // was persisted, so the marker is stale.
        make_populated_library(&new);

        let marker = commit_marker_path(&config_dir);
        write_commit_marker(&marker, &new.to_string_lossy()).unwrap();

        let pool = memory_settings_pool(&new.to_string_lossy()).await;

        reconcile_interrupted_migration(&pool, &config_dir).await;

        // The stored path is untouched (still `new`) and the stale marker is dropped.
        let (stored,): (String,) =
            sqlx::query_as("SELECT value FROM app_settings WHERE key = 'library_path'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored, new.to_string_lossy());
        assert!(!marker.exists(), "a stale marker must be cleared");

        let _ = fs::remove_dir_all(&base);
    }
}
