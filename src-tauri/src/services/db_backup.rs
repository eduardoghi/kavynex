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

fn rotated_backup_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".bak.1")
}

fn temp_backup_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".bak.tmp")
}

fn backup_error(message: impl Into<String>, error: impl std::fmt::Display) -> AppError {
    AppError::from_code_with_details(AppErrorCode::AppError, message.into(), error.to_string())
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

fn escape_sql_literal(value: &str) -> String {
    value.replace('\'', "''")
}

/// Creates a consistent snapshot of the database (via `VACUUM INTO`) before migrations run,
/// so a bad migration or corruption can be rolled back. Best effort and throttled to once a
/// day; a source database that fails `quick_check` is skipped so a corrupt DB never
/// overwrites a good backup. Keeps one rotated generation (`.bak` and `.bak.1`). Returns
/// true when a new snapshot was written.
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

    // Rotate the previous backup, then promote the fresh snapshot.
    if backup.exists() {
        let rotated = rotated_backup_path(db_path);
        let _ = std::fs::remove_file(&rotated);
        let _ = std::fs::rename(&backup, &rotated);
    }

    std::fs::rename(&temp, &backup)
        .map_err(|error| backup_error("failed to store database backup", error))?;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBackupStatus {
    pub available: bool,
    /// Modification time of the backup that would be restored, in epoch milliseconds.
    pub backed_up_at_ms: Option<u64>,
}

fn corrupt_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".corrupt")
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

/// The existing backup files, most recent first. Rotation always writes the freshest
/// snapshot to `.bak`, so it precedes the rotated `.bak.1` generation.
fn backup_candidates(db_path: &Path) -> Vec<PathBuf> {
    [backup_path(db_path), rotated_backup_path(db_path)]
        .into_iter()
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

async fn backup_is_healthy(path: &Path) -> bool {
    match open(path).await {
        Ok(pool) => {
            let healthy = is_healthy(&pool).await;
            pool.close().await;
            healthy
        }
        Err(_) => false,
    }
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

    for candidate in backup_candidates(db_path) {
        if backup_is_healthy(&candidate).await {
            chosen = Some(candidate);
            break;
        }
    }

    let backup = chosen.ok_or_else(|| {
        AppError::from_code(
            AppErrorCode::NoDatabaseBackupAvailable,
            "no healthy database backup is available to restore",
        )
    })?;

    // Stage the restored file first so the live database is never left missing on failure.
    let staged = sibling(db_path, ".restore.tmp");
    let _ = std::fs::remove_file(&staged);
    std::fs::copy(&backup, &staged)
        .map_err(|error| backup_error("failed to stage restored database", error))?;

    // Move the corrupt database aside and drop its sidecar WAL files.
    if db_path.exists() {
        let corrupt = corrupt_path(db_path);
        let _ = std::fs::remove_file(&corrupt);

        if let Err(error) = std::fs::rename(db_path, &corrupt) {
            let _ = std::fs::remove_file(&staged);
            return Err(backup_error(
                "failed to move aside the corrupt database",
                error,
            ));
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

/// Exports a consistent, self-contained snapshot of the database to a user-chosen path via
/// `VACUUM INTO` (WAL-safe: the snapshot is always fully checkpointed, never combined with a
/// live write-ahead log). The destination is overwritten. Refuses to export a database that
/// fails `quick_check` so a corrupt file is never handed out as a good backup.
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

    // VACUUM INTO fails if the target file already exists; the caller's save dialog has
    // already confirmed any overwrite, so clear it first.
    let _ = std::fs::remove_file(dest_path);

    let vacuum_sql = format!(
        "VACUUM INTO '{}'",
        escape_sql_literal(&dest_path.to_string_lossy())
    );
    let result = sqlx::query(sqlx::AssertSqlSafe(vacuum_sql))
        .execute(&pool)
        .await;
    pool.close().await;
    result.map_err(|error| backup_error("failed to export database", error))?;

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
    let _ = std::fs::remove_file(&pre_import);

    if db_path.exists() {
        std::fs::rename(db_path, &pre_import)
            .map_err(|error| backup_error("failed to set aside the current database", error))?;
    }

    let _ = std::fs::remove_file(sibling(db_path, "-wal"));
    let _ = std::fs::remove_file(sibling(db_path, "-shm"));

    if let Err(error) = std::fs::rename(&staged, db_path) {
        // Roll the previous database back so the app is never left without one.
        let _ = std::fs::rename(&pre_import, db_path);
        return Err(backup_error("failed to apply the imported database", error));
    }

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
        // Import validation now requires every core table, so a representative kavynex
        // database in tests must have all of them, not just `videos`.
        for ddl in [
            "CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT)",
            "CREATE TABLE videos (id INTEGER PRIMARY KEY, title TEXT)",
            "CREATE TABLE video_comments (id INTEGER PRIMARY KEY, text TEXT)",
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

    #[test]
    fn escape_sql_literal_doubles_single_quotes() {
        assert_eq!(escape_sql_literal("O'Brien"), "O''Brien");
        assert_eq!(escape_sql_literal("a'b'c"), "a''b''c");
        assert_eq!(escape_sql_literal("no quotes"), "no quotes");
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
}
