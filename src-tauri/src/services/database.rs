use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::{Mutex, OnceCell};

use crate::{AppError, AppErrorCode, AppResult};

const DATABASE_FILE_NAME: &str = "kavynex.db";
pub(crate) const SQLITE_BUSY_TIMEOUT_MS: u64 = 30_000;
const MAX_CONNECTIONS: u32 = 4;

const IMPORT_MODE_KEY: &str = "import_mode";
const LIBRARY_PATH_KEY: &str = "library_path";
const LOAD_REMOTE_IMAGES_KEY: &str = "load_remote_images";
const CHECK_UPDATES_ON_STARTUP_KEY: &str = "check_updates_on_startup";
const EXTERNAL_BACKUP_DIR_KEY: &str = "external_backup_dir";

/// The application database, held in Tauri-managed state (`app.manage`) rather than a
/// process-wide static. The pool is created once, lazily, on first access and reused for the
/// lifetime of the app. Connection options (WAL, busy timeout, foreign keys) are applied per
/// connection so every pooled connection is configured consistently. Keeping it in managed
/// state (keyed to the resolved database path captured at startup) takes the database out of a
/// global mutable static and lets tests inject an in-memory pool via [`Db::from_pool`].
pub struct Db {
    path: PathBuf,
    pool: OnceCell<SqlitePool>,
    // Serializes opening the pool against the restore-from-backup flow. Restore renames the
    // database file (and its -wal/-shm sidecars) out from under any concurrent open, so it holds
    // this lock for its whole run and pool opening waits on it. Only ever contended on the one-time
    // open. Once the pool is cached, `pool()` returns it below without taking the lock.
    open_lock: Mutex<()>,
}

impl Db {
    /// Creates the managed handle for the database at `path`. The pool is not opened here. It
    /// opens lazily on the first [`Db::pool`] call.
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            pool: OnceCell::new(),
            open_lock: Mutex::new(()),
        }
    }

    /// Returns the shared pool, opening (and migrating) it on first use. The returned
    /// `SqlitePool` is a cheap `Arc` clone, so callers hold it by value.
    pub async fn pool(&self) -> AppResult<SqlitePool> {
        // Steady state. The pool is already open, so return it without taking the open lock (which
        // only guards the one-time open against a concurrent restore-from-backup).
        if let Some(pool) = self.pool.get() {
            return Ok(pool.clone());
        }

        let _open_guard = self.open_lock.lock().await;
        let pool = self
            .pool
            .get_or_try_init(|| build_pool_at(&self.path))
            .await?;

        Ok(pool.clone())
    }

    /// Acquires the lock that serializes pool opening, for the restore-from-backup flow. Held for
    /// the whole restore so no concurrent command can open (and thereby create/rename) the database
    /// file while the restore renames it underneath. The caller must re-check [`Db::is_initialized`]
    /// while holding the returned guard. The pool may have opened between the caller's first check
    /// and acquiring the lock.
    pub async fn restore_guard(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.open_lock.lock().await
    }

    /// The resolved on-disk path of the database file. Its parent is the app config directory,
    /// which also holds sibling artifacts (backups, the migration commit marker), so callers
    /// that only hold the managed `Db` can locate those without a separate `AppHandle`.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Whether the pool has already been opened. Guards the restore-from-backup flow, which
    /// must only run while the database is closed (i.e. after a failed open). A failed
    /// `get_or_try_init` above does not cache, so the cell stays empty until an open succeeds.
    pub fn is_initialized(&self) -> bool {
        self.pool.get().is_some()
    }

    /// Builds a handle whose pool is already open, for tests that manage a `Db` onto a mock
    /// app so pool-only commands can be driven through the real IPC boundary.
    #[cfg(test)]
    pub fn from_pool(pool: SqlitePool) -> Self {
        let cell = OnceCell::new();
        let _ = cell.set(pool);

        Self {
            path: PathBuf::new(),
            pool: cell,
            open_lock: Mutex::new(()),
        }
    }
}

