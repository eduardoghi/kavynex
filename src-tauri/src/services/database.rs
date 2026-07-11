use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};
use tauri::{AppHandle, Manager};
use tokio::sync::OnceCell;

use crate::{AppError, AppErrorCode, AppResult};

const DATABASE_FILE_NAME: &str = "kavynex.db";
pub(crate) const SQLITE_BUSY_TIMEOUT_MS: u64 = 30_000;
const MAX_CONNECTIONS: u32 = 4;

const IMPORT_MODE_KEY: &str = "import_mode";
const LIBRARY_PATH_KEY: &str = "library_path";
const LOAD_REMOTE_IMAGES_KEY: &str = "load_remote_images";

/// Process-wide shared connection pool to the application database. The pool is created
/// once, lazily, on first access and reused for the lifetime of the app. Connection
/// options (WAL, busy timeout, foreign keys) are applied per connection so every pooled
/// connection is configured consistently.
static POOL: OnceCell<SqlitePool> = OnceCell::const_new();

// Exposed to the frontend as `StoredAppSettingsPayload`; serde camelCase is honored by
// ts-rs so the generated keys are importMode/libraryPath.
#[derive(Debug, Default, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    rename = "StoredAppSettingsPayload",
    export_to = "../../src/types/generated/"
)]
pub struct StoredAppSettings {
    pub import_mode: Option<String>,
    pub library_path: Option<String>,
    // "true"/"false" (absent means never set); controls whether the webview loads remote
    // comment/live-chat author avatars and custom emojis from Google's CDNs.
    pub load_remote_images: Option<String>,
}

pub(crate) fn db_error(message: impl Into<String>, error: impl std::fmt::Display) -> AppError {
    AppError::from_code_with_details(AppErrorCode::AppError, message, error.to_string())
}

/// True when a sqlx error is a SQLite UNIQUE (or PRIMARY KEY) constraint violation, so a
/// duplicate-insert race can be mapped to a friendly domain error instead of surfacing the
/// raw SQL message.
pub(crate) fn is_unique_violation(error: &sqlx::Error) -> bool {
    use sqlx::error::DatabaseError;

    match error {
        sqlx::Error::Database(database_error) => {
            DatabaseError::is_unique_violation(database_error.as_ref())
        }
        _ => false,
    }
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

    // The pre-migration snapshot only matters when a migration will actually run (so a bad
    // migration or corruption can be rolled back). When one is pending, snapshot
    // synchronously before opening the pool; otherwise defer the daily snapshot to a
    // background task so a normal launch is never blocked by a VACUUM of a large database.
    // Best effort either way: a backup failure must not stop the app from opening.
    let migration_pending = crate::services::db_backup::is_schema_migration_pending(&path).await;

    if migration_pending {
        if let Err(error) = crate::services::db_backup::backup_database(&path).await {
            crate::services::logger::warn("db_backup", format!("database backup failed: {error}"));
        }
    }

    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        // WAL + NORMAL is durable across app crashes and only risks the last few
        // transactions on an OS crash/power loss - the standard, faster tradeoff for a
        // desktop app versus the default FULL fsync on every commit.
        .synchronous(SqliteSynchronous::Normal)
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

    if !migration_pending {
        // No migration ran, so the snapshot was skipped above; take the (throttled) daily
        // one off the critical path.
        let background_path = path.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = crate::services::db_backup::backup_database(&background_path).await
            {
                crate::services::logger::warn(
                    "db_backup",
                    format!("background database backup failed: {error}"),
                );
            }
        });
    }

    Ok(pool)
}

/// Returns the shared database pool, initializing it on first use.
pub async fn shared_pool(app: &AppHandle) -> AppResult<&'static SqlitePool> {
    POOL.get_or_try_init(|| build_pool(app)).await
}

/// Whether the shared pool has already been opened. Used to guard the restore-from-backup
/// flow, which must only run while the database is closed (i.e. after a failed open).
pub fn is_pool_initialized() -> bool {
    POOL.get().is_some()
}

