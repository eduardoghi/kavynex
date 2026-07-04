use std::path::{Path, PathBuf};
use std::time::SystemTime;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

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
        .create_if_missing(false);

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
    let vacuum_result = sqlx::query(&vacuum_sql).execute(&pool).await;
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
}