// Exposed to the frontend as `StoredAppSettingsPayload`, and serde camelCase is honored by
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
    // "true"/"false" (absent means never set). Controls whether the webview loads remote
    // comment/live-chat author avatars and custom emojis from Google's CDNs.
    pub load_remote_images: Option<String>,
    // "true"/"false" (absent means never set). When "true" the app runs one passive update check
    // on startup. Off by default, so the app contacts the update endpoint only when explicitly
    // asked, preserving the manual-only privacy stance unless the user opts in.
    pub check_updates_on_startup: Option<String>,
    // Absolute path of a user-chosen external directory the database is mirrored into once a day
    // (absent/empty means the feature is off). Kept off-volume from the app config directory so a
    // disk failure that takes the live database and its `.bak` snapshots does not take this too.
    pub external_backup_dir: Option<String>,
}

/// One entry per key `app_settings` holds.
///
/// The read query, the row-to-field dispatch and the whole-row write all derive from this table,
/// so adding a setting is a field on [`StoredAppSettings`] plus a line here. Before it, the same
/// setting had to be added to a hand-counted `IN (?, ?, ?, ?, ?)` list, an `if key == ...` chain
/// and a positional parameter list, each of which could be forgotten on its own, and forgetting
/// the first two is silent, since a key that is never selected simply reads back as "never set".
struct SettingSpec {
    key: &'static str,
    /// Puts a value read from the database into its field.
    load: fn(&mut StoredAppSettings, String),
    /// Reads the field back on the way out. `None` means "leave this key untouched", which is how
    /// a partial write (the whole-row write does not own `external_backup_dir`) skips a key rather
    /// than clearing it.
    store: fn(&StoredAppSettings) -> Option<&str>,
    /// Validates and normalizes a value before it is written. Runs for every key ahead of the
    /// transaction, so a rejected value persists nothing at all.
    normalize: fn(&str) -> AppResult<String>,
}

/// The normalizer for a setting whose value the app does not constrain. A path, a flag already
/// rendered by the caller. Stored as given.
fn store_as_given(value: &str) -> AppResult<String> {
    Ok(value.to_string())
}

const SETTINGS: &[SettingSpec] = &[
    SettingSpec {
        key: IMPORT_MODE_KEY,
        load: |settings, value| settings.import_mode = Some(value),
        store: |settings| settings.import_mode.as_deref(),
        // The one setting with a closed set of legal values, so the only one whose normalizer
        // can reject rather than pass through.
        normalize: |value| validate_import_mode(value).map(str::to_string),
    },
    SettingSpec {
        key: LIBRARY_PATH_KEY,
        load: |settings, value| settings.library_path = Some(value),
        store: |settings| settings.library_path.as_deref(),
        // Deliberately unconstrained here. It is re-derived and canonicalized downstream
        // (library::guard, ensure_library_dir), gated at the command boundary by
        // validate_settings_library_path, and an empty value is the valid "not configured yet"
        // state.
        normalize: store_as_given,
    },
    SettingSpec {
        key: LOAD_REMOTE_IMAGES_KEY,
        load: |settings, value| settings.load_remote_images = Some(value),
        store: |settings| settings.load_remote_images.as_deref(),
        normalize: store_as_given,
    },
    SettingSpec {
        key: CHECK_UPDATES_ON_STARTUP_KEY,
        load: |settings, value| settings.check_updates_on_startup = Some(value),
        store: |settings| settings.check_updates_on_startup.as_deref(),
        normalize: store_as_given,
    },
    SettingSpec {
        key: EXTERNAL_BACKUP_DIR_KEY,
        load: |settings, value| settings.external_backup_dir = Some(value),
        store: |settings| settings.external_backup_dir.as_deref(),
        // Validated at the command boundary (set_external_backup_dir), which is also the only
        // writer. The whole-row write below leaves this field `None` and therefore skips the key.
        normalize: store_as_given,
    },
];

