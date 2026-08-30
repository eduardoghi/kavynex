//! Backup, restore, export, import. Everything this app does with the database *file* rather than
//! with its rows.
//!
//! What lives here is the machinery more than one of those needs, and nothing else. Each of the
//! four is a submodule of its own, split off as the file outgrew itself:
//!
//! - `snapshot.rs`: the automatic `.bak` family and the status report over it.
//! - `restore.rs`: restoring from one, and finishing a restore a crash interrupted.
//! - `import.rs`: staging a user-selected database and applying it at the next startup.
//! - `external.rs`: the user-triggered export and the once-a-day off-volume mirror.
//! - `integrity.rs`: the throttled full `PRAGMA integrity_check`.
//!
//! Most of the tests for all of them are still this module's `mod tests` (in `tests.rs` beside this
//! file, so the module reads as its production code), and one reason for that
//! is genuine while the other was not. The genuine one. Many exercise more than one of the machines
//! together (a snapshot taken, the database corrupted, the restore checked), which is the behavior
//! worth pinning and would have to be duplicated or arbitrarily assigned if it were split along the
//! same line as the code.
//!
//! The other reason was the shared fixtures (`temp_dir`, `seed_db`, `filetime_set`). A test could
//! not move without them, so every split moved code out of this module and left its tests in, and
//! the test file kept growing as the code shrank. Those fixtures now live in `test_support.rs`, so a test that
//! belongs to exactly one submodule can go and live there. `integrity.rs` has taken its four; the
//! rest follow when their submodule is next touched, rather than as one large move of tests nobody
//! is otherwise changing.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

use crate::services::database::SQLITE_BUSY_TIMEOUT_MS;
use crate::services::logger;
use crate::{AppError, AppResult};
// Used by `mod tests` below, which asserts against the codes the submodules return.
#[cfg(test)]
use crate::AppErrorCode;

// Serializes `backup_database` so at most one snapshot runs at a time. Two independent schedulers
// drive it (the pool-init snapshot (services::database) and the periodic loop (lib.rs)), and the
// is_recent() throttle is mtime-based, so it only suppresses a second call once the first has
// finished and refreshed `.bak`. While the first is still vacuuming, a second would pass is_recent()
// too and race it on the shared `.bak.tmp` and the rotate/rename chain, at worst promoting a
// half-written snapshot or burning a rotated generation. A single static lock is enough. There is
// one database process-wide and, unlike the pool, this lock holds no state a test needs to inject.
//
// `restore_database_from_backup` takes it too, which is why it lives here rather than in
// `snapshot.rs`. The restore reads the same `.bak` family a rotation rewrites.
static BACKUP_IN_PROGRESS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn sibling(db_path: &Path, suffix: &str) -> PathBuf {
    let name = db_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("kavynex.db");

    db_path.with_file_name(format!("{name}{suffix}"))
}

/// Shifts a rotated snapshot family up by one generation, dropping the oldest, so a fresh file
/// can be promoted into generation 0 without discarding the previous ones. Generation `N` is
/// overwritten by `N-1`, and so on down to generation 0 becoming generation 1. Best effort. A
/// generation that cannot be moved is left where it is rather than failing the caller.
///
/// Shared by the `.bak`, `.corrupt` and external-mirror families, which is why it takes the
/// per-generation path function rather than knowing any of their names.
fn rotate_generations(db_path: &Path, generations: usize, path_for: fn(&Path, usize) -> PathBuf) {
    for generation in (1..=generations).rev() {
        let source = path_for(db_path, generation - 1);
        let target = path_for(db_path, generation);

        if !source.exists() {
            continue;
        }

        // `rename` already replaces an existing target on both Windows and Unix, so the removal
        // below is only a fallback for the targets rename itself refuses (a locked or read-only
        // file on Windows). It has to come *after* the first attempt rather than before it.
        // Clearing the target up front and then failing to rename into it leaves the snapshot
        // sitting in `source`, which the next iteration's removal would then delete without it
        // ever having been copied anywhere. Silently costing a generation.
        if std::fs::rename(&source, &target).is_ok() {
            continue;
        }

        let _ = std::fs::remove_file(&target);

        if std::fs::rename(&source, &target).is_err() {
            // Stop instead of shifting the generations below into a slot this one still holds.
            // Rotation is best effort, so a generation that cannot be promoted is left where it
            // is, but letting the loop continue would have generation N-1 overwrite it.
            logger::warn(
                "db_backup",
                format!(
                    "backup rotation stopped at generation {generation}: the snapshot could not be promoted"
                ),
            );
            return;
        }
    }
}

fn backup_error(message: impl Into<String>, error: impl std::fmt::Display) -> AppError {
    // Same shape as services::media_comments and the rest of the app. Reuse the single
    // db_error constructor rather than re-deriving the AppError here.
    crate::services::database::db_error(message, error)
}

