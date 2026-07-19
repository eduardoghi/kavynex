use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

use crate::services::database::SQLITE_BUSY_TIMEOUT_MS;
use crate::services::logger;
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

// The DB is snapshotted at most once per day so it does not add cost to every launch; any
// backup within this window already predates the current launch's migrations.
const BACKUP_MIN_INTERVAL_SECS: u64 = 24 * 60 * 60;

// Keep several rotated generations of the snapshot (`.bak`, `.bak.1`, ...), not just one, so a
// corruption that goes unnoticed for a few days cannot overwrite every good snapshot with a
// degraded one before it is caught. This many *rotated* generations are kept in addition to the
// current `.bak`.
const BACKUP_ROTATED_GENERATIONS: usize = 6;
const CORRUPT_ROTATED_GENERATIONS: usize = 2;

// Serializes `backup_database` so at most one snapshot runs at a time. Two independent schedulers
// drive it - the pool-init snapshot (services::database) and the periodic loop (lib.rs) - and the
// is_recent() throttle is mtime-based, so it only suppresses a second call once the first has
// finished and refreshed `.bak`. While the first is still vacuuming, a second would pass is_recent()
// too and race it on the shared `.bak.tmp` and the rotate/rename chain, at worst promoting a
// half-written snapshot or burning a rotated generation. A single static lock is enough: there is
// one database process-wide and, unlike the pool, this lock holds no state a test needs to inject.
static BACKUP_IN_PROGRESS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn sibling(db_path: &Path, suffix: &str) -> PathBuf {
    let name = db_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("kavynex.db");

    db_path.with_file_name(format!("{name}{suffix}"))
}

fn backup_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".bak")
}

/// The current snapshot is `.bak` (generation 0); older generations are `.bak.1` (newest
/// rotated) through `.bak.{BACKUP_ROTATED_GENERATIONS}` (oldest kept).
fn generation_backup_path(db_path: &Path, generation: usize) -> PathBuf {
    if generation == 0 {
        backup_path(db_path)
    } else {
        sibling(db_path, &format!(".bak.{generation}"))
    }
}

/// Shifts a rotated snapshot family up by one generation, dropping the oldest, so a fresh file
/// can be promoted into generation 0 without discarding the previous ones: generation `N` is
/// overwritten by `N-1`, and so on down to generation 0 becoming generation 1. Best effort - a
/// generation that cannot be moved is left where it is rather than failing the caller.
fn rotate_generations(db_path: &Path, generations: usize, path_for: fn(&Path, usize) -> PathBuf) {
    for generation in (1..=generations).rev() {
        let source = path_for(db_path, generation - 1);
        let target = path_for(db_path, generation);

        if !source.exists() {
            continue;
        }

        // `rename` already replaces an existing target on both Windows and Unix, so the removal
        // below is only a fallback for the targets rename itself refuses (a locked or read-only
        // file on Windows). It has to come *after* the first attempt rather than before it:
        // clearing the target up front and then failing to rename into it leaves the snapshot
        // sitting in `source`, which the next iteration's removal would then delete without it
        // ever having been copied anywhere - silently costing a generation.
        if std::fs::rename(&source, &target).is_ok() {
            continue;
        }

        let _ = std::fs::remove_file(&target);

        if std::fs::rename(&source, &target).is_err() {
            // Stop instead of shifting the generations below into a slot this one still holds.
            // Rotation is best effort, so a generation that cannot be promoted is left where it
            // is - but letting the loop continue would have generation N-1 overwrite it.
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

/// Shifts the rotated backup generations up by one so a fresh snapshot can be promoted into
/// `.bak`: `.bak.{N}` is overwritten by `.bak.{N-1}`, down to `.bak` becoming `.bak.1`.
fn rotate_backups(db_path: &Path) {
    rotate_generations(db_path, BACKUP_ROTATED_GENERATIONS, generation_backup_path);
}

fn temp_backup_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".bak.tmp")
}

fn backup_error(message: impl Into<String>, error: impl std::fmt::Display) -> AppError {
    // Same shape as services::media_comments and the rest of the app: reuse the single
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
    // `.foreign_keys(true)`. That is intentional, not an oversight: this pool is only ever
    // used read-only (quick_check, VACUUM INTO, import validation), so there are no
    // INSERT/UPDATE/DELETE statements here for FK enforcement to guard against.
    //
    // It is deliberately *not* opened with `query_only`/`read_only` even though it never
    // mutates the source: SQLite requires a writable connection for `VACUUM INTO` (it fails
    // with "attempt to write a readonly database" otherwise). Concurrency is still safe - the
    // main pool runs in WAL mode, where the read snapshot `VACUUM INTO` holds does not block
    // the writer, so the once-a-day background snapshot cannot starve a concurrent write.

    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| backup_error("failed to open database for backup", error))
}

fn is_recent(path: &Path, min_interval_secs: u64) -> bool {
    let Ok(modified) = std::fs::metadata(path).and_then(|meta| meta.modified()) else {
        return false;
    };

    match SystemTime::now().duration_since(modified) {
        Ok(age) => age.as_secs() < min_interval_secs,
        Err(_) => false,
    }
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

// The full `PRAGMA integrity_check` and its background throttle live in the `integrity` submodule.
mod integrity;
pub use integrity::{
    integrity_check_is_due, mark_integrity_check_passed, run_full_integrity_check,
    DatabaseIntegrityReport,
};
// The parent module's integrity tests assert against these internals; test-only so a non-test
// build does not flag them unused.
#[cfg(test)]
use integrity::{integrity_check_marker_path, MAX_INTEGRITY_PROBLEMS};

/// Escapes a value for embedding as a single-quoted SQLite string literal by doubling every
/// `'`. This is the ONE place in the whole database layer where non-constant, externally
/// influenced data (the `VACUUM INTO` destination - a user-chosen export path, or the internal
/// temp/backup path) is assembled into raw SQL text rather than bound as a `?` parameter, and it
/// only exists because `VACUUM INTO` is a statement SQLite does not let you parameterize. Every
/// other query in the codebase uses `.bind(...)`. If this function is ever changed, the doubling
/// of every single quote must be preserved: it is the sole guard keeping a path from breaking out
/// of the literal. Covered by the adversarial-path export tests below.
fn escape_sql_literal(value: &str) -> String {
    value.replace('\'', "''")
}

/// Creates a consistent snapshot of the database (via `VACUUM INTO`) before migrations run,
/// so a bad migration or corruption can be rolled back. Best effort and throttled to once a
/// day; a source database that fails `quick_check` is skipped so a corrupt DB never
/// overwrites a good backup. Keeps several rotated generations (`.bak` plus `.bak.1`..
/// `.bak.{BACKUP_ROTATED_GENERATIONS}`). Returns true when a new snapshot was written.
pub async fn backup_database(db_path: &Path) -> AppResult<bool> {
    if !db_path.exists() {
        return Ok(false);
    }

    // Wait for any in-flight backup rather than skipping: once it releases the lock it has already
    // refreshed `.bak`, so the is_recent() check below then sees it and this caller returns early
    // without a redundant second vacuum. Waiting (not try_lock) is what makes that de-dup work.
    let _guard = BACKUP_IN_PROGRESS.lock().await;

    let backup = backup_path(db_path);

    if is_recent(&backup, BACKUP_MIN_INTERVAL_SECS) {
        return Ok(false);
    }

    let pool = open(db_path).await?;

    if !is_healthy(&pool).await {
        pool.close().await;
        logger::warn(
            "db_backup",
            "skipping backup: source database failed quick_check",
        );
        return Ok(false);
    }

    let temp = temp_backup_path(db_path);
    let _ = std::fs::remove_file(&temp);

    let vacuum_sql = format!(
        "VACUUM INTO '{}'",
        escape_sql_literal(&temp.to_string_lossy())
    );
    let vacuum_result = sqlx::query(sqlx::AssertSqlSafe(vacuum_sql))
        .execute(&pool)
        .await;
    pool.close().await;
    vacuum_result.map_err(|error| backup_error("failed to snapshot database", error))?;

    // Shift the existing generations up, then promote the fresh snapshot into `.bak`.
    rotate_backups(db_path);

    // Rotation has already moved the previous `.bak` to `.bak.1`, so a failure here leaves
    // generation 0 absent until the next successful backup. A restore still succeeds - the
    // candidate list falls through to `.bak.1` and beyond - but the newest snapshot silently
    // did not land, which is only inferable from backup timestamps. Log it before propagating
    // so the state is observable.
    if let Err(error) = std::fs::rename(&temp, &backup) {
        logger::warn(
            "db_backup",
            format!(
                "failed to promote the fresh snapshot after rotating generations; \
                 the newest backup slot is empty until the next run: {error}"
            ),
        );

        return Err(backup_error("failed to store database backup", error));
    }

    // Flush the directory entry so a crash right after the rename cannot lose it. The rotation
    // renames above live in the same directory, so this one flush covers the whole `.bak` family;
    // without it an unclean shutdown could silently revert to a rotated generation. Mirrors the
    // fsync the restore/import swaps already do (see resume_interrupted_restore / apply_pending_
    // database_import). Best effort, like those.
    crate::services::filesystem::fsync_parent_dir(&backup);

    Ok(true)
}

/// Whether opening the database will run a schema migration: true when the file is missing
/// (the schema is created on first open) or its `user_version` is below the version this
/// build ships. Callers use this to decide whether the pre-migration snapshot must block
/// startup - only when a migration will actually run - or can be deferred to the background.
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

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct DatabaseBackupStatus {
    pub available: bool,
    /// Modification time of the backup that would be restored, in epoch milliseconds.
    #[ts(type = "number | null")]
    pub backed_up_at_ms: Option<u64>,
}

fn corrupt_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".corrupt")
}

/// The database set aside by the most recent restore is `.corrupt` (generation 0); earlier ones
/// are `.corrupt.1` through `.corrupt.{CORRUPT_ROTATED_GENERATIONS}`.
fn generation_corrupt_path(db_path: &Path, generation: usize) -> PathBuf {
    if generation == 0 {
        corrupt_path(db_path)
    } else {
        sibling(db_path, &format!(".corrupt.{generation}"))
    }
}

/// Shifts the corrupt snapshots up a generation so a second restore does not discard the
/// evidence from the first. Fewer generations are kept than for `.bak`: each one is a full copy
/// of a database that is already known to be broken, so this bounds the disk they can occupy
/// while still leaving repeated corruption diagnosable.
fn rotate_corrupt_snapshots(db_path: &Path) {
    rotate_generations(
        db_path,
        CORRUPT_ROTATED_GENERATIONS,
        generation_corrupt_path,
    );
}

/// Where `restore_database_from_backup` stages the chosen snapshot before renaming it into place.
fn restore_staging_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".restore.tmp")
}