/// Renders a boolean setting the way the table stores it. The `app_settings` value column is
/// TEXT, so every flag is `"true"`/`"false"`. Keeping the conversion in one place is what stops a
/// second spelling (`"1"`, `"yes"`) from being introduced by a later caller, since the read side
/// treats anything that is not exactly `"true"` as false.
pub(crate) fn bool_setting(value: bool) -> Option<String> {
    Some(if value { "true" } else { "false" }.to_string())
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

/// The raw driver message for a SQLite database error, if it carries one. For a constraint
/// violation this is text like `UNIQUE constraint failed: videos.youtube_video_id`, which lets a
/// caller tell *which* constraint fired instead of assuming it, so a unique violation can be mapped
/// to the right domain error rather than blanket-labeled. Returns `None` for a non-database error
/// (a pool/IO error), which carries no such message.
pub(crate) fn database_error_message(error: &sqlx::Error) -> Option<String> {
    use sqlx::error::DatabaseError;

    match error {
        sqlx::Error::Database(database_error) => {
            Some(DatabaseError::message(database_error.as_ref()).to_string())
        }
        _ => None,
    }
}

/// True when a sqlx error is a SQLite FOREIGN KEY constraint violation, so an insert against a
/// no-longer-existing parent row (e.g. a channel deleted concurrently) can be mapped to a
/// friendly domain error instead of surfacing the raw SQL message.
pub(crate) fn is_foreign_key_violation(error: &sqlx::Error) -> bool {
    use sqlx::error::DatabaseError;

    match error {
        sqlx::Error::Database(database_error) => {
            DatabaseError::is_foreign_key_violation(database_error.as_ref())
        }
        _ => false,
    }
}

pub fn database_path<R: Runtime>(app: &AppHandle<R>) -> AppResult<PathBuf> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| db_error("failed to resolve app database directory", error))?;

    std::fs::create_dir_all(&config_dir)
        .map_err(|error| db_error("failed to create app database directory", error))?;

    Ok(config_dir.join(DATABASE_FILE_NAME))
}