async fn open(db_path: &Path) -> AppResult<SqlitePool> {
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(false)
        // Backup/export/import can run while the main pool holds the write lock; without
        // a busy timeout any contention surfaces as an immediate SQLITE_BUSY failure.
        .busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS));
    // Unlike the main pool (services::database), this one does not enable
    // `.foreign_keys(true)`. That is intentional, not an oversight. This pool is only ever
    // used read-only (quick_check, VACUUM INTO, import validation), so there are no
    // INSERT/UPDATE/DELETE statements here for FK enforcement to guard against.
    //
    // It is deliberately *not* opened with `query_only`/`read_only` even though it never
    // mutates the source: SQLite requires a writable connection for `VACUUM INTO` (it fails
    // with "attempt to write a readonly database" otherwise). Concurrency is still safe. The
    // main pool runs in WAL mode, where the read snapshot `VACUUM INTO` holds does not block
    // the writer, so the once-a-day background snapshot cannot starve a concurrent write.

    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| backup_error("failed to open database for backup", error))
}

/// True when `modified` is within `min_interval_secs` of `now`. Extracted as a pure function so the
/// backward-clock branch can be tested without setting a file mtime into the future. A `modified`
/// timestamp in the future relative to `now` (the system clock moved backward. An NTP correction,
/// RTC drift) is treated as recent, so a backward clock cannot defeat the once-a-day throttle shared
/// by backup_database, the external mirror and the integrity check and trigger a burst of spurious
/// runs. Worst case is one skipped run until the clock catches back up, never data loss.
fn duration_is_recent(now: SystemTime, modified: SystemTime, min_interval_secs: u64) -> bool {
    match now.duration_since(modified) {
        Ok(age) => age.as_secs() < min_interval_secs,
        Err(_) => true,
    }
}

fn is_recent(path: &Path, min_interval_secs: u64) -> bool {
    let Ok(modified) = std::fs::metadata(path).and_then(|meta| meta.modified()) else {
        return false;
    };

    duration_is_recent(SystemTime::now(), modified, min_interval_secs)
}

async fn is_healthy(pool: &SqlitePool) -> bool {
    match sqlx::query_as::<_, (String,)>("PRAGMA quick_check")
        .fetch_one(pool)
        .await
    {
        Ok((result,)) => result == "ok",
        Err(_) => false,
    }
}

/// Escapes a value for embedding as a single-quoted SQLite string literal by doubling every
/// `'`. This is the ONE place in the whole database layer where non-constant, externally
/// influenced data (the `VACUUM INTO` destination. A user-chosen export path, or the internal
/// temp/backup path) is assembled into raw SQL text rather than bound as a `?` parameter, and it
/// only exists because `VACUUM INTO` is a statement SQLite does not let you parameterize. Every
/// other query in the codebase uses `.bind(...)`. If this function is ever changed, the doubling
/// of every single quote must be preserved. It is the sole guard keeping a path from breaking out
/// of the literal. Covered by the adversarial-path export tests below.
fn escape_sql_literal(value: &str) -> String {
    value.replace('\'', "''")
}

fn modified_ms(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()?;
    modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|age| age.as_millis() as u64)
}

/// Sums the sizes of whichever of `paths` exist. A path that cannot be stat'd contributes zero
/// rather than failing the whole report. This feeds a display-only number, and a missing
/// generation is the normal case, not an error.
fn total_size_bytes(paths: &[PathBuf]) -> u64 {
    paths
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .fold(0u64, |total, size| total.saturating_add(size))
}

/// Every file this module owns beside the live database in the app config directory. The database
/// itself, SQLite's WAL sidecars, all seven backup generations, all three corrupt snapshots, the
/// import undo/staging files, every short-lived scratch file, and the two markers.
/// `docs/DIRECTORIES.md` documents the same set for the user.
///
/// It lives here rather than in any one submodule because it is the only thing that has to know
/// about all of them at once (which is also why the split left it behind.
///
/// Deliberately pure), it names paths without touching the filesystem, so the set is pinned by a
/// test rather than by whatever happens to exist on the machine running it. That matters because
/// the whole point of summing these is that the number is *complete*. A file this module starts
/// writing later and forgets to add here does not report as an error, it silently stops being
/// counted, and the reported size drifts below the real one exactly when the total is largest.
fn managed_database_paths(db_path: &Path) -> Vec<PathBuf> {
    let mut paths = vec![
        db_path.to_path_buf(),
        // SQLite's write-ahead log and shared-memory sidecars, present while the app runs.
        sibling(db_path, "-wal"),
        sibling(db_path, "-shm"),
    ];

    // `.bak` plus `.bak.1`..`.bak.N`, and the scratch file a snapshot vacuums into.
    paths.extend(
        (0..=snapshot::BACKUP_ROTATED_GENERATIONS)
            .map(|generation| snapshot::generation_backup_path(db_path, generation)),
    );
    paths.push(snapshot::temp_backup_path(db_path));

    // `.corrupt` plus its rotated generations, and the scratch name a restore moves through.
    paths.extend(
        (0..=restore::CORRUPT_ROTATED_GENERATIONS)
            .map(|generation| restore::generation_corrupt_path(db_path, generation)),
    );
    paths.push(sibling(db_path, ".corrupt.tmp"));

    paths.extend([
        restore::restore_staging_path(db_path),
        import::pre_import_path(db_path),
        import::import_staged_path(db_path),
        sibling(db_path, ".import-staged.tmp"),
        import::import_applying_marker_path(db_path),
        integrity::integrity_check_marker_path(db_path),
    ]);

    paths
}

