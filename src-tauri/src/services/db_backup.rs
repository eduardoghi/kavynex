use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

use crate::services::database::SQLITE_BUSY_TIMEOUT_MS;
use crate::services::logger;
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

/// Runs a full `PRAGMA integrity_check`, a thorough (and slower) check than the `quick_check`
/// used by the automatic health paths above. User-triggered only, so the extra cost is fine.
pub async fn run_full_integrity_check(pool: &SqlitePool) -> AppResult<bool> {
    let (result,): (String,) = sqlx::query_as("PRAGMA integrity_check")
        .fetch_one(pool)
        .await
        .map_err(|error| backup_error("failed to run the database integrity check", error))?;

    Ok(result == "ok")
}

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

    // Stage the restored file first so the live database is never left missing on failure.
    let staged = restore_staging_path(db_path);
    let _ = std::fs::remove_file(&staged);
    std::fs::copy(&backup, &staged)
        .map_err(|error| backup_error("failed to stage restored database", error))?;

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
fn write_import_applying_marker(marker: &Path) -> AppResult<()> {
    use std::io::Write;

    let mut file = std::fs::File::create(marker)
        .map_err(|error| backup_error("failed to mark the import as in progress", error))?;
    file.write_all(b"import swap in progress\n")
        .and_then(|_| file.sync_all())
        .map_err(|error| backup_error("failed to mark the import as in progress", error))
}

/// Exports a consistent, self-contained snapshot of the database to a user-chosen path via
/// `VACUUM INTO` (WAL-safe: the snapshot is always fully checkpointed, never combined with a
/// live write-ahead log). Refuses to export a database that fails `quick_check` so a corrupt
/// file is never handed out as a good backup.
///
/// `VACUUM INTO` writes to a staging file next to the destination and is only promoted onto
/// `dest_path` (via rename) once it succeeds, so a failed export (disk full, bad path) never
/// destroys a pre-existing export at that path.
pub async fn export_database(db_path: &Path, dest_path: &Path) -> AppResult<()> {
    if !db_path.exists() {
        return Err(AppError::from_code(
            AppErrorCode::AppError,
            "there is no database to export yet",
        ));
    }

    let pool = open(db_path).await?;

    if !is_healthy(&pool).await {
        pool.close().await;
        return Err(AppError::from_code(
            AppErrorCode::AppError,
            "cannot export a database that fails an integrity check",
        ));
    }

    // VACUUM INTO fails if its target file already exists, so it always writes to a fresh
    // staging path rather than dest_path directly.
    let staging = sibling(dest_path, ".export-staging");
    let _ = std::fs::remove_file(&staging);

    let vacuum_sql = format!(
        "VACUUM INTO '{}'",
        escape_sql_literal(&staging.to_string_lossy())
    );
    let result = sqlx::query(sqlx::AssertSqlSafe(vacuum_sql))
        .execute(&pool)
        .await;
    pool.close().await;

    if let Err(error) = result {
        let _ = std::fs::remove_file(&staging);
        return Err(backup_error("failed to export database", error));
    }

    // The snapshot is confirmed good; only now is any previous export at dest_path replaced.
    // The caller's save dialog has already confirmed the overwrite.
    let _ = std::fs::remove_file(dest_path);
    std::fs::rename(&staging, dest_path).map_err(|error| {
        let _ = std::fs::remove_file(&staging);
        backup_error("failed to finalize database export", error)
    })?;

    Ok(())
}

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
    // constraints. Two of those cannot be repaired after the swap and must land here as a refused
    // import: without the (channel_id, file_path) unique index the insert_media upsert's
    // ON CONFLICT target has nothing to match, so every insert fails; without the videos -> channels
    // ON DELETE CASCADE a channel delete leaves its videos and their comments orphaned. Enabling
    // PRAGMA foreign_keys cannot rescue either - it only enforces constraints the DDL declares, it
    // never adds one - so the shape has to be verified before the database is accepted.
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

    if !has_unique_media_key || !has_channel_cascade {
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

        if let Ok(Some((busy, remaining_frames, _))) = checkpoint {
            if busy != 0 && remaining_frames > 0 {
                pool.close().await;

                return Err(AppError::from_code(
                    AppErrorCode::DatabaseImportInvalid,
                    "the selected database is still in use, so its most recent changes could not \
                     be read; close the app that has it open and try again",
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
    std::fs::copy(source_path, &staging_tmp)
        .map_err(|error| backup_error("failed to stage database import", error))?;
    let _ = std::fs::remove_file(&staged);
    std::fs::rename(&staging_tmp, &staged)
        .map_err(|error| backup_error("failed to stage database import", error))?;

    Ok(())
}

/// Applies a database import staged by `stage_database_import`, if one is pending. Runs at
/// startup before the pool opens: the current database is moved aside to `.pre-import` (a
/// safety net) and the staged file is swapped in, dropping stale WAL sidecars. On a swap
/// failure the previous database is rolled back so the app still has one to open. Returns
/// whether an import was applied.
pub fn apply_pending_database_import(db_path: &Path) -> AppResult<bool> {
    let staged = import_staged_path(db_path);

    if !staged.exists() {
        return Ok(false);
    }

    let pre_import = pre_import_path(db_path);
    let marker = import_applying_marker_path(db_path);

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
            let _ = std::fs::rename(&pre_import, db_path);

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
    async fn backup_skips_when_source_missing() {
        let dir = temp_dir("missing");
        let db = dir.join("kavynex.db");

        assert!(!backup_database(&db).await.unwrap());

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
        // the two videos constraints the app relies on at runtime (the (channel_id, file_path)
        // unique key behind insert_media's upsert, and the videos -> channels ON DELETE CASCADE),
        // so a representative kavynex database in tests must carry all of them. Still a reduced
        // shape otherwise - only the columns the validation names, no extra indexes - since these
        // tests are about the file swap, not the full schema.
        for ddl in [
            "CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, youtube_handle TEXT)",
            "CREATE TABLE videos (id INTEGER PRIMARY KEY, channel_id INTEGER, title TEXT, \
             file_path TEXT, media_type TEXT, \
             FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE, \
             UNIQUE (channel_id, file_path))",
            "CREATE TABLE video_comments (id INTEGER PRIMARY KEY, video_id INTEGER, text TEXT)",
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
    async fn seed_namesake_with_videos_ddl(source: &Path, videos_ddl: &str) {
        let options = SqliteConnectOptions::new()
            .filename(source)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();

        sqlx::query("CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, youtube_handle TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(videos_ddl))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE video_comments (id INTEGER PRIMARY KEY, video_id INTEGER, text TEXT)")
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
            "CREATE TABLE video_comments (id INTEGER PRIMARY KEY, video_id INTEGER, text TEXT)",
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

        assert!(run_full_integrity_check(&pool).await.unwrap());

        pool.close().await;
    }
}