async fn build_pool_at(path: &Path) -> AppResult<SqlitePool> {
    // The pre-migration snapshot only matters when a migration will actually run (so a bad
    // migration or corruption can be rolled back). When one is pending, snapshot
    // synchronously before opening the pool. Otherwise, defer the daily snapshot to a
    // background task so a normal launch is never blocked by a VACUUM of a large database.
    // Best effort either way. A backup failure must not stop the app from opening.
    let migration_pending = crate::services::db_backup::is_schema_migration_pending(path).await;

    if migration_pending {
        // Refuse to migrate a database that is already damaged. A migration can rebuild tables, so
        // running one over a corrupt file risks amplifying the damage, and the pre-migration
        // snapshot below is skipped precisely when the source is unhealthy (backup_database bails on
        // a failed quick_check), so it cannot be relied on to roll the migration back afterwards.
        // When the file exists but fails quick_check, stop here. The frontend's startup recovery
        // then offers to restore from the last healthy backup (see use-app-bootstrap.ts) instead of
        // migrating over a bad file. A missing file (first run) is not a database yet, so it is
        // exempt. A subtly damaged file that still passes the fast quick_check is not caught here
        // (that would need a full integrity_check on every launch), which is an accepted limit.
        if path.exists() && !crate::services::db_backup::database_quick_check_ok(path).await {
            return Err(AppError::from_code_with_details(
                AppErrorCode::AppError,
                "the database failed an integrity check and a schema migration is pending, so restore from a backup before continuing",
                "quick_check failed on the existing database before a pending migration, refusing to migrate to avoid amplifying corruption",
            ));
        }

        // The pre-migration snapshot is the only rollback point once schema DDL runs, so a real
        // backup failure must block the migration rather than proceed unprotected. A throttled or
        // skipped backup returns Ok(false). A recent snapshot already predates this migration, so
        // that case is fine. Only an Err (disk full, permission denied, a failed VACUUM) is fatal.
        // A brand-new database (first run, no file yet) never reaches here as an Err either.
        // backup_database returns Ok(false) immediately when the file is missing, so first-run setup
        // is not blocked. The frontend's startup recovery flow handles this AppError the same way it
        // handles the quick_check gate above, by offering a restore from the last healthy backup.
        if let Err(error) = crate::services::db_backup::backup_database(path).await {
            return Err(AppError::from_code_with_details(
                AppErrorCode::AppError,
                "could not snapshot the database before a pending schema migration, so free up disk \
                 space and check permissions on the app config directory, then restart, or restore \
                 from a backup in Settings > Database",
                error.to_string(),
            ));
        }
    }

    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        // WAL + NORMAL is durable across app crashes and only risks the last few
        // transactions on an OS crash/power loss. The standard, faster tradeoff for a
        // desktop app versus the default FULL fsync on every commit.
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .connect_with(options)
        .await
        .map_err(|error| db_error("failed to open app database", error))?;

    // The schema is owned by the backend. create/migrate it as part of pool
    // initialization so it is ready before any query runs.
    crate::services::db_schema::ensure_schema(&pool).await?;

    if !migration_pending {
        // No migration ran, so the snapshot was skipped above. Take the (throttled) daily
        // one off the critical path.
        let background_path = path.to_path_buf();
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

/// Returns the shared database pool, initializing it on first use. Resolves the managed [`Db`]
/// handle from the app and delegates to it. It's kept as a free function so the many call sites
/// that only hold an `AppHandle` do not each need to reach into managed state. The returned pool
/// is a cheap `Arc` clone.
///
/// Generic over the runtime rather than tied to `AppHandle<Wry>`. That is not a style preference.
/// `AppHandle` alone resolves to the real runtime, and `tauri::test::mock_builder` produces an
/// `App<MockRuntime>`, so every function in a chain that names the bare alias is unreachable from a
/// test, which is what kept the media-creation orchestration untested. `try_state` is available on
/// any runtime, so this costs nothing to widen.
pub async fn shared_pool<R: tauri::Runtime>(app: &AppHandle<R>) -> AppResult<SqlitePool> {
    // `try_state` (not `state`) so a missing handle surfaces as a normal error instead of a
    // panic. It is only ever absent when the database path could not be resolved at startup
    // (see the setup in lib.rs), which is the same catastrophic case the old code degraded to
    // an error for rather than crashing.
    let db = app.try_state::<Db>().ok_or_else(|| {
        db_error(
            "the database is not initialized",
            "no managed database handle",
        )
    })?;

    db.pool().await
}

/// Whether the shared pool has already been opened. Used to guard the restore-from-backup
/// flow, which must only run while the database is closed (i.e. after a failed open).
pub fn is_pool_initialized<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<Db>()
        .map(|db| db.is_initialized())
        .unwrap_or(false)
}

/// Folds the write-ahead log back into the main database file and truncates it.
///
/// Not a durability step: WAL with `synchronous=NORMAL` is already crash-safe, and SQLite
/// checkpoints on its own every ~1000 pages. What this buys is a small `-wal` sidecar between
/// sessions. A session of light, sporadic writes never crosses the automatic threshold, so without
/// an explicit checkpoint the sidecar can sit at a few MB indefinitely, which the size reported in
/// Settings > Database includes. Best effort. `TRUNCATE` waits for readers, but at exit there are
/// none, and a failure costs nothing but the sidecar staying as it was.
pub async fn checkpoint_wal(pool: &SqlitePool) -> AppResult<()> {
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|error| db_error("failed to checkpoint the database write-ahead log", error))
}

/// How long the exit-time checkpoint may block the shutdown. A checkpoint of a few MB is
/// milliseconds; the bound is for a stuck connection, where holding the window open is worse than
/// leaving the sidecar.
const EXIT_CHECKPOINT_TIMEOUT: Duration = Duration::from_secs(5);

