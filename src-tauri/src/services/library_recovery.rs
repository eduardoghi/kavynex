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
pub fn write_commit_marker(marker_path: &Path, new_library_path: &str) -> std::io::Result<()> {
    std::fs::write(marker_path, new_library_path.trim().as_bytes())
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

/// True when `dir` holds at least one of the app's managed subdirectories, i.e. it still looks
/// like a real library location. A migration removes those subdirectories from the old library,
/// so an old directory that survived the migration (as an empty shell) reads as not populated.
fn is_populated_library(dir: &Path) -> bool {
    MANAGED_LIBRARY_DIRS
        .iter()
        .any(|name| dir.join(name).is_dir())
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
    let stored_populated = !stored.is_empty() && is_populated_library(Path::new(stored));

    if stored_populated {
        // The configured library still has its content, so the migration either completed or
        // never removed the old directory. The marker is stale.
        return MarkerOutcome::ClearStale;
    }

    if is_populated_library(Path::new(&new_path)) {
        MarkerOutcome::Recover(new_path)
    } else {
        // Neither the stored path nor the marker target holds library content; there is nothing
        // to recover, so drop the marker rather than keep re-checking it.
        MarkerOutcome::ClearStale
    }
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
        fs::create_dir_all(dir.join("video")).unwrap();
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
    fn evaluate_recovery_clears_marker_when_stored_is_still_populated() {
        let base = unique_dir("still-good");
        let old = base.join("old");
        let new = base.join("new");
        // The configured library still holds its content: the migration completed and the
        // marker is stale.
        make_populated_library(&old);
        make_populated_library(&new);

        let marker = commit_marker_path(&base);
        write_commit_marker(&marker, &new.to_string_lossy()).unwrap();

        assert_eq!(
            evaluate_recovery(&old.to_string_lossy(), &marker),
            MarkerOutcome::ClearStale
        );

        let _ = fs::remove_dir_all(&base);
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
    async fn reconcile_clears_a_stale_marker_when_the_stored_library_is_intact() {
        let base = unique_dir("reconcile-stale");
        let config_dir = base.join("config");
        let old = base.join("old");
        let new = base.join("new");
        fs::create_dir_all(&config_dir).unwrap();
        make_populated_library(&old); // the configured library still has its content
        make_populated_library(&new);

        let marker = commit_marker_path(&config_dir);
        write_commit_marker(&marker, &new.to_string_lossy()).unwrap();

        let pool = memory_settings_pool(&old.to_string_lossy()).await;

        reconcile_interrupted_migration(&pool, &config_dir).await;

        // The stored path is untouched (still `old`) and the stale marker is dropped.
        let (stored,): (String,) =
            sqlx::query_as("SELECT value FROM app_settings WHERE key = 'library_path'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored, old.to_string_lossy());
        assert!(!marker.exists(), "a stale marker must be cleared");

        let _ = fs::remove_dir_all(&base);
    }
}
