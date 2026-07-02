use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};
use tauri::{AppHandle, Manager};
use tokio::sync::OnceCell;

use crate::{AppError, AppErrorCode, AppResult};

const DATABASE_FILE_NAME: &str = "kavynex.db";
const SQLITE_BUSY_TIMEOUT_MS: u64 = 30_000;
const MAX_CONNECTIONS: u32 = 4;

const IMPORT_MODE_KEY: &str = "import_mode";
const LIBRARY_PATH_KEY: &str = "library_path";

/// Process-wide shared connection pool to the application database. The pool is created
/// once, lazily, on first access and reused for the lifetime of the app. Connection
/// options (WAL, busy timeout, foreign keys) are applied per connection so every pooled
/// connection is configured consistently.
static POOL: OnceCell<SqlitePool> = OnceCell::const_new();

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAppSettings {
    pub import_mode: Option<String>,
    pub library_path: Option<String>,
}

pub(crate) fn db_error(message: impl Into<String>, error: impl std::fmt::Display) -> AppError {
    AppError::from_code_with_details(AppErrorCode::AppError, message, error.to_string())
}

pub fn database_path(app: &AppHandle) -> AppResult<PathBuf> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| db_error("failed to resolve app database directory", error))?;

    std::fs::create_dir_all(&config_dir)
        .map_err(|error| db_error("failed to create app database directory", error))?;

    Ok(config_dir.join(DATABASE_FILE_NAME))
}

async fn build_pool(app: &AppHandle) -> AppResult<SqlitePool> {
    let path = database_path(app)?;

    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .connect_with(options)
        .await
        .map_err(|error| db_error("failed to open app database", error))?;

    // The schema is owned by the backend: create/migrate it as part of pool
    // initialization so it is ready before any query runs.
    crate::services::db_schema::ensure_schema(&pool).await?;

    Ok(pool)
}

/// Returns the shared database pool, initializing it on first use.
pub async fn shared_pool(app: &AppHandle) -> AppResult<&'static SqlitePool> {
    POOL.get_or_try_init(|| build_pool(app)).await
}

pub async fn get_app_settings_from_pool(pool: &SqlitePool) -> AppResult<StoredAppSettings> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT key, value FROM app_settings WHERE key IN (?, ?)")
            .bind(IMPORT_MODE_KEY)
            .bind(LIBRARY_PATH_KEY)
            .fetch_all(pool)
            .await
            .map_err(|error| db_error("failed to read app settings", error))?;

    let mut settings = StoredAppSettings::default();

    for (key, value) in rows {
        if key == IMPORT_MODE_KEY {
            settings.import_mode = Some(value);
        } else if key == LIBRARY_PATH_KEY {
            settings.library_path = Some(value);
        }
    }

    Ok(settings)
}

async fn upsert_setting<'e, E>(executor: E, key: &str, value: &str) -> Result<(), sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    sqlx::query(
        r#"
        INSERT INTO app_settings (key, value, created_at, updated_at)
        VALUES (?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = datetime('now')
        "#,
    )
    .bind(key)
    .bind(value)
    .execute(executor)
    .await
    .map(|_| ())
}

pub async fn set_app_settings_in_pool(
    pool: &SqlitePool,
    import_mode: &str,
    library_path: &str,
) -> AppResult<()> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| db_error("failed to begin settings transaction", error))?;

    let result = async {
        upsert_setting(&mut *tx, IMPORT_MODE_KEY, import_mode).await?;
        upsert_setting(&mut *tx, LIBRARY_PATH_KEY, library_path).await?;
        Ok::<(), sqlx::Error>(())
    }
    .await;

    match result {
        Ok(()) => {
            tx.commit()
                .await
                .map_err(|error| db_error("failed to commit settings transaction", error))?;
            Ok(())
        }
        Err(error) => {
            let _ = tx.rollback().await;
            Err(db_error("failed to persist app settings", error))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn create_test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create sqlite memory pool");

        sqlx::query(
            r#"
            CREATE TABLE app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            "#,
        )
        .execute(&pool)
        .await
        .expect("create app_settings table");

        pool
    }

    #[tokio::test]
    async fn get_app_settings_returns_none_when_empty() {
        let pool = create_test_pool().await;

        let settings = get_app_settings_from_pool(&pool).await.unwrap();

        assert_eq!(settings.import_mode, None);
        assert_eq!(settings.library_path, None);
    }

    #[tokio::test]
    async fn set_then_get_app_settings_roundtrip() {
        let pool = create_test_pool().await;

        set_app_settings_in_pool(&pool, "move", "/library")
            .await
            .unwrap();

        let settings = get_app_settings_from_pool(&pool).await.unwrap();

        assert_eq!(settings.import_mode.as_deref(), Some("move"));
        assert_eq!(settings.library_path.as_deref(), Some("/library"));
    }

    #[tokio::test]
    async fn set_app_settings_upserts_existing_keys() {
        let pool = create_test_pool().await;

        set_app_settings_in_pool(&pool, "copy", "/old").await.unwrap();
        set_app_settings_in_pool(&pool, "move", "/new").await.unwrap();

        let settings = get_app_settings_from_pool(&pool).await.unwrap();

        assert_eq!(settings.import_mode.as_deref(), Some("move"));
        assert_eq!(settings.library_path.as_deref(), Some("/new"));

        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM app_settings")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 2);
    }
}