/// Finishes a restore that was interrupted between moving the old database aside and renaming the
/// staged snapshot into place.
///
/// That window is only two renames wide, but if the process dies inside it the database file is
/// simply absent - and the pool opens with `create_if_missing(true)`, so the next launch would
/// create a fresh, empty one and present an empty library while the user's data sits untouched in
/// `.restore.tmp` (and `.corrupt`) right next to it. Nothing would say so: the app would look like
/// a first run. Recoverable by hand, but only by someone who knows to look.
///
/// Deliberately narrow: it acts only when the database is missing *and* a staging file is present,
/// which is exactly the interrupted state - a normal launch has a database and never reaches the
/// rename. Runs at startup before the pool can open, and before any pending import is applied, so
/// an import staged on top of a restore still sets the restored database aside as its undo
/// snapshot rather than nothing. Returns whether a restore was resumed.
pub fn resume_interrupted_restore(db_path: &Path) -> AppResult<bool> {
    let staged = restore_staging_path(db_path);

    if db_path.exists() || !staged.exists() {
        return Ok(false);
    }

    std::fs::rename(&staged, db_path)
        .map_err(|error| backup_error("failed to resume an interrupted restore", error))?;
    // Flush the directory entry so the swap survives a crash right after it; otherwise the next
    // launch could find the database missing again and re-run this from a staging file that the
    // rename appeared to consume.
    crate::services::filesystem::fsync_parent_dir(db_path);

    logger::warn(
        "db_backup",
        "resumed a restore that was interrupted before the database was renamed into place",
    );

    Ok(true)
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

/// The existing backup files, most recent first. Rotation always writes the freshest snapshot
/// to `.bak` (generation 0), so it precedes the rotated `.bak.1`.. `.bak.N` generations.
///
/// `.bak.tmp` is included last. `backup_database` snapshots into it and only renames it into
/// `.bak` once the `VACUUM INTO` succeeds, so a run that died in that window leaves a complete,
/// already-health-checked snapshot sitting there that nothing else would ever look at. It goes
/// last, not first, even though it is the freshest: a run that instead died *during* the vacuum
/// leaves a partial file under the same name, and there is no way to tell the two apart here.
/// Every caller re-runs `quick_check` on the candidate it picks, which is what makes offering
/// this safe - a torn file is rejected there, and a healthy one is only reached when no real
/// generation survived.
fn backup_candidates(db_path: &Path) -> Vec<PathBuf> {
    (0..=BACKUP_ROTATED_GENERATIONS)
        .map(|generation| generation_backup_path(db_path, generation))
        .chain(std::iter::once(temp_backup_path(db_path)))
        .filter(|path| path.exists())
        .collect()
}

/// Reports whether a backup file exists (without verifying its integrity) and when the
/// most recent one was written, so the frontend can offer to restore it.
pub fn database_backup_status(db_path: &Path) -> DatabaseBackupStatus {
    match backup_candidates(db_path).first() {
        Some(path) => DatabaseBackupStatus {
            available: true,
            backed_up_at_ms: modified_ms(path),
        },
        None => DatabaseBackupStatus {
            available: false,
            backed_up_at_ms: None,
        },
    }
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

/// Restores the database from the most recent backup that passes `quick_check`, preferring
/// the newest generation and falling back to the rotated one. The current (assumed corrupt)
/// database and its WAL/`-shm` sidecars are moved aside to `.corrupt` rather than deleted,
/// so they can still be inspected, and the sidecars are dropped so the restored snapshot is
/// never combined with a stale write-ahead log.
///
/// The restored file is staged and renamed into place so a failure never leaves the live
/// database missing. The caller must ensure the pool is not already open before calling.
pub async fn restore_database_from_backup(db_path: &Path) -> AppResult<()> {
    // Serialize against backup_database, which rotates and rewrites the same `.bak` family this
    // function reads. The periodic backup scheduler starts at launch, and a restore runs during that
    // same window (it is only reachable after the pool failed to open), so without sharing this lock
    // a rotation in flight could make a candidate vanish between backup_candidates' exists() filter
    // and the quick_check/copy on it - failing a recovery exactly when it matters most.
    let _guard = BACKUP_IN_PROGRESS.lock().await;

    let mut chosen: Option<PathBuf> = None;
    let mut skipped_newer_schema = false;

    for candidate in backup_candidates(db_path) {
        if !database_quick_check_ok(&candidate).await {
            continue;
        }

        // Refuse a backup whose schema is newer than this build supports: restoring it would only
        // "succeed" for `ensure_schema` to reject it on the next open (DatabaseSchemaTooNew),
        // leaving the app unable to start. Catching it here fails the restore itself with a clear
        // message. A backup written by this or an older build always passes.
        if let Some(version) = database_schema_version(&candidate).await {
            if version > crate::services::db_schema::SCHEMA_VERSION {
                skipped_newer_schema = true;
                continue;
            }
        }

        chosen = Some(candidate);
        break;
    }

    let backup = match chosen {
        Some(backup) => backup,
        None if skipped_newer_schema => {
            return Err(AppError::from_code_with_details(
                AppErrorCode::DatabaseSchemaTooNew,
                "the available database backup was created by a newer version of the app",
                "refused to restore a backup whose schema version is newer than this build supports",
            ));
        }
        None => {
            return Err(AppError::from_code(
                AppErrorCode::NoDatabaseBackupAvailable,
                "no healthy database backup is available to restore",
            ));
        }
    };

    // Stage the restored file first so the live database is never left missing on failure. The
    // copy is a full-file read/write of a possibly large database; run it off the async runtime so
    // a slow disk (a network share, a cloud-synced folder) never stalls a Tokio worker thread.
    let staged = restore_staging_path(db_path);
    let _ = std::fs::remove_file(&staged);
    {
        let copy_source = backup.clone();
        let copy_dest = staged.clone();
        run_blocking(move || {
            std::fs::copy(&copy_source, &copy_dest)
                .map_err(|error| backup_error("failed to stage restored database", error))?;
            // Flush the staged bytes to disk before the rename below. The rename is atomic against a
            // process crash, but without this a power loss could leave a truncated staged file that
            // the rename then makes the live database - and resume_interrupted_restore would finish
            // that rename on the next launch, trusting the staged file. This matches copy_file_atomic.
            crate::services::filesystem::fsync_file(&copy_dest)
        })
        .await?;
    }

    // Move the corrupt database aside and drop its sidecar WAL files. Rotate rather than
    // overwrite: a second restore (the restored database degraded again) would otherwise discard
    // the first failure's evidence, which is exactly the case where repeated corruption most
    // needs diagnosing.
    //
    // Move it under a scratch name *before* rotating. Rotating first would shift the existing
    // generations - dropping the oldest and emptying the `.corrupt` slot - and a rename that then
    // failed would leave that loss with nothing put in its place, so a couple of failed restores
    // would evict every earlier snapshot while adding none. Rotating only once the database is
    // safely out of the way keeps the generations intact on failure.
    if db_path.exists() {
        let pending = sibling(db_path, ".corrupt.tmp");
        let _ = std::fs::remove_file(&pending);

        if let Err(error) = std::fs::rename(db_path, &pending) {
            let _ = std::fs::remove_file(&staged);
            return Err(backup_error(
                "failed to move aside the corrupt database",
                error,
            ));
        }

        rotate_corrupt_snapshots(db_path);

        if let Err(error) = std::fs::rename(&pending, corrupt_path(db_path)) {
            // The database is already off the live path, so the restore can still proceed; the
            // evidence just keeps the scratch name. Say so rather than lose the thread.
            logger::warn(
                "db_backup",
                format!(
                    "the corrupt database was set aside as .corrupt.tmp because it could not be \
                     renamed into the .corrupt slot: {error}"
                ),
            );
        }
    }

    let _ = std::fs::remove_file(sibling(db_path, "-wal"));
    let _ = std::fs::remove_file(sibling(db_path, "-shm"));

    std::fs::rename(&staged, db_path)
        .map_err(|error| backup_error("failed to restore database from backup", error))?;
    // Flush the directory entry so the restored database is durably in place, not just staged.
    crate::services::filesystem::fsync_parent_dir(db_path);

    logger::info(
        "db_backup",
        format!(
            "database restored from backup: {}",
            backup
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(".bak")
        ),
    );

    Ok(())
}

fn import_staged_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".import-staged")
}

fn pre_import_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".pre-import")
}

/// Marks that an import swap is in progress. Written before the current database is moved aside
/// and cleared once the swap - or its rollback - has left a database back at `db_path`.
///
/// A marker that survives a restart is the only way to tell the two states apart that otherwise
/// look identical on disk (a staged import, a `.pre-import`, and a file at `db_path`): a normal
/// second import, where `.pre-import` is last import's undo copy and `db_path` is the user's real
/// database, versus a swap that died in between, where `.pre-import` holds the *only* copy of the
/// user's database and `db_path` is an empty file the pool created afterwards with
/// `create_if_missing`. Consuming `.pre-import` in the second case destroys the library for good.
fn import_applying_marker_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".import-applying")
}

/// Writes the marker durably. `sync_all` matters here: the window this guards is a process that
/// dies moments later, so a marker still sitting in the OS write cache would be worthless.
/// `fsync_parent_dir` flushes the directory entry too: without it a crash right after the create
/// can lose the entry on common Linux/Unix filesystems even though the bytes were fsynced, so the
/// marker the recovery in `apply_pending_database_import` reads would be absent on reboot.
fn write_import_applying_marker(marker: &Path) -> AppResult<()> {
    use std::io::Write;

    let mut file = std::fs::File::create(marker)
        .map_err(|error| backup_error("failed to mark the import as in progress", error))?;
    file.write_all(b"import swap in progress\n")
        .and_then(|_| file.sync_all())
        .map_err(|error| backup_error("failed to mark the import as in progress", error))?;
    crate::services::filesystem::fsync_parent_dir(marker);
    Ok(())
}

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