/// Opens `db_path` and runs `quick_check`, returning whether it passes. A file that cannot even
/// be opened as a database (or fails the check) returns false. Used both to pick a healthy backup
/// to restore and, in the pool builder, to refuse migrating a database that is already damaged
/// (see `services::database::build_pool_at`).
pub async fn database_quick_check_ok(db_path: &Path) -> bool {
    match open(db_path).await {
        Ok(pool) => {
            let healthy = is_healthy(&pool).await;
            pool.close().await;
            healthy
        }
        Err(_) => false,
    }
}

/// Reads a database file's `user_version` (schema version) without migrating it. Used by restore
/// to refuse a backup produced by a newer app build. Returns `None` if the file cannot be opened
/// or the pragma read fails.
async fn database_schema_version(db_path: &Path) -> Option<i64> {
    let pool = open(db_path).await.ok()?;
    let version: Result<(i64,), _> = sqlx::query_as("PRAGMA user_version").fetch_one(&pool).await;
    pool.close().await;
    version.ok().map(|(value,)| value)
}

/// Whether opening the database will run a schema migration. true when the file is missing
/// (the schema is created on first open) or its `user_version` is below the version this
/// build ships. Callers use this to decide whether the pre-migration snapshot must block
/// startup (only when a migration will actually run), or can be deferred to the background.
/// When the database cannot be inspected, a migration is assumed pending so the safety
/// snapshot is still taken.
pub async fn is_schema_migration_pending(db_path: &Path) -> bool {
    if !db_path.exists() {
        return true;
    }

    let Ok(pool) = open(db_path).await else {
        return true;
    };

    let version: Result<(i64,), _> = sqlx::query_as("PRAGMA user_version").fetch_one(&pool).await;

    pool.close().await;

    match version {
        Ok((current,)) => current < crate::services::db_schema::SCHEMA_VERSION,
        Err(_) => true,
    }
}

// The automatic `.bak` snapshot family and the status report over it.
mod snapshot;
pub use snapshot::{backup_database, database_backup_status, DatabaseBackupStatus};
// The parent module's snapshot tests assert against these internals; test-only so a non-test build
// does not flag them unused.
#[cfg(test)]
use snapshot::{backup_path, temp_backup_path, BACKUP_MIN_INTERVAL_SECS};

// Restoring from a snapshot, and finishing a restore a crash interrupted.
mod restore;
#[cfg(test)]
use restore::{
    corrupt_path, generation_corrupt_path, restore_staging_path, rotate_corrupt_snapshots,
    CORRUPT_ROTATED_GENERATIONS,
};
pub use restore::{restore_database_from_backup, resume_interrupted_restore};

// The full `PRAGMA integrity_check` and its background throttle live in the `integrity` submodule.
mod integrity;
pub use integrity::{
    integrity_check_is_due, mark_integrity_check_passed, run_full_integrity_check,
    DatabaseIntegrityReport,
};
// The integrity tests now live in `integrity.rs` itself, so the `#[cfg(test)] use` that used to
// pull `integrity_check_marker_path` and `MAX_INTEGRITY_PROBLEMS` up here for them is gone with
// them, which is the point of the move. An internal a submodule's own tests reach no longer has
// to be visible to its parent.

// The user-triggered export and the once-a-day external mirror live in the `external` submodule.
mod external;
pub use external::{export_database, mirror_database_to_external_dir};
// The parent module's mirror tests reach these internals; test-only so a non-test build does not
// flag the imports unused.
#[cfg(test)]
use external::{
    external_backup_path, generation_external_backup_path, EXTERNAL_BACKUP_FILE_NAME,
    EXTERNAL_BACKUP_ROTATED_GENERATIONS,
};

mod import;
pub use import::{
    apply_pending_database_import, database_import_undo_available, stage_database_import,
    stage_database_import_undo,
};
// The parent module's import tests reach these internals; test-only so a non-test build does
// not flag the imports unused.
#[cfg(test)]
use import::{
    import_applying_marker_path, import_staged_path, pre_import_path, write_import_applying_marker,
};

// The fixtures the tests in this family share. Declared here rather than inside `mod tests` so a
// submodule's own tests can reach them too; see the module docs above for why that mattered.
#[cfg(test)]
mod test_support;

#[cfg(test)]
mod tests;
