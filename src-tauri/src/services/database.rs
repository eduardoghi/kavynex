use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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
pub(crate) const LIBRARY_PATH_KEY: &str = "library_path";
pub(crate) const LOAD_REMOTE_IMAGES_KEY: &str = "load_remote_images";
const CHECK_UPDATES_ON_STARTUP_KEY: &str = "check_updates_on_startup";
pub(crate) const EXTERNAL_BACKUP_DIR_KEY: &str = "external_backup_dir";

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
    // Set once the user chose to start over with an empty database although backups of the missing
    // one exist (see [`missing_database_error`]). Until then a missing file with backups beside it
    // is refused rather than created.
    allow_create_missing: AtomicBool,
}

impl Db {
    /// Creates the managed handle for the database at `path`. The pool is not opened here. It
    /// opens lazily on the first [`Db::pool`] call.
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            pool: OnceCell::new(),
            open_lock: Mutex::new(()),
            allow_create_missing: AtomicBool::new(false),
        }
    }

    /// Lets the next open create the database file even though backups of a missing one exist,
    /// for a user who chose to start with an empty library rather than restore.
    pub fn allow_creating_missing_database(&self) {
        self.allow_create_missing.store(true, Ordering::SeqCst);
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
            .get_or_try_init(|| {
                build_pool_at(&self.path, self.allow_create_missing.load(Ordering::SeqCst))
            })
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
            allow_create_missing: AtomicBool::new(false),
        }
    }
}