async fn validate_import_source(pool: &SqlitePool) -> AppResult<()> {
    if !is_healthy(pool).await {
        return Err(AppError::from_code(
            AppErrorCode::DatabaseImportInvalid,
            "the selected database failed an integrity check",
        ));
    }

    // Require every core table, not just `videos`. A file with only a stray `videos` table
    // (and a high user_version, so the baseline reconcile in `ensure_schema` would not run)
    // could otherwise be swapped in and then fail every query at runtime with "no such
    // table"/"no such column". Checking the full set keeps a foreign or truncated database
    // from being accepted as a kavynex one.
    for table in ["channels", "videos", "video_comments", "app_settings"] {
        let (count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?")
                .bind(table)
                .fetch_one(pool)
                .await
                .map_err(|error| backup_error("failed to inspect the selected database", error))?;

        if count == 0 {
            return Err(AppError::from_code(
                AppErrorCode::DatabaseImportInvalid,
                "the selected file is not a kavynex database",
            ));
        }
    }

    // The table names alone are not enough. A database carrying those four names with different
    // *columns* - a namesake schema from another app, a hand-edited file, a half-finished
    // migration - passes the check above, and if it is also stamped at this build's
    // SCHEMA_VERSION then `ensure_schema` treats it as current and repairs nothing. It would swap
    // in cleanly and then fail with "no such column" on the first query, after the previous
    // database had already been set aside. Spot-check the columns each table is actually queried
    // through so that lands here, as a refused import, instead.
    //
    // Deliberately a sample, not a schema diff: enough to tell a kavynex database from a
    // look-alike, while leaving the additive columns the migrations themselves add (and backfill)
    // to `ensure_schema`, which is what a genuinely older database needs.
    const REQUIRED_COLUMNS: [(&str, &str); 9] = [
        ("channels", "id"),
        ("channels", "youtube_handle"),
        ("videos", "id"),
        ("videos", "channel_id"),
        ("videos", "file_path"),
        ("videos", "media_type"),
        ("video_comments", "video_id"),
        ("app_settings", "key"),
        ("app_settings", "value"),
    ];

    for (table, column) in REQUIRED_COLUMNS {
        let has_column = crate::services::db_schema::table_has_column(pool, table, column)
            .await
            .map_err(|error| backup_error("failed to inspect the selected database", error))?;

        if !has_column {
            return Err(AppError::from_code(
                AppErrorCode::DatabaseImportInvalid,
                "the selected file is not a kavynex database",
            ));
        }
    }

    // The columns can all be present while the row-level guarantees the app relies on are silently
    // absent - a look-alike or hand-built database that named the columns but omitted the
    // constraints. Three of those cannot be repaired after the swap and must land here as a refused
    // import: without the (channel_id, file_path) unique index the insert_media upsert's
    // ON CONFLICT target has nothing to match, so every insert fails; without the videos -> channels
    // ON DELETE CASCADE a channel delete leaves its videos orphaned; and without the
    // video_comments -> videos ON DELETE CASCADE a media delete (a bare DELETE FROM videos, see
    // library_cleanup) leaves that media's comment rows orphaned forever, with nothing in the
    // library diagnostics to reconcile them. Enabling PRAGMA foreign_keys cannot rescue any of
    // these - it only enforces constraints the DDL declares, it never adds one - so the shape has
    // to be verified before the database is accepted.
    let has_unique_media_key = crate::services::db_schema::table_has_unique_index_on(
        pool,
        "videos",
        &["channel_id", "file_path"],
    )
    .await
    .map_err(|error| backup_error("failed to inspect the selected database", error))?;

    let has_channel_cascade = crate::services::db_schema::table_has_cascade_foreign_key(
        pool,
        "videos",
        "channel_id",
        "channels",
    )
    .await
    .map_err(|error| backup_error("failed to inspect the selected database", error))?;

    let has_comment_cascade = crate::services::db_schema::table_has_cascade_foreign_key(
        pool,
        "video_comments",
        "video_id",
        "videos",
    )
    .await
    .map_err(|error| backup_error("failed to inspect the selected database", error))?;

    if !has_unique_media_key || !has_channel_cascade || !has_comment_cascade {
        return Err(AppError::from_code(
            AppErrorCode::DatabaseImportInvalid,
            "the selected file is not a kavynex database",
        ));
    }

    let (user_version,): (i64,) = sqlx::query_as("PRAGMA user_version")
        .fetch_one(pool)
        .await
        .map_err(|error| backup_error("failed to read the database schema version", error))?;

    if user_version > crate::services::db_schema::SCHEMA_VERSION {
        return Err(AppError::from_code(
            AppErrorCode::DatabaseSchemaTooNew,
            "the selected database was created by a newer version of the app",
        ));
    }

    // A row with no `title_normalized` is invisible to the library search - `LIKE` never matches a
    // NULL - while still sitting in the library, which is the kind of loss the user only notices
    // much later, looking for something they know they saved.
    //
    // The version gate is the whole point: below v11 the column legitimately holds NULLs (or does
    // not exist), and importing such a database is fine because `ensure_schema` runs the v11
    // backfill right after the swap. At v11 or above it claims to be backfilled already, so
    // `ensure_schema` skips straight past it and the NULLs would survive untouched forever. The
    // trigger cannot catch this either: an import replaces the whole file, so no INSERT ever fires.
    if user_version >= 11 {
        let (unnormalized,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM videos WHERE title_normalized IS NULL")
                .fetch_one(pool)
                .await
                .map_err(|error| backup_error("failed to inspect the selected database", error))?;

        if unnormalized > 0 {
            return Err(AppError::from_code(
                AppErrorCode::DatabaseImportInvalid,
                "the selected database has media whose searchable title was never computed, so it would be missing from every search",
            ));
        }
    }

    Ok(())
}

/// Validates a user-provided database file and stages it for import. The swap is deferred to
/// the next startup (`apply_pending_database_import`) because the live connection pool is a
/// process-wide singleton that cannot be reopened in-process. Rejects a file that is not a
/// healthy database, is not a kavynex database, or was created by a newer app version.
pub async fn stage_database_import(db_path: &Path, source_path: &Path) -> AppResult<()> {
    if !source_path.exists() {
        return Err(AppError::from_code(
            AppErrorCode::DatabaseImportInvalid,
            "the selected file does not exist",
        ));
    }

    let pool = open(source_path).await.map_err(|_| {
        AppError::from_code(
            AppErrorCode::DatabaseImportInvalid,
            "the selected file is not a valid database",
        )
    })?;
    let validation = validate_import_source(&pool).await;

    if validation.is_ok() {
        // Fold any not-yet-checkpointed WAL frames of the source into its main database file
        // before it is copied below. The staging copy takes only the `.db` file, never the
        // source's `-wal`/`-shm` sidecars, so a source that is a raw copy of a *live* WAL-mode
        // database (as opposed to a `VACUUM INTO` export, which has no WAL) would otherwise
        // silently drop whatever committed writes still sat in its WAL. Best effort: a source
        // on read-only media cannot be checkpointed, but such a source was not being written
        // to either, so its `.db` is already self-contained.
        //
        // The pragma reports whether it actually finished, and that has to be read rather than
        // discarded: it answers `busy = 1` when another connection held a lock and frames were
        // left behind. Copying then produces a database quietly missing its most recent commits,
        // which is worse than refusing - the user would have no way to tell. `log` is the frames
        // still in the WAL afterwards, so `busy` alone is not the test: a busy answer with an
        // empty WAL has nothing left to lose and is fine to import.
        let checkpoint = sqlx::query_as::<_, (i64, i64, i64)>("PRAGMA wal_checkpoint(TRUNCATE)")
            .fetch_optional(&pool)
            .await;

        match checkpoint {
            Ok(Some((busy, remaining_frames, _))) => {
                if busy != 0 && remaining_frames > 0 {
                    pool.close().await;

                    return Err(AppError::from_code(
                        AppErrorCode::DatabaseImportInvalid,
                        "the selected database is still in use, so its most recent changes could \
                         not be read; close the app that has it open and try again",
                    ));
                }
            }
            // The checkpoint could not be evaluated at all (an I/O error, or no row where the
            // pragma always returns one). Proceeding would copy the `.db` with no confirmation
            // that its WAL was folded in, which is exactly the silent recent-commit loss the busy
            // case above refuses - so refuse here too rather than let the anomaly fall through.
            Ok(None) | Err(_) => {
                pool.close().await;

                return Err(AppError::from_code(
                    AppErrorCode::DatabaseImportInvalid,
                    "the selected database could not be prepared for import, so its most recent \
                     changes could not be confirmed; try exporting it again and re-importing",
                ));
            }
        }
    }

    pool.close().await;
    validation?;

    // Stage atomically: copy to a temp name, then rename into the staged slot so a partial
    // copy is never picked up on the next startup.
    let staged = import_staged_path(db_path);
    let staging_tmp = sibling(db_path, ".import-staged.tmp");
    let _ = std::fs::remove_file(&staging_tmp);
    // Full-file copy of the (possibly large) source database: run it off the async runtime so a
    // slow source disk never stalls a Tokio worker thread.
    {
        let copy_source = source_path.to_path_buf();
        let copy_dest = staging_tmp.clone();
        run_blocking(move || {
            std::fs::copy(&copy_source, &copy_dest)
                .map_err(|error| backup_error("failed to stage database import", error))?;
            // Flush the copied bytes before the rename below. Only the `.db` file is carried across;
            // apply_pending_database_import swaps this staged file in on the next startup without
            // re-reading its source, so a power loss that left it truncated must not survive the
            // rename into `.import-staged`.
            crate::services::filesystem::fsync_file(&copy_dest)
        })
        .await?;
    }
    let _ = std::fs::remove_file(&staged);
    std::fs::rename(&staging_tmp, &staged)
        .map_err(|error| backup_error("failed to stage database import", error))?;
    // Make the staged slot's directory entry durable, so a crash after this cannot lose the rename
    // and leave a `.import-staged.tmp` the next launch would ignore.
    crate::services::filesystem::fsync_parent_dir(&staged);

    Ok(())
}

/// Restores a `.pre-import` snapshot that an interrupted import stranded as the only copy of the
/// database, when its staged file is gone so the normal swap can never consume it. Removes any empty
/// `db_path` the pool may have created on an earlier launch (a rename onto an existing file fails on
/// Windows), renames the snapshot back into place, makes it durable and clears the marker. Trusts
/// the same invariant the swap path does: a marker with a `.pre-import` behind it means `db_path`
/// holds no real data.
fn recover_stranded_pre_import(db_path: &Path, pre_import: &Path, marker: &Path) -> AppResult<()> {
    logger::warn(
        "db_backup",
        "an interrupted import left the pre-import snapshot as the only database copy and its staged \
         file is gone; restoring the snapshot rather than starting with an empty database",
    );

    let _ = std::fs::remove_file(sibling(db_path, "-wal"));
    let _ = std::fs::remove_file(sibling(db_path, "-shm"));
    let _ = std::fs::remove_file(db_path);

    std::fs::rename(pre_import, db_path).map_err(|error| {
        backup_error("failed to restore the stranded pre-import snapshot", error)
    })?;

    crate::services::filesystem::fsync_parent_dir(db_path);
    let _ = std::fs::remove_file(marker);

    Ok(())
}

/// Applies a database import staged by `stage_database_import`, if one is pending. Runs at
/// startup before the pool opens: the current database is moved aside to `.pre-import` (a
/// safety net) and the staged file is swapped in, dropping stale WAL sidecars. On a swap
/// failure the previous database is rolled back so the app still has one to open. Returns
/// whether an import was applied.
pub fn apply_pending_database_import(db_path: &Path) -> AppResult<bool> {
    let staged = import_staged_path(db_path);
    let pre_import = pre_import_path(db_path);
    let marker = import_applying_marker_path(db_path);

    if !staged.exists() {
        // Normally there is nothing to apply. But a marker with a `.pre-import` behind it means an
        // earlier run died mid-swap and `.pre-import` holds the only copy of the database. The main
        // path below handles that when the staged file is still present; if the staged file was
        // additionally lost in that window, this early return would let the pool create an empty
        // database over the stranded snapshot. Restore it here instead so that cannot happen.
        if marker.exists() && pre_import.exists() {
            recover_stranded_pre_import(db_path, &pre_import, &marker)?;
        }

        return Ok(false);
    }

    // A marker left behind by an earlier run means that run died between the move-aside and the
    // swap below, or that its rollback failed. `.pre-import` then holds the only copy of the
    // user's database, and anything at `db_path` is the empty file the pool created afterwards
    // with `create_if_missing` - never their data. Moving that empty file aside would overwrite
    // the real snapshot and lose the library permanently, with no undo left to offer, so the
    // move-aside is skipped and `.pre-import` is kept as this run's undo copy. The swap below
    // then discards the empty file, which is all it is good for.
    //
    // The marker is what makes the two states distinguishable at all: `db_path` present plus a
    // `.pre-import` plus a staged import is also exactly what a perfectly normal *second* import
    // looks like, and that one does have to consume the old undo copy.
    //
    // Reading the marker this way is only sound because it is written *after* the move-aside
    // succeeds (see below), so its presence really does mean `.pre-import` holds the database.
    // `.pre-import` is required to actually be there on top of that: a marker with no snapshot
    // behind it cannot be describing a database this function set aside, so the claim it makes is
    // not true and acting on it would skip the move-aside while `db_path` is still the user's real
    // library. That combination is unreachable through the ordering below, which is exactly why it
    // must not be trusted when it does turn up - a rollback that put the database back but failed
    // to clear the marker leaves it, as would anything editing these files out of band.
    let recovering_from_a_failed_swap = marker.exists() && pre_import.exists();

    if recovering_from_a_failed_swap {
        logger::warn(
            "db_backup",
            "an earlier import died mid-swap: keeping the existing pre-import snapshot as the undo copy",
        );
    } else if db_path.exists() {
        // Only consume the previous undo snapshot when this run is about to replace it in the
        // same step, so a crash can never leave the database file gone with `.pre-import` already
        // removed. (`resume_interrupted_restore` only covers `.restore.tmp`, not a staged import,
        // and the move-aside is a rename rather than a copy, so nothing else would put it back.)
        let _ = std::fs::remove_file(&pre_import);

        std::fs::rename(db_path, &pre_import)
            .map_err(|error| backup_error("failed to set aside the current database", error))?;

        // Durable only once `.pre-import` actually holds the user's database, which is the claim
        // the recovery branch above reads it as. Written *before* the move-aside it would also
        // cover the window where that rename had not run yet - and there `db_path` is still the
        // user's real database, not the pool's empty file, so a crash in that window left the next
        // run skipping the move-aside and letting the swap below overwrite the library with no
        // undo copy behind it.
        if let Err(error) = write_import_applying_marker(&marker) {
            // Nothing is in flight for a marker to describe: put the database back so the next run
            // sees an ordinary pending import rather than a half-applied one.
            if let Err(rollback_error) = std::fs::rename(&pre_import, db_path) {
                // Both the marker write and the rollback failed, so the database now lives only in
                // `.pre-import` with nothing pointing there (the marker never got written). Log
                // prominently so the snapshot can be restored by hand rather than the next launch
                // silently creating an empty database via `create_if_missing`.
                logger::error(
                    "db_backup",
                    format!(
                        "database import rollback failed after a marker-write error; the previous database is preserved at the .pre-import snapshot beside kavynex.db and must be restored by hand: {rollback_error}"
                    ),
                );
            }

            return Err(error);
        }
    }

    let _ = std::fs::remove_file(sibling(db_path, "-wal"));
    let _ = std::fs::remove_file(sibling(db_path, "-shm"));

    if let Err(error) = std::fs::rename(&staged, db_path) {
        // Roll the previous database back so the app is never left without one. When the rollback
        // succeeds the database is whole again and the marker has to go with it; when it fails,
        // the marker is exactly what tells the next run that `.pre-import` is the only real copy.
        if std::fs::rename(&pre_import, db_path).is_ok() {
            let _ = std::fs::remove_file(&marker);
        }

        return Err(backup_error("failed to apply the imported database", error));
    }

    // The imported database is in place; flush the directory entry so the swap is durable before
    // the marker is cleared. Clearing the marker before this is fine - a crash in between only
    // leaves a stale marker with a whole database at `db_path`, which the recovery branch above
    // rejects because `.pre-import` no longer holds the sole copy.
    crate::services::filesystem::fsync_parent_dir(db_path);

    let _ = std::fs::remove_file(&marker);

    logger::info("db_backup", "imported database applied on startup");

    Ok(true)
}

/// Whether a `.pre-import` snapshot from the last applied import exists, so the frontend can
/// offer to undo that import. The snapshot persists across restarts until the next import
/// overwrites it.
pub fn database_import_undo_available(db_path: &Path) -> bool {
    pre_import_path(db_path).exists()
}

/// Stages the `.pre-import` snapshot (the database as it was before the last applied import)
/// as a pending import, so the last import is reverted on the next startup. This deliberately
/// reuses the normal import path - the same validation and the same atomic, deferred swap in
/// `apply_pending_database_import` - so the live connection pool is never swapped underneath
/// while the app is running, whether the undo is triggered from Settings (pool open) or from
/// the startup recovery flow (pool closed). The caller relaunches the app afterward. Errors
/// when there is no snapshot to revert to.
pub async fn stage_database_import_undo(db_path: &Path) -> AppResult<()> {
    let pre_import = pre_import_path(db_path);

    if !pre_import.exists() {
        return Err(AppError::from_code(
            AppErrorCode::NoDatabaseImportToUndo,
            "there is no previous database to restore from the last import",
        ));
    }

    stage_database_import(db_path, &pre_import).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("kavynex_dbbak_{label}_{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn seed_db(path: &Path) {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO t (v) VALUES ('hello')")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
    }

    #[tokio::test]
    async fn backup_creates_a_valid_snapshot() {
        let dir = temp_dir("valid");
        let db = dir.join("kavynex.db");
        seed_db(&db).await;

        assert!(backup_database(&db).await.unwrap());

        let bak = backup_path(&db);
        assert!(bak.exists());

        let options = SqliteConnectOptions::new()
            .filename(&bak)
            .create_if_missing(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        let (value,): (String,) = sqlx::query_as("SELECT v FROM t LIMIT 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(value, "hello");
        pool.close().await;

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn backup_is_throttled_when_recent() {
        let dir = temp_dir("throttle");
        let db = dir.join("kavynex.db");
        seed_db(&db).await;

        assert!(backup_database(&db).await.unwrap());
        assert!(!backup_database(&db).await.unwrap());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn concurrent_backups_run_one_at_a_time() {
        // Model the two schedulers firing together (pool-init snapshot + periodic tick): with the
        // in-progress lock, exactly one call writes the snapshot and the other, once it acquires
        // the lock, sees the fresh `.bak` via is_recent and skips. Without the lock both would pass
        // is_recent (neither `.bak` written yet) and fight over the shared `.bak.tmp`, so both would
        // return true - which this asserts against.
        let dir = temp_dir("concurrent");
        let db = dir.join("kavynex.db");
        seed_db(&db).await;

        let (first, second) = tokio::join!(backup_database(&db), backup_database(&db));
        let first = first.unwrap();
        let second = second.unwrap();

        assert_ne!(
            first, second,
            "one backup must run and the other skip, not both"
        );
        assert!(backup_path(&db).exists());

        // The promoted `.bak` must be a whole database, not a half-written `.bak.tmp`.
        let options = SqliteConnectOptions::new()
            .filename(backup_path(&db))
            .create_if_missing(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        let (value,): (String,) = sqlx::query_as("SELECT v FROM t LIMIT 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(value, "hello");
        pool.close().await;

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn backup_skips_when_source_missing() {
        let dir = temp_dir("missing");
        let db = dir.join("kavynex.db");

        assert!(!backup_database(&db).await.unwrap());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn integrity_check_is_due_until_a_pass_is_marked() {
        let dir = temp_dir("integrity-due");
        let db = dir.join("kavynex.db");

        // Never run: due.
        assert!(integrity_check_is_due(&db));

        // After a clean check is recorded, the throttle suppresses the next one.
        mark_integrity_check_passed(&db);
        assert!(integrity_check_marker_path(&db).exists());
        assert!(!integrity_check_is_due(&db));

        let _ = std::fs::remove_dir_all(&dir);
    }

    async fn read_single_value(path: &Path) -> String {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        let (value,): (String,) = sqlx::query_as("SELECT v FROM t LIMIT 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        pool.close().await;
        value
    }

    #[tokio::test]
    async fn mirror_writes_a_readable_copy_into_the_external_dir() {
        let dir = temp_dir("ext-write-src");
        let db = dir.join("kavynex.db");
        seed_db(&db).await;

        let external = temp_dir("ext-write-dest");

        assert!(mirror_database_to_external_dir(&db, &external)
            .await
            .unwrap());

        let current = external_backup_path(&external);
        assert!(current.exists());
        assert_eq!(read_single_value(&current).await, "hello");
        // The staging file is renamed into place, never left behind.
        assert!(!external
            .join(format!("{EXTERNAL_BACKUP_FILE_NAME}.new"))
            .exists());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&external);
    }

    #[tokio::test]
    async fn mirror_is_throttled_when_recent() {
        let dir = temp_dir("ext-throttle-src");
        let db = dir.join("kavynex.db");
        seed_db(&db).await;

        let external = temp_dir("ext-throttle-dest");

        assert!(mirror_database_to_external_dir(&db, &external)
            .await
            .unwrap());
        // A second run within the 24h window is a no-op: the mirror was just written.
        assert!(!mirror_database_to_external_dir(&db, &external)
            .await
            .unwrap());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&external);
    }

    #[tokio::test]
    async fn mirror_skips_when_the_external_dir_is_missing() {
        let dir = temp_dir("ext-missing-src");
        let db = dir.join("kavynex.db");
        seed_db(&db).await;

        // A path that does not exist stands in for an unplugged external drive.
        let external = dir.join("unplugged-drive");
        assert!(!external.exists());

        assert!(!mirror_database_to_external_dir(&db, &external)
            .await
            .unwrap());
        // The missing directory is never recreated (it could now resolve to another device).
        assert!(!external.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn external_backup_generations_rotate_up() {
        let dir = temp_dir("ext-rotate");

        std::fs::write(generation_external_backup_path(&dir, 0), b"gen0").unwrap();
        std::fs::write(generation_external_backup_path(&dir, 1), b"gen1").unwrap();

        rotate_generations(
            &dir,
            EXTERNAL_BACKUP_ROTATED_GENERATIONS,
            generation_external_backup_path,
        );

        // gen0 -> gen1 and gen1 -> gen2, leaving generation 0 free for a fresh mirror.
        assert!(!generation_external_backup_path(&dir, 0).exists());
        assert_eq!(
            std::fs::read(generation_external_backup_path(&dir, 1)).unwrap(),
            b"gen0"
        );
        assert_eq!(
            std::fs::read(generation_external_backup_path(&dir, 2)).unwrap(),
            b"gen1"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn backup_status_reports_availability() {
        let dir = temp_dir("status");
        let db = dir.join("kavynex.db");
        seed_db(&db).await;

        assert!(!database_backup_status(&db).available);

        assert!(backup_database(&db).await.unwrap());

        let status = database_backup_status(&db);
        assert!(status.available);
        assert!(status.backed_up_at_ms.is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn restore_replaces_corrupt_database_and_preserves_it() {
        let dir = temp_dir("restore");
        let db = dir.join("kavynex.db");
        seed_db(&db).await;
        assert!(backup_database(&db).await.unwrap());

        // Corrupt the live database by overwriting it with garbage.
        std::fs::write(&db, b"not a database").unwrap();

        restore_database_from_backup(&db).await.unwrap();

        // The restored database is usable again and holds the backed-up data.
        assert_eq!(read_single_value(&db).await, "hello");

        // The corrupt copy is preserved for inspection, not deleted.
        assert!(corrupt_path(&db).exists());
        assert_eq!(std::fs::read(corrupt_path(&db)).unwrap(), b"not a database");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn restore_rotates_previous_corrupt_snapshots_instead_of_discarding_them() {
        let dir = temp_dir("restore-corrupt-rotate");
        let db = dir.join("kavynex.db");
        seed_db(&db).await;
        assert!(backup_database(&db).await.unwrap());

        // First corruption and restore: the broken database lands in `.corrupt`.
        std::fs::write(&db, b"first corruption").unwrap();
        restore_database_from_backup(&db).await.unwrap();
        assert_eq!(
            std::fs::read(corrupt_path(&db)).unwrap(),
            b"first corruption"
        );

        // A second corruption and restore must not throw the first one away: it rotates to
        // `.corrupt.1` while the newest takes `.corrupt`. Overwriting instead would destroy the
        // evidence of exactly the repeated-corruption case worth diagnosing.
        std::fs::write(&db, b"second corruption").unwrap();
        restore_database_from_backup(&db).await.unwrap();

        assert_eq!(read_single_value(&db).await, "hello");
        assert_eq!(
            std::fs::read(corrupt_path(&db)).unwrap(),
            b"second corruption"
        );
        assert_eq!(
            std::fs::read(generation_corrupt_path(&db, 1)).unwrap(),
            b"first corruption"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn corrupt_snapshot_rotation_drops_only_the_oldest_generation() {
        let dir = temp_dir("corrupt-rotate-bound");
        let db = dir.join("kavynex.db");

        // Fill every kept generation, then rotate once more: the oldest falls off the end and
        // the rest shift up, so the family stays bounded instead of growing per restore.
        for generation in 0..=CORRUPT_ROTATED_GENERATIONS {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                generation_corrupt_path(&db, generation),
                format!("gen{generation}"),
            )
            .unwrap();
        }

        rotate_corrupt_snapshots(&db);

        // Generation 0 is now free for the incoming snapshot.
        assert!(!corrupt_path(&db).exists());

        for generation in 1..=CORRUPT_ROTATED_GENERATIONS {
            assert_eq!(
                std::fs::read(generation_corrupt_path(&db, generation)).unwrap(),
                format!("gen{}", generation - 1).into_bytes()
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotation_stops_instead_of_overwriting_a_generation_it_could_not_promote() {
        // Rotation walks the generations oldest-first, promoting each into the slot above it. A
        // promotion that fails leaves that snapshot still sitting in its own slot - so carrying on
        // to the next generation would rename the one below straight over it, destroying a snapshot
        // that was never copied anywhere. Stopping is what keeps a failed promotion cost-free.
        let dir = temp_dir("rotate-blocked-generation");
        let db = dir.join("kavynex.db");
        std::fs::create_dir_all(&dir).unwrap();

        std::fs::write(generation_corrupt_path(&db, 0), b"gen0").unwrap();
        std::fs::write(generation_corrupt_path(&db, 1), b"gen1").unwrap();

        // A directory on the oldest slot is something `rename` refuses to write over and
        // `remove_file` cannot clear, so generation 1 has nowhere to be promoted to. This is the
        // stand-in for what blocks it in the wild: a locked or read-only file on Windows.
        std::fs::create_dir(generation_corrupt_path(&db, CORRUPT_ROTATED_GENERATIONS)).unwrap();

        rotate_corrupt_snapshots(&db);

        // Generation 1 could not be promoted, so it has to be left intact rather than overwritten
        // by generation 0 shifting up into a slot that is still occupied.
        assert_eq!(
            std::fs::read(generation_corrupt_path(&db, 1)).unwrap(),
            b"gen1"
        );
        assert_eq!(
            std::fs::read(generation_corrupt_path(&db, 0)).unwrap(),
            b"gen0"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Reproduces the crash window in `restore_database_from_backup`: the process dies between
    /// the rename that moves the old database aside and the one that renames the staged snapshot
    /// into place, leaving no database at all next to a `.restore.tmp` holding the real data.
    fn simulate_restore_interrupted_after_moving_db_aside(db: &Path, staged_contents: &Path) {
        std::fs::copy(staged_contents, restore_staging_path(db)).unwrap();
        std::fs::rename(db, corrupt_path(db)).unwrap();
    }

    #[tokio::test]
    async fn resume_finishes_a_restore_interrupted_before_the_final_rename() {
        let dir = temp_dir("resume-restore");
        let db = dir.join("kavynex.db");
        seed_db(&db).await;
        assert!(backup_database(&db).await.unwrap());

        simulate_restore_interrupted_after_moving_db_aside(&db, &backup_path(&db));

        // The state a crash leaves behind: no database, but the staged snapshot is right there.
        // Opening the pool now would create_if_missing a fresh, empty one.
        assert!(!db.exists());
        assert!(restore_staging_path(&db).exists());

        assert!(resume_interrupted_restore(&db).unwrap());

        // The database is back with its data, and the staging file is consumed.
        assert_eq!(read_single_value(&db).await, "hello");
        assert!(!restore_staging_path(&db).exists());
    }

    #[tokio::test]
    async fn resume_is_a_noop_on_a_normal_launch() {
        let dir = temp_dir("resume-noop");
        let db = dir.join("kavynex.db");
        seed_db(&db).await;

        // No staging file: nothing was interrupted.
        assert!(!resume_interrupted_restore(&db).unwrap());
        assert_eq!(read_single_value(&db).await, "hello");

        // A staging file left over while the database is present must not clobber the live
        // database - only the "database missing" state is the interrupted one.
        std::fs::write(restore_staging_path(&db), b"not a database").unwrap();
        assert!(!resume_interrupted_restore(&db).unwrap());
        assert_eq!(read_single_value(&db).await, "hello");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_interrupted_import_already_resumes_itself() {
        // Unlike the restore path, an import interrupted in the same window needs no help: its
        // staging file is `.import-staged`, which apply_pending_database_import already looks for
        // at startup, and it skips the move-aside when the database is missing. Pinned so the
        // asymmetry is a documented fact rather than something to be re-derived.
        let dir = temp_dir("import-resumes");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "current").await;

        let source = dir.join("incoming.db");
        seed_kavynex_db(&source, "imported").await;
        stage_database_import(&db, &source).await.unwrap();

        // Crash after the database was moved aside, before the staged file was renamed in.
        std::fs::rename(&db, pre_import_path(&db)).unwrap();
        assert!(!db.exists());

        assert!(apply_pending_database_import(&db).unwrap());
        assert_eq!(read_video_title(&db).await, "imported");

        // The interrupted run left `.pre-import` holding the *only* copy of the previous
        // database (the move-aside above is a rename, not a copy). Applying the staged import
        // must not consume it: without this, the undo snapshot - and with it the user's whole
        // previous library - is deleted here with no way back, since the resume path never
        // repopulates it.
        assert!(pre_import_path(&db).exists());
        assert_eq!(read_video_title(&pre_import_path(&db)).await, "current");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_import_retried_after_a_failed_swap_keeps_the_real_pre_import_snapshot() {
        // The state left by a swap that failed *and* whose rollback also failed: the database was
        // moved aside into `.pre-import` (the only copy of the user's library), the staged import
        // never made it in, and the app then carried on and let the pool create an empty
        // `kavynex.db` in its place. On the next launch this function runs again and sees a
        // database file - the empty one. Without the marker it cannot tell that state apart from a
        // normal second import, consumes `.pre-import` for the empty file, and the library is gone
        // permanently with no undo left. Same class as the crash the test above pins, one restart
        // later.
        let dir = temp_dir("import-retry-after-failed-swap");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "current").await;

        let source = dir.join("incoming.db");
        seed_kavynex_db(&source, "imported").await;
        stage_database_import(&db, &source).await.unwrap();

        // The failed swap: database moved aside, marker still in place because the rollback did
        // not get it back.
        write_import_applying_marker(&import_applying_marker_path(&db)).unwrap();
        std::fs::rename(&db, pre_import_path(&db)).unwrap();
        // The app kept running and the pool created a fresh empty database in its place.
        seed_kavynex_db(&db, "empty interim database").await;

        assert!(apply_pending_database_import(&db).unwrap());
        assert_eq!(read_video_title(&db).await, "imported");

        // The undo copy must still be the user's real database, not the interim file.
        assert!(pre_import_path(&db).exists());
        assert_eq!(read_video_title(&pre_import_path(&db)).await, "current");
        // A completed swap clears the marker, so the next import behaves normally again.
        assert!(!import_applying_marker_path(&db).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_stranded_pre_import_is_restored_when_the_staged_file_is_gone() {
        // The same failed-swap state as the test above, but the staged import file was additionally
        // lost in that window (external deletion, disk trouble on that file). With no staged file the
        // normal swap can never run, so a bare early return would let the pool create an empty
        // database over `.pre-import` - the only remaining copy of the library. Recovery must instead
        // salvage the snapshot.
        let dir = temp_dir("stranded-pre-import");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "current").await;

        let source = dir.join("incoming.db");
        seed_kavynex_db(&source, "imported").await;
        stage_database_import(&db, &source).await.unwrap();

        // Failed swap: marker written, database moved aside into `.pre-import`.
        write_import_applying_marker(&import_applying_marker_path(&db)).unwrap();
        std::fs::rename(&db, pre_import_path(&db)).unwrap();
        // Then the staged file is lost and the pool created an empty interim database in its place.
        std::fs::remove_file(import_staged_path(&db)).unwrap();
        seed_kavynex_db(&db, "empty interim database").await;

        // No import is applied (the staged file is gone), but the snapshot is salvaged: the real
        // library is back at db_path, the undo copy is consumed, and the marker is cleared.
        assert!(!apply_pending_database_import(&db).unwrap());
        assert_eq!(read_video_title(&db).await, "current");
        assert!(!pre_import_path(&db).exists());
        assert!(!import_applying_marker_path(&db).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_marker_with_no_snapshot_behind_it_never_skips_the_move_aside() {
        // The other half of the marker's contract, and the one that decides whether it is safe to
        // act on at all: the marker only means "`.pre-import` holds the user's database" because
        // it is written *after* the move-aside succeeds. Written before it, it would also be there
        // in the window where that rename had not run yet - and there `db_path` is still the real
        // library rather than the pool's empty file, so treating the marker as a recovery signal
        // would skip the move-aside and let the swap below overwrite the library outright, with
        // nothing in `.pre-import` to undo it with.
        //
        // The ordering makes that state unreachable; requiring `.pre-import` to actually exist is
        // what keeps it survivable if it shows up anyway (a rollback that restored the database but
        // failed to clear the marker leaves exactly this).
        let dir = temp_dir("import-marker-without-snapshot");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "current").await;

        let source = dir.join("incoming.db");
        seed_kavynex_db(&source, "imported").await;
        stage_database_import(&db, &source).await.unwrap();

        // A marker claiming a move-aside that never happened: the database is untouched and there
        // is no snapshot behind the claim.
        write_import_applying_marker(&import_applying_marker_path(&db)).unwrap();
        assert!(!pre_import_path(&db).exists());

        assert!(apply_pending_database_import(&db).unwrap());
        assert_eq!(read_video_title(&db).await, "imported");

        // The library that was sitting at `db_path` has to have been set aside rather than
        // overwritten, so the import stays undoable.
        assert!(pre_import_path(&db).exists());
        assert_eq!(read_video_title(&pre_import_path(&db)).await, "current");
        assert!(!import_applying_marker_path(&db).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_move_aside_whose_marker_cannot_be_written_is_rolled_back() {
        // The move-aside now runs before the marker, so a failure to write the marker leaves the
        // database already set aside with nothing recording that fact. Returning the error there
        // and walking away would leave `db_path` missing, and the app carries on past a failed
        // import (lib.rs only logs), so the pool would create an empty database in its place and
        // the next run would read that as an ordinary second import and consume `.pre-import` -
        // the only copy. Undoing the move-aside is what keeps the failure inert.
        let dir = temp_dir("import-marker-write-fails");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "current").await;

        let source = dir.join("incoming.db");
        seed_kavynex_db(&source, "imported").await;
        stage_database_import(&db, &source).await.unwrap();

        // A directory sitting on the marker path is something `File::create` cannot write over,
        // which fails the marker write without touching anything else.
        std::fs::create_dir(import_applying_marker_path(&db)).unwrap();

        assert!(apply_pending_database_import(&db).is_err());

        // The database has to be back where it was, still holding the user's library, with the
        // import left pending rather than half-applied.
        assert!(db.exists());
        assert_eq!(read_video_title(&db).await, "current");
        assert!(!pre_import_path(&db).exists());
        assert!(import_staged_path(&db).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_normal_second_import_still_replaces_the_previous_undo_snapshot() {
        // The counterpart to the test above, and the reason the marker exists rather than a plain
        // "does `.pre-import` exist?" check: on disk, a second import looks exactly like the
        // recovery state (staged import + `.pre-import` + a file at db_path). This one *must*
        // consume the old undo copy - skipping the move-aside here would let the swap overwrite
        // the user's live database with no undo at all.
        let dir = temp_dir("import-second-normal");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "first").await;

        let first_source = dir.join("second.db");
        seed_kavynex_db(&first_source, "second").await;
        stage_database_import(&db, &first_source).await.unwrap();
        assert!(apply_pending_database_import(&db).unwrap());
        assert_eq!(read_video_title(&pre_import_path(&db)).await, "first");

        let second_source = dir.join("third.db");
        seed_kavynex_db(&second_source, "third").await;
        stage_database_import(&db, &second_source).await.unwrap();
        assert!(apply_pending_database_import(&db).unwrap());

        assert_eq!(read_video_title(&db).await, "third");
        // The undo copy tracks the *last* import, so it is now the database this import replaced.
        assert_eq!(read_video_title(&pre_import_path(&db)).await, "second");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn import_rejects_a_namesake_database_whose_columns_are_wrong() {
        // The four table names with the wrong columns: another app's namesake schema, a
        // hand-edited file, a half-finished migration. Stamped at this build's SCHEMA_VERSION,
        // so ensure_schema would consider it current and repair nothing - it would swap in
        // cleanly and then fail with "no such column" on the first query, after the previous
        // database had already been set aside. It has to be refused here instead.
        let dir = temp_dir("import-wrong-columns");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "current").await;

        let source = dir.join("namesake.db");
        let options = SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();

        for ddl in [
            "CREATE TABLE channels (id INTEGER PRIMARY KEY, label TEXT)",
            "CREATE TABLE videos (id INTEGER PRIMARY KEY, name TEXT)",
            "CREATE TABLE video_comments (id INTEGER PRIMARY KEY, body TEXT)",
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)",
        ] {
            sqlx::query(ddl).execute(&pool).await.unwrap();
        }

        sqlx::query(sqlx::AssertSqlSafe(format!(
            "PRAGMA user_version = {}",
            crate::services::db_schema::SCHEMA_VERSION
        )))
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let error = stage_database_import(&db, &source).await.unwrap_err();
        assert_eq!(error.code, AppErrorCode::DatabaseImportInvalid.as_str());

        // Nothing was staged, so the next startup has no import to apply.
        assert!(!import_staged_path(&db).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn import_rejects_a_database_missing_the_media_unique_key() {
        // Right tables, right columns, stamped current - but the (channel_id, file_path) unique
        // key that insert_media's ON CONFLICT upsert targets is absent. Accepting it would swap in
        // a database on which every media insert then fails at runtime, so it is refused here (a
        // column check alone cannot see the missing constraint).
        let dir = temp_dir("import-no-unique");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "current").await;

        let source = dir.join("namesake.db");
        seed_namesake_with_videos_ddl(
            &source,
            "CREATE TABLE videos (id INTEGER PRIMARY KEY, channel_id INTEGER, file_path TEXT, \
             media_type TEXT, \
             FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE)",
        )
        .await;

        let error = stage_database_import(&db, &source).await.unwrap_err();
        assert_eq!(error.code, AppErrorCode::DatabaseImportInvalid.as_str());
        assert!(!import_staged_path(&db).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn import_rejects_a_database_missing_the_channel_cascade() {
        // Right tables, right columns, the unique key present - but no videos -> channels
        // ON DELETE CASCADE. Accepting it would let a later channel delete orphan that channel's
        // videos and their comments, since PRAGMA foreign_keys can only enforce a foreign key the
        // DDL declares and never adds a missing one, so it is refused here.
        let dir = temp_dir("import-no-cascade");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "current").await;

        let source = dir.join("namesake.db");
        seed_namesake_with_videos_ddl(
            &source,
            "CREATE TABLE videos (id INTEGER PRIMARY KEY, channel_id INTEGER, file_path TEXT, \
             media_type TEXT, UNIQUE (channel_id, file_path))",
        )
        .await;

        let error = stage_database_import(&db, &source).await.unwrap_err();
        assert_eq!(error.code, AppErrorCode::DatabaseImportInvalid.as_str());
        assert!(!import_staged_path(&db).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn import_rejects_a_database_missing_the_comment_cascade() {
        // Right tables, right columns, both videos constraints present - but no
        // video_comments -> videos ON DELETE CASCADE. Accepting it would let a later media delete
        // (a bare DELETE FROM videos, see library_cleanup) orphan that media's comment rows
        // forever, with nothing in the library diagnostics to reconcile them. PRAGMA foreign_keys
        // can only enforce a cascade the DDL declares and never adds a missing one, so it is
        // refused here alongside the two videos constraints.
        let dir = temp_dir("import-no-comment-cascade");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "current").await;

        let source = dir.join("namesake.db");
        seed_namesake_with_comments_ddl(
            &source,
            "CREATE TABLE video_comments (id INTEGER PRIMARY KEY, video_id INTEGER, text TEXT)",
        )
        .await;

        let error = stage_database_import(&db, &source).await.unwrap_err();
        assert_eq!(error.code, AppErrorCode::DatabaseImportInvalid.as_str());
        assert!(!import_staged_path(&db).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn restore_reaches_a_snapshot_stranded_in_the_backup_temp_file() {
        // backup_database vacuums into `.bak.tmp` and only renames it into `.bak` once that
        // succeeds. A run that died in that window leaves a complete, healthy snapshot there that
        // nothing else would ever look at - so with no other generation on disk the restore used
        // to report "no backup available" while a good one sat right next to the database.
        let dir = temp_dir("backup-temp-orphan");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "corrupted").await;
        seed_kavynex_db(&temp_backup_path(&db), "stranded").await;

        assert!(!backup_path(&db).exists());

        restore_database_from_backup(&db).await.unwrap();

        assert_eq!(read_video_title(&db).await, "stranded");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn restore_prefers_a_real_generation_over_the_backup_temp_file() {
        // `.bak.tmp` is also where a run that died *during* the vacuum leaves a partial file, and
        // nothing here can tell that apart from the complete one above. So it is the last resort,
        // never preferred over a real generation, even though it would be the fresher of the two.
        let dir = temp_dir("backup-temp-order");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "corrupted").await;
        seed_kavynex_db(&backup_path(&db), "rotated-generation").await;
        seed_kavynex_db(&temp_backup_path(&db), "stranded").await;

        restore_database_from_backup(&db).await.unwrap();

        assert_eq!(read_video_title(&db).await, "rotated-generation");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn restore_fails_when_no_backup_exists() {
        let dir = temp_dir("restore-none");
        let db = dir.join("kavynex.db");
        seed_db(&db).await;

        let error = restore_database_from_backup(&db).await.unwrap_err();
        assert_eq!(error.code, AppErrorCode::NoDatabaseBackupAvailable.as_str());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn restore_falls_back_to_rotated_backup_when_primary_is_corrupt() {
        let dir = temp_dir("restore-rotated");
        let db = dir.join("kavynex.db");
        seed_db(&db).await;

        // First backup becomes the rotated generation after a second run.
        assert!(backup_database(&db).await.unwrap());
        // Force a second, non-throttled backup so the first rotates to .bak.1.
        let old = SystemTime::now() - std::time::Duration::from_secs(BACKUP_MIN_INTERVAL_SECS * 2);
        filetime_set(&backup_path(&db), old);
        assert!(backup_database(&db).await.unwrap());

        // Corrupt the current .bak so restore must fall back to the rotated .bak.1.
        std::fs::write(backup_path(&db), b"corrupt bak").unwrap();
        std::fs::write(&db, b"corrupt db").unwrap();

        restore_database_from_backup(&db).await.unwrap();
        assert_eq!(read_single_value(&db).await, "hello");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn restore_refuses_a_backup_with_a_newer_schema_version() {
        let dir = temp_dir("restore-newer-schema");
        let db = dir.join("kavynex.db");
        seed_db(&db).await;
        assert!(backup_database(&db).await.unwrap());

        // Stamp the healthy backup with a schema version newer than this build supports.
        let options = SqliteConnectOptions::new().filename(backup_path(&db));
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "PRAGMA user_version = {}",
            crate::services::db_schema::SCHEMA_VERSION + 1
        )))
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        // Corrupt the live database so a restore is attempted.
        std::fs::write(&db, b"corrupt db").unwrap();

        // The only backup is from a newer schema, so restore fails up front with a clear code
        // instead of "succeeding" into a database the next open would reject.
        let error = restore_database_from_backup(&db).await.unwrap_err();
        assert_eq!(error.code, AppErrorCode::DatabaseSchemaTooNew.as_str());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn restore_accepts_a_backup_at_the_current_schema_version() {
        // The boundary of the newer-schema refusal: a backup stamped at exactly SCHEMA_VERSION is
        // this build's own and must be restored, not skipped. Pins the `>` in the version gate
        // against a `>=` that would refuse a current-version backup and fail the recovery.
        let dir = temp_dir("restore-current-schema");
        let db = dir.join("kavynex.db");
        seed_db(&db).await;
        assert!(backup_database(&db).await.unwrap());

        let options = SqliteConnectOptions::new().filename(backup_path(&db));
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "PRAGMA user_version = {}",
            crate::services::db_schema::SCHEMA_VERSION
        )))
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        std::fs::write(&db, b"corrupt db").unwrap();

        restore_database_from_backup(&db)
            .await
            .expect("a backup at the current schema version must be restored");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn import_accepts_a_normalized_current_schema_database() {
        // A v>=11 database whose rows are all normalized (unnormalized == 0) is a valid import and
        // must be accepted. Pins the `> 0` count check against a `>= 0`, which - being true for
        // every count - would reject every modern database as if its titles were never computed.
        let dir = temp_dir("import-normalized-current");
        let db = dir.join("kavynex.db");
        let source = dir.join("incoming.db");

        let options = SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        for ddl in [
            "CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, youtube_handle TEXT)",
            "CREATE TABLE videos (id INTEGER PRIMARY KEY, channel_id INTEGER, title TEXT, \
             title_normalized TEXT, file_path TEXT, media_type TEXT, \
             FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE, \
             UNIQUE (channel_id, file_path))",
            "CREATE TABLE video_comments (id INTEGER PRIMARY KEY, video_id INTEGER, text TEXT, \
             FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE)",
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)",
            // A single fully-normalized row, so COUNT(title_normalized IS NULL) is zero.
            "INSERT INTO videos (title, title_normalized) VALUES ('clip', 'clip')",
        ] {
            sqlx::query(ddl).execute(&pool).await.unwrap();
        }
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "PRAGMA user_version = {}",
            crate::services::db_schema::SCHEMA_VERSION
        )))
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        stage_database_import(&db, &source)
            .await
            .expect("a normalized current-schema database must import");
        assert!(import_staged_path(&db).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn backup_status_reports_the_snapshot_modified_time() {
        // The reported timestamp must be the backup file's real mtime, not a fixed sentinel: a
        // freshly written snapshot is far more recent than the epoch, so a mutant returning Some(0)
        // or Some(1) is caught by requiring a plausibly-recent value.
        let dir = temp_dir("backup-status-mtime");
        let db = dir.join("kavynex.db");
        seed_db(&db).await;
        assert!(backup_database(&db).await.unwrap());

        let status = database_backup_status(&db);
        assert!(status.available);
        // 2020-01-01 in ms; any real backup taken now is well past it, epoch-based sentinels are not.
        assert!(
            status
                .backed_up_at_ms
                .is_some_and(|ms| ms > 1_577_836_800_000),
            "backup timestamp must be the file's real mtime, got {:?}",
            status.backed_up_at_ms
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_min_interval_is_twenty_four_hours() {
        // Pin the throttle window's value so an accidental change to the `24 * 60 * 60` arithmetic
        // (which nothing else asserts exactly) is caught.
        assert_eq!(BACKUP_MIN_INTERVAL_SECS, 86_400);
    }

    #[tokio::test]
    async fn apply_pending_does_not_revert_a_leftover_undo_snapshot() {
        // After a completed import, `.pre-import` persists as the undo snapshot with no marker and
        // no staged file. On the next startup apply_pending must do nothing - a mutant recovering on
        // `marker OR pre_import` (instead of AND) would restore that snapshot over the live database
        // on every launch, silently reverting the user's data.
        let dir = temp_dir("apply-leftover-pre-import");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "live").await;
        seed_kavynex_db(&pre_import_path(&db), "old undo").await;

        assert!(!apply_pending_database_import(&db).unwrap());

        assert_eq!(read_video_title(&db).await, "live");
        assert!(
            pre_import_path(&db).exists(),
            "a leftover undo snapshot must be left untouched"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn filetime_set(path: &Path, time: SystemTime) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(time).unwrap();
    }

    async fn seed_kavynex_db(path: &Path, title: &str) {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        // Import validation requires every core table, the columns each is queried through, and
        // the constraints the app relies on at runtime (the (channel_id, file_path) unique key
        // behind insert_media's upsert, the videos -> channels ON DELETE CASCADE, and the
        // video_comments -> videos ON DELETE CASCADE), so a representative kavynex database in
        // tests must carry all of them. Still a reduced shape otherwise - only the columns the
        // validation names, no extra indexes - since these tests are about the file swap, not the
        // full schema.
        for ddl in [
            "CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, youtube_handle TEXT)",
            "CREATE TABLE videos (id INTEGER PRIMARY KEY, channel_id INTEGER, title TEXT, \
             file_path TEXT, media_type TEXT, \
             FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE, \
             UNIQUE (channel_id, file_path))",
            "CREATE TABLE video_comments (id INTEGER PRIMARY KEY, video_id INTEGER, text TEXT, \
             FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE)",
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)",
        ] {
            sqlx::query(ddl).execute(&pool).await.unwrap();
        }
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "INSERT INTO videos (title) VALUES ('{title}')"
        )))
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
    }

    // Builds a namesake database whose four core tables all carry the required columns and which
    // is stamped at this build's SCHEMA_VERSION (so ensure_schema would treat it as current and
    // repair nothing), letting a test vary only the videos DDL to probe a single missing
    // constraint the column check cannot catch.
    // The `videos` and `video_comments` DDL a valid kavynex database carries: the three
    // constraints import validation requires (the (channel_id, file_path) unique key, the
    // videos -> channels cascade, and the video_comments -> videos cascade). A namesake test
    // seeds one of these in its varied, constraint-missing form and the rest as valid, so the
    // rejection it asserts can only come from the constraint under test.
    const VALID_VIDEOS_DDL: &str = "CREATE TABLE videos (id INTEGER PRIMARY KEY, channel_id \
         INTEGER, file_path TEXT, media_type TEXT, \
         FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE, \
         UNIQUE (channel_id, file_path))";
    const VALID_COMMENTS_DDL: &str = "CREATE TABLE video_comments (id INTEGER PRIMARY KEY, \
         video_id INTEGER, text TEXT, \
         FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE)";

    async fn seed_namesake(source: &Path, videos_ddl: &str, comments_ddl: &str) {
        let options = SqliteConnectOptions::new()
            .filename(source)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();

        sqlx::query(
            "CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, youtube_handle TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(videos_ddl))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(comments_ddl))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "PRAGMA user_version = {}",
            crate::services::db_schema::SCHEMA_VERSION
        )))
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
    }

    /// A namesake database whose `videos` DDL is varied (to omit a constraint under test) while
    /// every other table carries the shape a valid kavynex database has.
    async fn seed_namesake_with_videos_ddl(source: &Path, videos_ddl: &str) {
        seed_namesake(source, videos_ddl, VALID_COMMENTS_DDL).await;
    }

    /// A namesake database whose `video_comments` DDL is varied (to omit the cascade under test)
    /// while every other table carries the shape a valid kavynex database has.
    async fn seed_namesake_with_comments_ddl(source: &Path, comments_ddl: &str) {
        seed_namesake(source, VALID_VIDEOS_DDL, comments_ddl).await;
    }

    async fn read_video_title(path: &Path) -> String {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        let (title,): (String,) = sqlx::query_as("SELECT title FROM videos LIMIT 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        pool.close().await;
        title
    }

    #[tokio::test]
    async fn export_creates_importable_snapshot() {
        let dir = temp_dir("export");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "hello").await;

        let dest = dir.join("exported.db");
        export_database(&db, &dest).await.unwrap();

        assert!(dest.exists());
        assert_eq!(read_video_title(&dest).await, "hello");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn export_overwrites_an_existing_destination_via_the_staging_path() {
        let dir = temp_dir("export_overwrite");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "fresh").await;

        let dest = dir.join("exported.db");
        std::fs::write(&dest, b"stale export contents").unwrap();

        export_database(&db, &dest).await.unwrap();

        assert_eq!(read_video_title(&dest).await, "fresh");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn export_preserves_existing_destination_when_vacuum_fails() {
        let dir = temp_dir("export_fail");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "hello").await;

        let dest = dir.join("exported.db");
        std::fs::write(&dest, b"previous export contents").unwrap();

        // The staging path (a sibling of dest_path) is a directory rather than a regular
        // file, so `VACUUM INTO` cannot write to it and the export fails - without ever
        // touching the pre-existing destination file.
        let staging = sibling(&dest, ".export-staging");
        std::fs::create_dir_all(&staging).unwrap();

        let error = export_database(&db, &dest).await.unwrap_err();
        assert_eq!(error.code, AppErrorCode::AppError.as_str());

        assert_eq!(std::fs::read(&dest).unwrap(), b"previous export contents");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn escape_sql_literal_doubles_single_quotes() {
        assert_eq!(escape_sql_literal("O'Brien"), "O''Brien");
        assert_eq!(escape_sql_literal("a'b'c"), "a''b''c");
        assert_eq!(escape_sql_literal("no quotes"), "no quotes");

        // Adversarial paths: a classic break-out attempt and an already-doubled quote must both
        // be neutralized to an even number of quotes, so the value can only ever be data inside
        // the literal, never the start of a new clause. Backslashes are not SQL-significant in
        // SQLite string literals and are left untouched.
        assert_eq!(
            escape_sql_literal("'; DROP TABLE videos; --"),
            "''; DROP TABLE videos; --"
        );
        assert_eq!(escape_sql_literal("a'' b"), "a'''' b");
        assert_eq!(
            escape_sql_literal(r"C:\Users\O'Neil\db"),
            r"C:\Users\O''Neil\db"
        );
    }

    #[tokio::test]
    async fn export_handles_a_destination_path_with_a_single_quote() {
        // Regression guard: `VACUUM INTO` cannot bind parameters, so the destination path
        // is interpolated after escaping. A path containing a single quote (e.g. a user
        // named O'Brien) must not break the statement.
        let dir = temp_dir("export_quote");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "hello").await;

        let quoted_dir = dir.join("O'Brien");
        std::fs::create_dir_all(&quoted_dir).unwrap();
        let dest = quoted_dir.join("exported.db");

        export_database(&db, &dest).await.unwrap();

        assert!(dest.exists());
        assert_eq!(read_video_title(&dest).await, "hello");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn database_quick_check_ok_reports_health() {
        let dir = temp_dir("quick_check");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "hello").await;

        // A freshly seeded database passes.
        assert!(database_quick_check_ok(&db).await);

        // A file that is not a database at all is reported unhealthy, so the pool builder's
        // pre-migration gate refuses to migrate over it instead of amplifying the damage.
        let garbage = dir.join("garbage.db");
        std::fs::write(&garbage, b"this is not a sqlite database").unwrap();
        assert!(!database_quick_check_ok(&garbage).await);

        // A missing file is likewise not openable (open uses create_if_missing(false)).
        assert!(!database_quick_check_ok(&dir.join("missing.db")).await);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn stage_and_apply_import_swaps_database_and_keeps_previous() {
        let dir = temp_dir("import");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "current").await;

        let source = dir.join("incoming.db");
        seed_kavynex_db(&source, "imported").await;

        stage_database_import(&db, &source).await.unwrap();
        assert!(import_staged_path(&db).exists());

        assert!(apply_pending_database_import(&db).unwrap());

        assert_eq!(read_video_title(&db).await, "imported");
        assert!(pre_import_path(&db).exists());
        assert_eq!(read_video_title(&pre_import_path(&db)).await, "current");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn apply_import_is_noop_when_nothing_staged() {
        let dir = temp_dir("import-noop");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "current").await;

        assert!(!apply_pending_database_import(&db).unwrap());
        assert_eq!(read_video_title(&db).await, "current");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn stage_import_rejects_non_kavynex_database() {
        let dir = temp_dir("import-reject");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "current").await;

        // A valid SQLite database, but without a `videos` table.
        let foreign = dir.join("foreign.db");
        seed_db(&foreign).await;

        let error = stage_database_import(&db, &foreign).await.unwrap_err();
        assert_eq!(error.code, AppErrorCode::DatabaseImportInvalid.as_str());
        assert!(!import_staged_path(&db).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Seeds a database whose `videos` carries `title_normalized`, stamped at `user_version`, with
    /// one row whose normalized title is NULL - the state an import must be judged on.
    async fn seed_db_with_null_normalized_title(path: &Path, user_version: i64) {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();

        for ddl in [
            "CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, youtube_handle TEXT)",
            "CREATE TABLE videos (id INTEGER PRIMARY KEY, channel_id INTEGER, title TEXT, \
             title_normalized TEXT, file_path TEXT, media_type TEXT, \
             FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE, \
             UNIQUE (channel_id, file_path))",
            // The video_comments -> videos cascade has been present since the first released
            // schema (user_version 5), so a realistic older database carries it; import validation
            // requires it regardless of version.
            "CREATE TABLE video_comments (id INTEGER PRIMARY KEY, video_id INTEGER, text TEXT, \
             FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE)",
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)",
        ] {
            sqlx::query(ddl).execute(&pool).await.unwrap();
        }

        sqlx::query("INSERT INTO videos (title, title_normalized) VALUES ('Ação', NULL)")
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query(sqlx::AssertSqlSafe(format!(
            "PRAGMA user_version = {user_version}"
        )))
        .execute(&pool)
        .await
        .unwrap();

        pool.close().await;
    }

    #[tokio::test]
    async fn import_rejects_a_current_database_whose_titles_were_never_normalized() {
        // Stamped at the current version, so ensure_schema treats it as fully migrated and never
        // runs the v11 backfill. The media would sit in the library permanently invisible to every
        // title search, with nothing to say so. The triggers cannot catch this - an import replaces
        // the file wholesale, so no INSERT fires - which is why it has to be refused here.
        let dir = temp_dir("import-null-normalized");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "current").await;

        let source = dir.join("unnormalized.db");
        seed_db_with_null_normalized_title(&source, crate::services::db_schema::SCHEMA_VERSION)
            .await;

        let error = stage_database_import(&db, &source).await.unwrap_err();

        assert_eq!(error.code, AppErrorCode::DatabaseImportInvalid.as_str());
        assert!(!import_staged_path(&db).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn import_accepts_an_older_database_whose_titles_are_not_normalized_yet() {
        // The counterpart, and the reason the check is gated on the version rather than applied to
        // every database: below v11 a NULL title_normalized is simply what that schema looks like.
        // Refusing it would block the genuine "import my library from an older Kavynex" case, which
        // ensure_schema fixes by running the v11 backfill right after the swap.
        let dir = temp_dir("import-old-unnormalized");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "current").await;

        let source = dir.join("older.db");
        seed_db_with_null_normalized_title(&source, 10).await;

        stage_database_import(&db, &source).await.unwrap();

        assert!(import_staged_path(&db).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn stage_import_rejects_database_missing_a_core_table() {
        let dir = temp_dir("import-missing-table");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "current").await;

        // A database that has `videos` but is missing the other core tables must be rejected,
        // otherwise it would swap in and then fail queries at runtime with "no such table".
        let partial = dir.join("partial.db");
        let options = SqliteConnectOptions::new()
            .filename(&partial)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE videos (id INTEGER PRIMARY KEY, title TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        let error = stage_database_import(&db, &partial).await.unwrap_err();
        assert_eq!(error.code, AppErrorCode::DatabaseImportInvalid.as_str());
        assert!(!import_staged_path(&db).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn undo_reverts_the_last_import_on_the_next_startup() {
        let dir = temp_dir("undo");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "current").await;

        let source = dir.join("incoming.db");
        seed_kavynex_db(&source, "imported").await;

        // Apply an import, leaving the previous database as the `.pre-import` snapshot.
        stage_database_import(&db, &source).await.unwrap();
        assert!(apply_pending_database_import(&db).unwrap());
        assert_eq!(read_video_title(&db).await, "imported");
        assert!(database_import_undo_available(&db));

        // Undo stages the pre-import snapshot; the swap happens on the next startup, like a
        // normal import, so the live database is never swapped underneath.
        stage_database_import_undo(&db).await.unwrap();
        assert!(import_staged_path(&db).exists());
        assert!(apply_pending_database_import(&db).unwrap());

        // The database is back to the pre-import content.
        assert_eq!(read_video_title(&db).await, "current");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn undo_fails_when_no_import_was_applied() {
        let dir = temp_dir("undo-none");
        let db = dir.join("kavynex.db");
        seed_kavynex_db(&db, "current").await;

        assert!(!database_import_undo_available(&db));
        assert_eq!(
            stage_database_import_undo(&db).await.unwrap_err().code,
            AppErrorCode::NoDatabaseImportToUndo.as_str()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn is_schema_migration_pending_reflects_user_version() {
        let dir = temp_dir("pending");
        let db = dir.join("kavynex.db");

        // A missing file: opening it creates the schema, so a migration is pending.
        assert!(is_schema_migration_pending(&db).await);

        // A database stamped below the current version still needs migrating.
        seed_kavynex_db(&db, "x").await; // user_version defaults to 0
        assert!(is_schema_migration_pending(&db).await);

        // Stamp the current version: nothing to migrate, so the backup can be deferred.
        let options = SqliteConnectOptions::new()
            .filename(&db)
            .create_if_missing(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "PRAGMA user_version = {}",
            crate::services::db_schema::SCHEMA_VERSION
        )))
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        assert!(!is_schema_migration_pending(&db).await);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_full_integrity_check_reports_ok_for_a_healthy_schema() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::services::db_schema::ensure_schema(&pool)
            .await
            .unwrap();

        let report = run_full_integrity_check(&pool).await.unwrap();

        assert!(report.ok);
        assert!(report.problems.is_empty());
        assert!(!report.truncated);

        pool.close().await;
    }

    #[tokio::test]
    async fn run_full_integrity_check_keeps_what_sqlite_reported_about_a_damaged_database() {
        // The whole point of the change this pins: `PRAGMA integrity_check` answers with one row
        // per problem, so reading a single row threw away everything SQLite had to say and left the
        // UI with a bare "there is a problem" and the user with nothing to act on.
        //
        // The damage is real rather than simulated: an index page is overwritten with garbage while
        // the file is closed, which leaves the database openable (the header and schema are intact)
        // but internally inconsistent - exactly the state this check exists to find, and the one
        // "not a database" never reaches because it fails at open instead.
        let dir = temp_dir("integrity-damaged");
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("kavynex.db");

        // The real schema rather than the reduced `seed_kavynex_db` shape: this test is about what
        // `integrity_check` finds inside the file, so the indexes it walks have to be the real ones.
        {
            let options = SqliteConnectOptions::new()
                .filename(&db)
                .create_if_missing(true);
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(options)
                .await
                .unwrap();
            crate::services::db_schema::ensure_schema(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO channels (id, name, youtube_handle) VALUES (1, 'C', '@c')")
                .execute(&pool)
                .await
                .unwrap();

            for id in 2..400 {
                sqlx::query(
                    "INSERT INTO videos (id, channel_id, title, title_normalized, file_path, media_type) \
                     VALUES (?, 1, ?, ?, ?, 'video')",
                )
                .bind(id)
                .bind(format!("title {id}"))
                .bind(format!("title {id}"))
                .bind(format!("video/{id}.mp4"))
                .execute(&pool)
                .await
                .unwrap();
            }

            // Fold the WAL back in so the damage below lands on the database file itself rather
            // than on pages the next open would replay over.
            sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;
        }

        let mut bytes = std::fs::read(&db).unwrap();
        let page_size = u16::from_be_bytes([bytes[16], bytes[17]]) as usize;
        assert!(page_size >= 512, "unexpected page size: {page_size}");

        // Scribble over the interior of several pages, leaving page 1 (the header and schema)
        // alone so the file still opens.
        for page in 3..8 {
            let start = page * page_size + 16;
            let end = start + 64;

            if end < bytes.len() {
                bytes[start..end].fill(0x5A);
            }
        }
        std::fs::write(&db, &bytes).unwrap();

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&format!("sqlite://{}", db.to_string_lossy()))
            .await
            .unwrap();

        let report = run_full_integrity_check(&pool).await.unwrap();

        // Damage this heavy is reported one of two ways depending on what SQLite manages to walk:
        // a list of problems, or a flat SQLITE_CORRUPT on the pragma itself. Both are integrity
        // answers and both have to arrive as one - never as "the check could not run", which reads
        // as the tool breaking rather than the database being broken.
        assert!(
            !report.ok,
            "the damaged database must not be reported sound"
        );
        assert!(
            !report.problems.is_empty(),
            "what SQLite reported has to reach the caller, not just the fact that it failed"
        );
        assert!(
            report.problems.len() <= MAX_INTEGRITY_PROBLEMS,
            "the problem list is capped so a shredded database cannot report unboundedly"
        );

        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