/// [`checkpoint_wal`] for the app-exit path, which is synchronous. Does nothing when the pool was
/// never opened (a session that never touched the database has no log to fold), and never opens
/// it. The point of exit is to stop, not to start.
pub fn checkpoint_wal_blocking<R: Runtime>(app: &AppHandle<R>) {
    let Some(db) = app.try_state::<Db>() else {
        return;
    };

    if !db.is_initialized() {
        return;
    }

    let outcome = tauri::async_runtime::block_on(async {
        let pool = db.pool().await?;

        match tokio::time::timeout(EXIT_CHECKPOINT_TIMEOUT, checkpoint_wal(&pool)).await {
            Ok(result) => result,
            Err(_) => Err(db_error(
                "the exit-time write-ahead log checkpoint timed out",
                "timed out",
            )),
        }
    });

    if let Err(error) = outcome {
        crate::services::logger::warn(
            "database",
            format!("exit-time write-ahead log checkpoint skipped: {error}"),
        );
    }
}

pub async fn get_app_settings_from_pool(pool: &SqlitePool) -> AppResult<StoredAppSettings> {
    // Every row, with no `IN (?, ?, ...)` filter. The filter used to be the thing that had to
    // grow a placeholder per setting, and building that list dynamically would mean handing sqlx
    // a non-literal SQL string, which it refuses outright (`SqlSafeStr`), correctly, since that
    // is the shape injection arrives in. Selecting the whole table sidesteps both. It is a
    // handful of rows on a local database, the dispatch below already ignores a key it does not
    // recognize, and adding a setting now touches the query not at all.
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT key, value FROM app_settings")
        .fetch_all(pool)
        .await
        .map_err(|error| db_error("failed to read app settings", error))?;

    let mut settings = StoredAppSettings::default();

    for (key, value) in rows {
        if let Some(spec) = SETTINGS.iter().find(|spec| spec.key == key) {
            (spec.load)(&mut settings, value);
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
/// value comes from a bug or a compromised frontend and is rejected rather than persisted.
/// otherwise a later read would surface a nonsensical mode in the settings UI. `library_path`
/// is intentionally left free-form. It is re-derived and canonicalized downstream
/// (`library::guard`, `ensure_library_dir`), and an empty value is the valid "not configured
/// yet" state.
fn validate_import_mode(value: &str) -> AppResult<&str> {
    match value.trim() {
        mode @ ("copy" | "move") => Ok(mode),
        other => Err(AppError::from_code(
            AppErrorCode::InvalidInput,
            format!("unsupported import mode '{other}' (expected 'copy' or 'move')"),
        )),
    }
}

/// Upserts only the library path setting. Used by the interrupted-migration recovery, which
/// adopts a new library directory recorded by a migration that crashed before the frontend
/// could persist it (see `services::library::recovery`). The other settings are left untouched.
pub(crate) async fn set_library_path_in_pool(
    pool: &SqlitePool,
    library_path: &str,
) -> AppResult<()> {
    upsert_setting(pool, LIBRARY_PATH_KEY, library_path)
        .await
        .map_err(|error| db_error("failed to persist the recovered library path", error))
}

/// Upserts only the external backup directory setting (Settings > Database). An empty value is the
/// valid "turn the feature off" state. A non-empty value is validated by the command layer before
/// it reaches here. Kept a standalone setting rather than folded into `set_app_settings_in_pool`
/// so toggling the backup destination never has to round-trip the whole settings form.
pub async fn set_external_backup_dir_in_pool(
    pool: &SqlitePool,
    external_backup_dir: &str,
) -> AppResult<()> {
    upsert_setting(pool, EXTERNAL_BACKUP_DIR_KEY, external_backup_dir)
        .await
        .map_err(|error| db_error("failed to persist the external backup directory", error))
}

/// Writes every field `settings` carries a value for, in one transaction. A field left `None` is
/// skipped rather than cleared, which is what lets a caller own a subset of the keys. The
/// settings form owns four, while `external_backup_dir` is written by its own command.
///
/// Takes the whole struct rather than one parameter per key so adding a setting does not grow a
/// positional argument list that a caller could pass in the wrong order (all four of the current
/// values are strings or bools, so a swap would compile).
pub async fn set_app_settings_in_pool(
    pool: &SqlitePool,
    settings: &StoredAppSettings,
) -> AppResult<()> {
    // Normalize every value before the transaction opens, so a rejected one persists nothing at
    // all rather than leaving the keys ahead of it written.
    let mut pending: Vec<(&'static str, String)> = Vec::new();

    for spec in SETTINGS {
        let Some(value) = (spec.store)(settings) else {
            continue;
        };

        pending.push((spec.key, (spec.normalize)(value)?));
    }

    let mut tx = pool
        .begin()
        .await
        .map_err(|error| db_error("failed to begin settings transaction", error))?;

    let result = async {
        for (key, value) in &pending {
            upsert_setting(&mut *tx, key, value).await?;
        }

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

    /// The four keys the settings form owns, shaped the way `commands::settings` builds them.
    /// `external_backup_dir` stays `None` here for the same reason it does there. It has its own
    /// command, and a `None` field is skipped rather than cleared.
    fn form_settings(
        import_mode: &str,
        library_path: &str,
        load_remote_images: bool,
        check_updates_on_startup: bool,
    ) -> StoredAppSettings {
        StoredAppSettings {
            import_mode: Some(import_mode.to_string()),
            library_path: Some(library_path.to_string()),
            load_remote_images: bool_setting(load_remote_images),
            check_updates_on_startup: bool_setting(check_updates_on_startup),
            external_backup_dir: None,
        }
    }

    #[tokio::test]
    async fn checkpoint_wal_truncates_the_sidecar_after_writes() {
        // A file-backed pool in WAL mode, the same options the app opens with. Writes land in
        // the -wal sidecar first; the checkpoint folds them into the main file and truncates it,
        // which is the observable the exit-time call exists for.
        let dir = std::env::temp_dir().join(format!(
            "kavynex-checkpoint-test-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("kavynex.db");
        let wal_path = dir.join("kavynex.db-wal");

        let options = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();

        sqlx::query("CREATE TABLE t (value TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        for index in 0..64 {
            sqlx::query("INSERT INTO t (value) VALUES (?1)")
                .bind(format!("row {index}"))
                .execute(&pool)
                .await
                .unwrap();
        }

        let before = std::fs::metadata(&wal_path).unwrap().len();
        assert!(
            before > 0,
            "the writes must have landed in the -wal sidecar first"
        );

        checkpoint_wal(&pool).await.unwrap();

        let after = std::fs::metadata(&wal_path).unwrap().len();
        assert_eq!(after, 0, "TRUNCATE must leave the sidecar empty");

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM t")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 64, "the checkpoint must not lose a row");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
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

        set_app_settings_in_pool(&pool, &form_settings("move", "/library", true, true))
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

        set_app_settings_in_pool(&pool, &form_settings("copy", "/library", false, false))
            .await
            .unwrap();

        let settings = get_app_settings_from_pool(&pool).await.unwrap();
        assert_eq!(settings.load_remote_images.as_deref(), Some("false"));
    }

    #[tokio::test]
    async fn set_app_settings_upserts_existing_keys() {
        let pool = create_test_pool().await;

        set_app_settings_in_pool(&pool, &form_settings("copy", "/old", true, false))
            .await
            .unwrap();
        set_app_settings_in_pool(&pool, &form_settings("move", "/new", false, true))
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
        assert_eq!(count, 4);
    }

    #[tokio::test]
    async fn a_none_field_leaves_its_key_alone_instead_of_clearing_it() {
        // The property the whole-row write depends on, and the reason it takes a struct of
        // options rather than a value per key. The settings form owns four of the five keys, so
        // saving it must not touch `external_backup_dir`. Writing every field unconditionally
        // would turn every save of the Settings modal into a silent "external backup off".
        let pool = create_test_pool().await;

        set_external_backup_dir_in_pool(&pool, "/mnt/backup")
            .await
            .unwrap();

        set_app_settings_in_pool(&pool, &form_settings("move", "/library", true, true))
            .await
            .unwrap();

        let settings = get_app_settings_from_pool(&pool).await.unwrap();

        assert_eq!(
            settings.external_backup_dir.as_deref(),
            Some("/mnt/backup"),
            "a field the caller left None must survive a whole-row write"
        );
        // The four the form does own still landed.
        assert_eq!(settings.import_mode.as_deref(), Some("move"));
        assert_eq!(settings.library_path.as_deref(), Some("/library"));
    }

    #[test]
    fn each_spec_entry_loads_and_stores_its_own_distinct_field() {
        // The failure this table makes possible. A copy-pasted entry whose `load` writes one field
        // while its `store` reads another, or two entries sharing a field. Neither shows up as a
        // round-trip failure. The value still comes back, just under the wrong key, which surfaces
        // as one setting silently taking another's value.
        //
        // Loading a single entry and requiring every *other* entry to still read None is what
        // catches both, and it covers a setting added later without needing its own assertion.
        // Deliberately not routed through the pool. `import_mode`'s normalizer rejects anything
        // outside its closed set, so a generic value per entry cannot be written, and the pairing
        // this asserts is a property of the table rather than of the SQL.
        for spec in SETTINGS {
            let mut settings = StoredAppSettings::default();
            (spec.load)(&mut settings, "loaded".to_string());

            for other in SETTINGS {
                let expected = if std::ptr::eq(other, spec) {
                    Some("loaded")
                } else {
                    None
                };

                assert_eq!(
                    (other.store)(&settings),
                    expected,
                    "loading {} left {} reading {:?}",
                    spec.key,
                    other.key,
                    (other.store)(&settings)
                );
            }
        }
    }

    #[test]
    fn setting_keys_are_unique() {
        // A duplicated key would make the read dispatch pick whichever entry `find` reached first
        // and the write emit two upserts for one key, with the second silently winning.
        for (index, spec) in SETTINGS.iter().enumerate() {
            assert!(
                !SETTINGS[..index].iter().any(|other| other.key == spec.key),
                "{} appears more than once in SETTINGS",
                spec.key
            );
        }
    }

    #[tokio::test]
    async fn set_app_settings_rejects_an_unknown_import_mode() {
        let pool = create_test_pool().await;

        let error =
            set_app_settings_in_pool(&pool, &form_settings("teleport", "/library", true, false))
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

        set_app_settings_in_pool(&pool, &form_settings("  move  ", "/library", true, false))
            .await
            .unwrap();

        let settings = get_app_settings_from_pool(&pool).await.unwrap();
        assert_eq!(settings.import_mode.as_deref(), Some("move"));
    }

    #[test]
    fn db_error_uses_the_app_error_code_so_the_ui_suppresses_raw_details() {
        // db_error attaches the raw driver text as `details` for diagnostics, but under the
        // APP_ERROR code the frontend resolves the message to a generic string and never surfaces
        // `details` (see src/utils/user-friendly-error.ts, which has tests pinning that). This
        // pins the backend half of that contract. db_error must keep emitting APP_ERROR, so a raw
        // SQLite message can never reach the user verbatim as the primary error text.
        let error = db_error(
            "failed to insert media",
            "UNIQUE constraint failed: videos.file_path",
        );

        assert_eq!(error.code, AppErrorCode::AppError.as_str());
        assert_eq!(
            error.details.as_deref(),
            Some("UNIQUE constraint failed: videos.file_path")
        );
    }
}