// Exposed to the frontend as `StoredAppSettingsPayload`, and serde camelCase is honored by
// ts-rs so the generated keys are importMode/libraryPath.
#[derive(Debug, Default, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    test,
    ts(
        export,
        rename = "StoredAppSettingsPayload",
        export_to = "../../src/types/generated/"
    )
)]
pub struct StoredAppSettings {
    pub import_mode: Option<String>,
    pub library_path: Option<String>,
    // "true"/"false" (absent means never set). Controls whether the webview loads remote
    // comment/live-chat author avatars and custom emojis from Google's CDNs.
    pub load_remote_images: Option<String>,
    // "true"/"false" (absent means never set). Controls the one passive update check the app runs
    // on startup. Unlike `load_remote_images` above, this is opt-out: the frontend reads an absent
    // key as on, so only an explicit "false" disables it (see normalizeCheckUpdatesOnStartup in
    // use-app-settings-storage.ts, which owns that rule). Only the latest release gets fixes, and
    // the updater is how one reaches a user, so a default that never contacted the endpoint left
    // that delivery path unused for anyone who did not go looking for it. What it enables is a
    // check that shows a notice, never an install.
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

/// True when SQLite reported the file itself as damaged or as not a database (`SQLITE_CORRUPT` or
/// `SQLITE_NOTADB`, extended codes included).
///
/// Everything else a connection can fail with is about reaching the file rather than about what is
/// in it: a lock another process holds, a sharing violation while an antivirus scans it, a
/// permission error, a missing directory. Restoring a backup over the file answers only the first
/// kind, and over a healthy file it throws away everything since that backup.
pub(crate) fn sqlite_error_means_damage(error: &sqlx::Error) -> bool {
    use sqlx::error::DatabaseError;

    let sqlx::Error::Database(database_error) = error else {
        return false;
    };

    DatabaseError::code(database_error.as_ref())
        .and_then(|code| code.parse::<i32>().ok())
        .is_some_and(sqlite_result_code_means_damage)
}

/// The primary result code behind an extended one is its low byte. 11 is `SQLITE_CORRUPT` and 26 is
/// `SQLITE_NOTADB`. Split out so the arithmetic can be pinned without building a driver error.
pub(crate) fn sqlite_result_code_means_damage(code: i32) -> bool {
    matches!(code & 0xff, 11 | 26)
}

/// Whether an error already turned into an `AppError` came from SQLite reporting the file damaged.
///
/// A migration's statements go through [`db_error`], which keeps the driver's text as the details
/// (`error returned from database: (code: 11) database disk image is malformed`) but not the error
/// itself, so the code is read back out of that text.
pub(crate) fn app_error_means_damage(error: &AppError) -> bool {
    let text = format!(
        "{} {}",
        error.message,
        error.details.as_deref().unwrap_or_default()
    );

    text.match_indices("(code: ").any(|(index, prefix)| {
        text[index + prefix.len()..]
            .split(')')
            .next()
            .and_then(|code| code.trim().parse::<i32>().ok())
            .is_some_and(sqlite_result_code_means_damage)
    })
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

/// Takes the rollback point a pending migration needs, and reports only a real failure.
///
/// A database file that does not exist yet (first run) has nothing to snapshot. One whose schema
/// version cannot be read falls back to the daily snapshot, the only option that needs no version
/// to name the file by.
async fn snapshot_before_migration(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Ok(());
    }

    match crate::services::db_backup::database_schema_version(path).await {
        Some(version) => crate::services::db_backup::snapshot_before_migration(path, version)
            .await
            .map(|_| ()),
        None => crate::services::db_backup::backup_database(path)
            .await
            .map(|_| ()),
    }
}

/// The database file is there but could not be read: a lock, a sharing violation, a permission
/// error. A distinct code because the frontend's startup recovery offers a backup restore for a
/// failed open, which is the wrong answer here.
fn database_unavailable(detail: String) -> AppError {
    AppError::from_code_with_details(
        AppErrorCode::DatabaseUnavailable,
        "the database could not be read, which usually means another program is holding it",
        detail,
    )
}

/// Refuses to create `path` when it is missing and a snapshot of it is still on disk.
///
/// The pool opens with `create_if_missing`, which is right on a first run and wrong when the file
/// was taken away (an antivirus quarantine, a roaming profile reset, a deletion by mistake). The
/// app would open an empty library, and the daily snapshot of that empty file would then rotate
/// out one good generation a day. The frontend answers this code with the restore it offers for a
/// damaged database, plus the choice of starting empty.
///
/// A file of zero bytes counts as missing too. That is what a quarantine or a sync client can leave
/// behind instead of removing the file, and SQLite opens it as an empty database just the same. So
/// does a file with no schema in it (see [`database_holds_data`]). `holds_data` is that answer,
/// read by the caller before anything opens the file.
fn missing_database_error(path: &Path, allow_create: bool, holds_data: bool) -> Option<AppError> {
    if allow_create || holds_data || !crate::services::db_backup::has_backup_candidates(path) {
        return None;
    }

    Some(AppError::from_code(
        AppErrorCode::DatabaseMissing,
        "the database file is missing, but backups of it are still there",
    ))
}

/// Whether the database at `path` has anything for SQLite to open. A main file of zero bytes still
/// does when its write-ahead log is not empty, since the pages can sit there until a checkpoint.
fn database_file_holds_data(path: &Path) -> bool {
    let non_empty = |file: &Path| std::fs::metadata(file).is_ok_and(|meta| meta.len() > 0);

    let mut wal = path.as_os_str().to_owned();
    wal.push("-wal");

    non_empty(path) || (path.exists() && non_empty(Path::new(&wal)))
}

/// Whether the database at `path` holds anything worth keeping, which is data SQLite can open
/// with at least one schema object in it. A file with no schema is what a first open cut short
/// leaves behind (the app quit, or `--smoke-test` exited, while a startup task was creating the
/// database), and it counts the same as no file.
async fn database_holds_data(path: &Path) -> bool {
    database_file_holds_data(path)
        && !crate::services::db_backup::database_has_no_schema(path).await
}

async fn build_pool_at(path: &Path, allow_create: bool) -> AppResult<SqlitePool> {
    // Read before the open, which creates the file. A database made from nothing gets a new lineage
    // id once its schema is in place (see db_backup::lineage), and has no pre-migration snapshot to
    // take.
    let holds_data = database_holds_data(path).await;

    if let Some(error) = missing_database_error(path, allow_create, holds_data) {
        return Err(error);
    }

    let created_from_nothing = !holds_data;

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
        if path.exists() {
            match crate::services::db_backup::database_quick_check(path).await {
                crate::services::db_backup::QuickCheck::Healthy => {}
                crate::services::db_backup::QuickCheck::Damaged => {
                    return Err(AppError::from_code_with_details(
                        AppErrorCode::AppError,
                        "the database failed an integrity check and a schema migration is pending, so restore from a backup before continuing",
                        "quick_check failed on the existing database before a pending migration, refusing to migrate to avoid amplifying corruption",
                    ));
                }
                crate::services::db_backup::QuickCheck::Unreadable(detail) => {
                    return Err(database_unavailable(detail));
                }
            }
        }

        // The pre-migration snapshot is the only rollback point once schema DDL runs, so a failure
        // to take it (disk full, permission denied, a failed VACUUM) blocks the migration rather
        // than letting it proceed unprotected. It is never throttled, so the rollback point is the
        // database as it was a moment ago, not a daily snapshot up to a day old. A first run has no
        // file yet and nothing to snapshot.
        //
        // Its own code, because the database is fine. The startup recovery offers a restore for a
        // failed open, and a restore here would replace a healthy database with a snapshot up to a
        // day old over what is usually a full disk.
        //
        // A database made from nothing is skipped. A schema-less file left by a first open that
        // did not finish has nothing to roll back to, and its snapshot would be kept as
        // `.pre-migration-v0` beside the real ones.
        let snapshot = if created_from_nothing {
            Ok(())
        } else {
            snapshot_before_migration(path).await
        };

        if let Err(error) = snapshot {
            return Err(AppError::from_code_with_details(
                AppErrorCode::DatabaseMigrationBlocked,
                "could not snapshot the database before a pending schema migration, so free up disk \
                 space and check permissions on the app config directory, then restart",
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
        .map_err(|error| {
            if sqlite_error_means_damage(&error) {
                db_error("failed to open app database", error)
            } else {
                database_unavailable(error.to_string())
            }
        })?;

    // The schema is owned by the backend. create/migrate it as part of pool
    // initialization so it is ready before any query runs.
    //
    // A migration that fails rolls back to the version it started from, so the database is as it
    // was and an older backup would carry the same data into the same failure. Reported under its
    // own code for the same reason as the snapshot above. A database too new for this build keeps
    // its code, which the frontend answers with "update the app". A migration that ran into damage
    // the quick_check above did not catch keeps the plain error, which is the one the startup
    // recovery offers a restore for.
    crate::services::db_schema::ensure_schema(&pool)
        .await
        .map_err(|error| {
            if !migration_pending
                || error.code == AppErrorCode::DatabaseSchemaTooNew.as_str()
                || app_error_means_damage(&error)
            {
                return error;
            }

            AppError::from_code_with_details(
                AppErrorCode::DatabaseMigrationBlocked,
                "the database could not be upgraded to this version of Kavynex and was left as it was",
                error.to_string(),
            )
        })?;

    if created_from_nothing {
        crate::services::db_backup::record_new_lineage(path);
    }

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
    // Every row, with no `IN (?, ?, ...)` filter. Such a filter would have to grow a placeholder
    // per setting, and building that list dynamically would mean handing sqlx a non-literal SQL
    // string, which it refuses outright (`SqlSafeStr`), correctly, since that is the shape
    // injection arrives in. Selecting the whole table sidesteps both. It is a handful of rows on
    // a local database, the dispatch below already ignores a key it does not recognize, and
    // adding a setting touches the query not at all.
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
/// value comes from a bug or a compromised frontend and is rejected rather than persisted,
/// since otherwise a later read would surface a nonsensical mode in the settings UI. `library_path`
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
    fn only_corruption_and_not_a_database_count_as_damage() {
        // Primary codes and their extended forms, which carry the primary in the low byte.
        assert!(sqlite_result_code_means_damage(11)); // SQLITE_CORRUPT
        assert!(sqlite_result_code_means_damage(267)); // SQLITE_CORRUPT_VTAB
        assert!(sqlite_result_code_means_damage(779)); // SQLITE_CORRUPT_INDEX
        assert!(sqlite_result_code_means_damage(26)); // SQLITE_NOTADB

        assert!(!sqlite_result_code_means_damage(5)); // SQLITE_BUSY
        assert!(!sqlite_result_code_means_damage(517)); // SQLITE_BUSY_SNAPSHOT
        assert!(!sqlite_result_code_means_damage(6)); // SQLITE_LOCKED
        assert!(!sqlite_result_code_means_damage(10)); // SQLITE_IOERR
        assert!(!sqlite_result_code_means_damage(14)); // SQLITE_CANTOPEN
        assert!(!sqlite_result_code_means_damage(0));
    }

    #[test]
    fn an_error_that_is_not_from_sqlite_is_never_damage() {
        assert!(!sqlite_error_means_damage(&sqlx::Error::PoolTimedOut));
    }

    #[test]
    fn a_migration_error_carrying_a_damage_code_is_read_as_damage() {
        // What db_error leaves behind when a migration statement hits a corrupt page.
        let corrupt = db_error(
            "failed to rebuild the videos table",
            "error returned from database: (code: 11) database disk image is malformed",
        );
        assert!(app_error_means_damage(&corrupt));

        let not_a_database = db_error(
            "failed to read the schema",
            "error returned from database: (code: 26) file is not a database",
        );
        assert!(app_error_means_damage(&not_a_database));

        let full_disk = db_error(
            "failed to rebuild the videos table",
            "error returned from database: (code: 13) database or disk is full",
        );
        assert!(!app_error_means_damage(&full_disk));
        assert!(!app_error_means_damage(&db_error(
            "no code here",
            "plain text"
        )));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_database_held_by_another_program_is_unavailable_rather_than_offered_for_restore() {
        // What the startup recovery reads. A plain APP_ERROR from this path offered to restore a
        // backup over a healthy database that an antivirus scan happened to be holding.
        use std::os::windows::fs::OpenOptionsExt;

        let dir = std::env::temp_dir().join(format!(
            "kavynex-db-held-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("kavynex.db");
        std::fs::write(&path, b"").unwrap();

        let held = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&path)
            .unwrap();

        let error = build_pool_at(&path, false)
            .await
            .expect_err("a file another program holds cannot be opened");
        assert_eq!(error.code, AppErrorCode::DatabaseUnavailable.as_str());

        drop(held);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn opening_a_database_that_needs_a_migration_snapshots_it_first() {
        // A real v5 database, so ensure_schema has migrations to run. The daily .bak is fresh,
        // which is the case where the rollback point could be that day-old snapshot instead of
        // the database as it was a moment before the migration.
        let dir = std::env::temp_dir().join(format!(
            "kavynex-premigration-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("kavynex.db");
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/kavynex_v1_user_version_5.sqlite"),
            &path,
        )
        .unwrap();
        std::fs::write(dir.join("kavynex.db.bak"), b"a recent daily snapshot").unwrap();

        let pool = build_pool_at(&path, false)
            .await
            .expect("the v5 fixture must open and migrate");
        pool.close().await;

        assert!(
            !dir.join("kavynex.db.lineage").exists(),
            "a database that already existed keeps mirroring without a lineage id"
        );

        let snapshot = dir.join("kavynex.db.pre-migration-v5");
        assert!(
            snapshot.is_file(),
            "the rollback point must be the database before migrating"
        );
        assert_eq!(
            crate::services::db_backup::database_schema_version(&snapshot).await,
            Some(5),
            "the snapshot is the old schema, not the migrated one"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn missing_database_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kavynex-{name}-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn a_missing_database_with_backups_beside_it_is_not_created_empty() {
        let dir = missing_database_dir("db-missing");
        let path = dir.join("kavynex.db");
        std::fs::write(dir.join("kavynex.db.bak.2"), b"an older snapshot").unwrap();

        let error = build_pool_at(&path, false)
            .await
            .expect_err("an empty database would push the backups out");

        assert_eq!(error.code, AppErrorCode::DatabaseMissing.as_str());
        assert!(!path.exists(), "nothing was created at the database path");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_zero_byte_database_with_backups_beside_it_counts_as_missing() {
        let dir = missing_database_dir("db-zero-bytes");
        let path = dir.join("kavynex.db");
        std::fs::write(&path, b"").unwrap();
        std::fs::write(dir.join("kavynex.db.bak"), b"a snapshot").unwrap();

        let error = build_pool_at(&path, false)
            .await
            .expect_err("an emptied file would open as an empty library");

        assert_eq!(error.code, AppErrorCode::DatabaseMissing.as_str());
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // What a first open cut short leaves behind. SQLite has written its header, so the file is not
    // empty, but no table was created yet.
    async fn write_schema_less_database(path: &Path) {
        let pool = SqlitePool::connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(true)
                .journal_mode(SqliteJournalMode::Wal),
        )
        .await
        .unwrap();
        pool.close().await;
        assert!(database_file_holds_data(path), "the header must be on disk");
    }

    #[tokio::test]
    async fn a_schema_less_database_from_a_cut_short_first_open_is_treated_as_new() {
        // `--smoke-test` exiting while the startup integrity check opens the database for the first
        // time leaves this file. Read as an existing database, it would get a pre-migration
        // snapshot of nothing and the new library no lineage id.
        let dir = missing_database_dir("db-schema-less");
        let path = dir.join("kavynex.db");
        write_schema_less_database(&path).await;

        let pool = build_pool_at(&path, false)
            .await
            .expect("an empty first database opens");
        pool.close().await;

        assert!(
            !dir.join("kavynex.db.pre-migration-v0").exists(),
            "an empty file has nothing to roll back to"
        );
        assert!(
            dir.join("kavynex.db.lineage").is_file(),
            "it is a database made from nothing"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_schema_less_database_with_backups_beside_it_counts_as_missing() {
        let dir = missing_database_dir("db-schema-less-backups");
        let path = dir.join("kavynex.db");
        write_schema_less_database(&path).await;
        std::fs::write(dir.join("kavynex.db.bak"), b"a snapshot").unwrap();

        let error = build_pool_at(&path, false)
            .await
            .expect_err("opening it would start an empty library over the backups");

        assert_eq!(error.code, AppErrorCode::DatabaseMissing.as_str());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_zero_byte_main_file_with_its_pages_in_the_log_still_holds_data() {
        let dir = missing_database_dir("db-zero-bytes-wal");
        let path = dir.join("kavynex.db");
        std::fs::write(&path, b"").unwrap();
        assert!(!database_file_holds_data(&path));

        std::fs::write(dir.join("kavynex.db-wal"), b"frames").unwrap();
        assert!(database_file_holds_data(&path));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn starting_empty_is_allowed_once_the_user_chose_it() {
        let dir = missing_database_dir("db-start-empty");
        let path = dir.join("kavynex.db");
        std::fs::write(dir.join("kavynex.db.bak"), b"a snapshot").unwrap();

        let pool = build_pool_at(&path, true)
            .await
            .expect("the user chose an empty library");
        pool.close().await;

        assert!(path.is_file());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_first_run_with_no_backups_creates_the_database() {
        let dir = missing_database_dir("db-first-run");
        let path = dir.join("kavynex.db");

        let pool = build_pool_at(&path, false)
            .await
            .expect("a first run has nothing to protect");
        pool.close().await;

        assert!(path.is_file());
        assert!(
            dir.join("kavynex.db.lineage").is_file(),
            "a database made from nothing gets a lineage id for its external copies"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_real_damage_error_from_the_driver_is_read_as_damage() {
        // app_error_means_damage reads the code out of the driver's text, so this pins that text
        // against the sqlx in the lockfile rather than against a string written here. A sqlx that
        // formats its errors differently fails this, instead of turning a corrupt database met
        // during a migration back into a refusal with no restore offered.
        let dir = std::env::temp_dir().join(format!(
            "kavynex-db-real-damage-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("garbage.db");
        std::fs::write(&path, vec![0x5A_u8; 8192]).unwrap();

        let error = match SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(&path))
            .await
        {
            Ok(pool) => {
                let error = sqlx::query("SELECT name FROM sqlite_master")
                    .fetch_all(&pool)
                    .await
                    .expect_err("the file is not a database");
                pool.close().await;
                error
            }
            Err(error) => error,
        };

        assert!(app_error_means_damage(&db_error(
            "failed to read the schema",
            error
        )));

        let _ = std::fs::remove_dir_all(&dir);
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