pub async fn get_app_settings_from_pool(pool: &SqlitePool) -> AppResult<StoredAppSettings> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT key, value FROM app_settings WHERE key IN (?, ?, ?)")
            .bind(IMPORT_MODE_KEY)
            .bind(LIBRARY_PATH_KEY)
            .bind(LOAD_REMOTE_IMAGES_KEY)
            .fetch_all(pool)
            .await
            .map_err(|error| db_error("failed to read app settings", error))?;

    let mut settings = StoredAppSettings::default();

    for (key, value) in rows {
        if key == IMPORT_MODE_KEY {
            settings.import_mode = Some(value);
        } else if key == LIBRARY_PATH_KEY {
            settings.library_path = Some(value);
        } else if key == LOAD_REMOTE_IMAGES_KEY {
            settings.load_remote_images = Some(value);
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

/// Accepts only the two supported import modes. The UI only ever sends these, so any other
/// value comes from a bug or a compromised frontend and is rejected rather than persisted -
/// otherwise a later read would surface a nonsensical mode in the settings UI. `library_path`
/// is intentionally left free-form: it is re-derived and canonicalized downstream
/// (`library_guard`, `ensure_library_dir`), and an empty value is the valid "not configured
/// yet" state.
fn validate_import_mode(value: &str) -> AppResult<&str> {
    match value.trim() {
        mode @ ("copy" | "move") => Ok(mode),
        other => Err(AppError::from_code(
            AppErrorCode::InvalidInput,
            format!("unsupported import mode '{other}'; expected 'copy' or 'move'"),
        )),
    }
}

pub async fn set_app_settings_in_pool(
    pool: &SqlitePool,
    import_mode: &str,
    library_path: &str,
    load_remote_images: bool,
) -> AppResult<()> {
    let import_mode = validate_import_mode(import_mode)?;
    let load_remote_images = if load_remote_images { "true" } else { "false" };

    let mut tx = pool
        .begin()
        .await
        .map_err(|error| db_error("failed to begin settings transaction", error))?;

    let result = async {
        upsert_setting(&mut *tx, IMPORT_MODE_KEY, import_mode).await?;
        upsert_setting(&mut *tx, LIBRARY_PATH_KEY, library_path).await?;
        upsert_setting(&mut *tx, LOAD_REMOTE_IMAGES_KEY, load_remote_images).await?;
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

        set_app_settings_in_pool(&pool, "move", "/library", true)
            .await
            .unwrap();

        let settings = get_app_settings_from_pool(&pool).await.unwrap();

        assert_eq!(settings.import_mode.as_deref(), Some("move"));
        assert_eq!(settings.library_path.as_deref(), Some("/library"));
        assert_eq!(settings.load_remote_images.as_deref(), Some("true"));
    }

    #[tokio::test]
    async fn set_app_settings_persists_the_remote_images_preference() {
        let pool = create_test_pool().await;

        set_app_settings_in_pool(&pool, "copy", "/library", false)
            .await
            .unwrap();

        let settings = get_app_settings_from_pool(&pool).await.unwrap();
        assert_eq!(settings.load_remote_images.as_deref(), Some("false"));
    }

    #[tokio::test]
    async fn set_app_settings_upserts_existing_keys() {
        let pool = create_test_pool().await;

        set_app_settings_in_pool(&pool, "copy", "/old", true)
            .await
            .unwrap();
        set_app_settings_in_pool(&pool, "move", "/new", false)
            .await
            .unwrap();

        let settings = get_app_settings_from_pool(&pool).await.unwrap();

        assert_eq!(settings.import_mode.as_deref(), Some("move"));
        assert_eq!(settings.library_path.as_deref(), Some("/new"));
        assert_eq!(settings.load_remote_images.as_deref(), Some("false"));

        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM app_settings")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 3);
    }

    #[tokio::test]
    async fn set_app_settings_rejects_an_unknown_import_mode() {
        let pool = create_test_pool().await;

        let error = set_app_settings_in_pool(&pool, "teleport", "/library", true)
            .await
            .unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidInput.as_str());

        // Validation happens before the transaction opens, so nothing is persisted.
        let settings = get_app_settings_from_pool(&pool).await.unwrap();
        assert_eq!(settings.import_mode, None);
        assert_eq!(settings.library_path, None);
    }

    #[tokio::test]
    async fn set_app_settings_accepts_and_trims_valid_modes() {
        let pool = create_test_pool().await;

        set_app_settings_in_pool(&pool, "  move  ", "/library", true)
            .await
            .unwrap();

        let settings = get_app_settings_from_pool(&pool).await.unwrap();
        assert_eq!(settings.import_mode.as_deref(), Some("move"));
    }
}
