//! Importing a user-selected database file means validating it is a healthy kavynex database,
//! staging it atomically, and swapping it in on the next startup (the live connection pool is a
//! process-wide singleton that cannot be reopened in-process, so the actual swap is deferred).
//! The undo path reuses the same machinery to revert the last import.
//!
//! Tests for everything here live in the parent module's `mod tests`, alongside the backup and
//! restore tests they share helpers with. The internals those tests reach are `pub(super)`.

use std::path::{Path, PathBuf};

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};

use super::{backup_error, is_healthy, open, sibling};
use crate::services::database::{
    get_app_settings_from_pool, EXTERNAL_BACKUP_DIR_KEY, LIBRARY_PATH_KEY, LOAD_REMOTE_IMAGES_KEY,
    SQLITE_BUSY_TIMEOUT_MS,
};
use crate::services::logger;
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

pub(super) fn import_staged_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".import-staged")
}

pub(crate) fn pre_import_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".pre-import")
}

/// Marks that an import swap is in progress. Written before the current database is moved aside
/// and cleared once the swap (or its rollback) has left a database back at `db_path`.
///
/// A marker that survives a restart is the only way to tell the two states apart that otherwise
/// look identical on disk (a staged import, a `.pre-import`, and a file at `db_path`). A normal
/// second import, where `.pre-import` is last import's undo copy and `db_path` is the user's real
/// database, versus a swap that died in between, where `.pre-import` holds the *only* copy of the
/// user's database and `db_path` is an empty file the pool created afterwards with
/// `create_if_missing`. Consuming `.pre-import` in the second case destroys the library for good.
pub(super) fn import_applying_marker_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".import-applying")
}

/// Writes the marker durably. `sync_all` matters here. The window this guards is a process that
/// dies moments later, so a marker still sitting in the OS write cache would be worthless.
/// `fsync_parent_dir` flushes the directory entry too. Without it a crash right after the create
/// can lose the entry on common Linux/Unix filesystems even though the bytes were fsynced, so the
/// marker the recovery in `apply_pending_database_import` reads would be absent on reboot.
pub(super) fn write_import_applying_marker(marker: &Path) -> AppResult<()> {
    crate::services::filesystem::write_file_durably(marker, b"import swap in progress\n")
        .map_err(|error| backup_error("failed to mark the import as in progress", error))
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
    // *columns* (a namesake schema from another app, a hand-edited file, a half-finished
    // migration), passes the check above, and if it is also stamped at this build's
    // SCHEMA_VERSION then `ensure_schema` treats it as current and repairs nothing. It would swap
    // in cleanly and then fail with "no such column" on the first query, after the previous
    // database had already been set aside. Spot-check the columns each table is actually queried
    // through so that lands here, as a refused import, instead.
    //
    // Deliberately a sample, not a schema diff. Enough to tell a kavynex database from a
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
    // absent. A look-alike or hand-built database that named the columns but omitted the
    // constraints. Three of those cannot be repaired after the swap and must land here as a refused
    // import. Without the (channel_id, file_path) unique index the insert_media upsert's
    // ON CONFLICT target has nothing to match, so every insert fails. Without the videos -> channels
    // ON DELETE CASCADE a channel delete leaves its videos orphaned. Without the
    // video_comments -> videos ON DELETE CASCADE a media delete (a bare DELETE FROM videos, see
    // library::cleanup) leaves that media's comment rows orphaned forever, with nothing in the
    // library diagnostics to reconcile them. Enabling PRAGMA foreign_keys cannot rescue any of
    // these (it only enforces constraints the DDL declares, it never adds one), so the shape has
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

    // A row whose foreign key names nothing (a media of a channel that is gone, a comment of a media
    // that is gone) passes everything above. Nothing in the app reconciles one afterwards, and the
    // first write that touches it fails the constraint.
    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(pool)
        .await
        .map_err(|error| backup_error("failed to inspect the selected database", error))?;

    if !violations.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::DatabaseImportInvalid,
            "the selected database has rows that point at media or channels it does not contain",
        ));
    }

    if count_unmanaged_stored_paths(pool).await? > 0 {
        return Err(AppError::from_code(
            AppErrorCode::DatabaseImportInvalid,
            "the selected database names files outside the library's own folders",
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

    // A row with no `title_normalized` is invisible to the library search (`LIKE` never matches a
    // NULL), while still sitting in the library, which is the kind of loss the user only notices
    // much later, looking for something they know they saved.
    //
    // The version gate is the whole point. Below v11 the column legitimately holds NULLs (or does
    // not exist), and importing such a database is fine because `ensure_schema` runs the v11
    // backfill right after the swap. At v11 or above it claims to be backfilled already, so
    // `ensure_schema` skips straight past it and the NULLs would survive untouched forever. The
    // trigger cannot catch this either. An import replaces the whole file, so no INSERT ever fires.
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

    // A database stamped at v17 or later claims `video_comments.original_text`, which the comment
    // list selects. `ensure_schema` skips the migration that adds it, so a look-alike without the
    // column would swap in and then fail every comment read.
    if user_version >= 17
        && !crate::services::db_schema::table_has_column(pool, "video_comments", "original_text")
            .await
            .map_err(|error| backup_error("failed to inspect the selected database", error))?
    {
        return Err(AppError::from_code(
            AppErrorCode::DatabaseImportInvalid,
            "the selected file is not a kavynex database",
        ));
    }

    // The same reasoning applies to v13's live-chat row invariant (`has_live_chat` set implies a
    // stored `live_chat_file_path`). It is a CHECK on a fresh table and a pair of triggers on an
    // upgraded one, but an import replaces the whole file, so no write ever fires and neither
    // enforces it against pre-existing rows. A database stamped at v13 or later claims to satisfy it
    // already, so `ensure_schema` skips the migration that would repair it. A violating row would
    // then sit in the library flagged as having a live chat with no file behind it. A state
    // `get_media_repository_stats` already tracks as an inconsistency. Refuse it here, exactly as
    // the `title_normalized` check above does for the sibling invariant from the same migration.
    //
    // Gate on the columns actually being present. Like `title_normalized` they are not in the
    // REQUIRED_COLUMNS spot-check, so a minimal look-alike stamped at a high version can reach here
    // without them, and querying a missing column would error the inspection rather than judge the
    // invariant.
    if user_version >= 13 {
        let has_flag =
            crate::services::db_schema::table_has_column(pool, "videos", "has_live_chat")
                .await
                .map_err(|error| backup_error("failed to inspect the selected database", error))?;
        let has_path =
            crate::services::db_schema::table_has_column(pool, "videos", "live_chat_file_path")
                .await
                .map_err(|error| backup_error("failed to inspect the selected database", error))?;

        if has_flag && has_path {
            let (flagged_without_path,): (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM videos WHERE has_live_chat <> 0 AND (live_chat_file_path IS NULL OR TRIM(live_chat_file_path) = '')",
            )
            .fetch_one(pool)
            .await
            .map_err(|error| backup_error("failed to inspect the selected database", error))?;

            if flagged_without_path > 0 {
                return Err(AppError::from_code(
                    AppErrorCode::DatabaseImportInvalid,
                    "the selected database has media flagged as having a live chat with no stored file, so that live chat could never be opened",
                ));
            }
        }
    }

    Ok(())
}

/// How many file paths stored in the database do not name a file inside one of the library's
/// managed folders.
///
/// Every path the app writes is relative and under `video/`, `audio/`, `thumbnails/` or
/// `live_chat/`, and the write boundaries refuse anything else. An imported file never went through
/// them. The backend contains such a path when it uses it, but the renderer builds image URLs from
/// the stored value, and an absolute `\\host\share\x.png` there makes Windows authenticate to that
/// host as soon as the channel list draws its avatars.
async fn count_unmanaged_stored_paths(pool: &SqlitePool) -> AppResult<usize> {
    // Each column is read only where the file has it. An older schema lacks some of them, and the
    // migrations add them after the swap.
    const PATH_COLUMNS: [(&str, &str, &str); 4] = [
        ("videos", "file_path", "SELECT file_path FROM videos"),
        (
            "videos",
            "thumbnail_path",
            "SELECT thumbnail_path FROM videos",
        ),
        (
            "videos",
            "live_chat_file_path",
            "SELECT live_chat_file_path FROM videos",
        ),
        (
            "channels",
            "avatar_path",
            "SELECT avatar_path FROM channels",
        ),
    ];

    let mut unmanaged = 0;

    for (table, column, query) in PATH_COLUMNS {
        if !crate::services::db_schema::table_has_column(pool, table, column).await? {
            continue;
        }

        let stored: Vec<(Option<String>,)> = sqlx::query_as(query)
            .fetch_all(pool)
            .await
            .map_err(|error| backup_error("failed to inspect the selected database", error))?;

        unmanaged += stored
            .iter()
            .filter_map(|(path,)| path.as_deref())
            .filter(|path| !path.trim().is_empty())
            .filter(|path| crate::utils::path::ensure_managed_library_relative_path(path).is_err())
            .count();
    }

    Ok(unmanaged)
}

/// The two settings that describe this machine rather than the library (where the library folder
/// is, and where the daily external mirror goes).
///
/// An imported database brings its own, written on whatever machine it came from. Taken as they
/// are, they would replace this machine's library folder with a path that may not exist here (every
/// media then reads as missing), and would skip the checks `set_app_settings` makes on that
/// path (an existing directory, not a drive root, not inside the config directory), although the
/// library guard trusts the stored value from then on.
///
/// The same goes for `load_remote_images`, which is not a folder but is this user's choice about
/// what the app may contact. A file from anywhere could otherwise turn on requests to Google's image
/// servers that the user never asked for. Empty means "leave the file's value", which is only what a
/// test or a database without the setting asks for.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MachinePaths {
    pub library_path: String,
    pub external_backup_dir: String,
    pub load_remote_images: String,
}

/// Reads the machine paths stored in a database file.
pub async fn read_machine_paths(db_file: &Path) -> AppResult<MachinePaths> {
    let pool = open(db_file).await?;
    let settings = get_app_settings_from_pool(&pool).await;
    pool.close().await;
    let settings = settings?;

    Ok(MachinePaths {
        library_path: settings.library_path.unwrap_or_default(),
        external_backup_dir: settings.external_backup_dir.unwrap_or_default(),
        load_remote_images: settings.load_remote_images.unwrap_or_default(),
    })
}

/// [`read_machine_paths`] without touching the file or its sidecars.
///
/// For a database about to be set aside as evidence. A normal open can checkpoint the write-ahead log
/// into the file, or delete it, on close, and the log is what holds the commits a damaged database
/// never checkpointed. Opened read-only and immutable, SQLite reads the main file alone and writes
/// nothing, so the settings can lag what the log holds, which for two folder paths is acceptable.
pub(super) async fn read_machine_paths_untouched(db_file: &Path) -> AppResult<MachinePaths> {
    let options = SqliteConnectOptions::new()
        .filename(db_file)
        .create_if_missing(false)
        .read_only(true)
        .immutable(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| backup_error("failed to read the database's settings", error))?;
    let settings = get_app_settings_from_pool(&pool).await;
    pool.close().await;
    let settings = settings?;

    Ok(MachinePaths {
        library_path: settings.library_path.unwrap_or_default(),
        external_backup_dir: settings.external_backup_dir.unwrap_or_default(),
        load_remote_images: settings.load_remote_images.unwrap_or_default(),
    })
}

/// Prepares the staged copy for the swap. Its triggers and views are replaced by the app's own (see
/// `db_schema::reset_triggers_and_views`), and then `paths`, when given, are written in, so the
/// database that is swapped in keeps this machine's folders.
///
/// The triggers go first because the settings write below is the first write the file sees, and a
/// trigger the file brought along would fire on it.
///
/// Opened in rollback-journal mode so the write leaves no `-wal` sidecar next to the staged file,
/// which only the `.db` itself is carried across from. The live pool switches it back to WAL when
/// it opens the database after the swap.
///
/// Only `key` and `value` are written, the two columns the import validation guarantees. The file
/// can be from an older schema that the migrations bring up to date only after the swap.
pub(super) async fn prepare_staged_database(
    db_file: &Path,
    paths: Option<&MachinePaths>,
) -> AppResult<()> {
    let options = SqliteConnectOptions::new()
        .filename(db_file)
        .create_if_missing(false)
        .journal_mode(SqliteJournalMode::Delete)
        .busy_timeout(std::time::Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))
        // The file came from outside (an import) or is about to replace the database (a restore).
        // Same open as `connect`. Its schema may not call functions with side effects, and a page
        // whose cells overrun it is damage rather than something to read past.
        .pragma("trusted_schema", "OFF")
        .pragma("cell_size_check", "ON");
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| backup_error("failed to open the staged import", error))?;

    let result = async {
        let mut tx = pool
            .begin()
            .await
            .map_err(|error| backup_error("failed to prepare the staged import", error))?;

        crate::services::db_schema::reset_triggers_and_views(&mut tx).await?;

        if let Some(paths) = paths {
            let remote_images = (!paths.load_remote_images.trim().is_empty())
                .then_some((LOAD_REMOTE_IMAGES_KEY, &paths.load_remote_images));

            for (key, value) in [
                (LIBRARY_PATH_KEY, &paths.library_path),
                (EXTERNAL_BACKUP_DIR_KEY, &paths.external_backup_dir),
            ]
            .into_iter()
            .chain(remote_images)
            {
                sqlx::query(
                    "INSERT INTO app_settings (key, value) VALUES (?, ?) \
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                )
                .bind(key)
                .bind(value)
                .execute(&mut *tx)
                .await
                .map_err(|error| {
                    backup_error(
                        "failed to write this machine's folders into the import",
                        error,
                    )
                })?;
            }
        }

        tx.commit()
            .await
            .map_err(|error| backup_error("failed to prepare the staged import", error))
    }
    .await;
    pool.close().await;

    result
}

/// Validates a user-provided database file and stages it for import. The swap is deferred to
/// the next startup (`apply_pending_database_import`) because the live connection pool is a
/// process-wide singleton that cannot be reopened in-process. Rejects a file that is not a
/// healthy database, is not a kavynex database, or was created by a newer app version.
///
/// `machine_paths`, when given, replaces the library and mirror folders the file names, so the
/// imported database keeps pointing at this machine's (see [`MachinePaths`]).
pub async fn stage_database_import(
    db_path: &Path,
    source_path: &Path,
    machine_paths: Option<&MachinePaths>,
) -> AppResult<()> {
    // Off the async runtime, since a source on a mapped drive that went away can stall the stat.
    let source_exists = {
        let source = source_path.to_path_buf();
        run_blocking(move || Ok(source.exists())).await?
    };

    if !source_exists {
        return Err(AppError::from_code(
            AppErrorCode::DatabaseImportInvalid,
            "the selected file does not exist",
        ));
    }

    // A file another program is holding is reported as that, rather than as not being a database.
    let pool = super::connect(source_path).await.map_err(|error| {
        if crate::services::database::sqlite_error_means_damage(&error) {
            AppError::from_code(
                AppErrorCode::DatabaseImportInvalid,
                "the selected file is not a valid database",
            )
        } else {
            super::database_unreadable_error(error.to_string())
        }
    })?;
    let validation = validate_import_source(&pool).await;

    if validation.is_ok() {
        // Fold any not-yet-checkpointed WAL frames of the source into its main database file
        // before it is copied below. The staging copy takes only the `.db` file, never the
        // source's `-wal`/`-shm` sidecars, so a source that is a raw copy of a *live* WAL-mode
        // database (as opposed to a `VACUUM INTO` export, which has no WAL) would otherwise
        // silently drop whatever committed writes still sat in its WAL. Best effort. A source
        // on read-only media cannot be checkpointed, but such a source was not being written
        // to either, so its `.db` is already self-contained.
        //
        // The pragma reports whether it actually finished, and that has to be read rather than
        // discarded. It answers `busy = 1` when another connection held a lock and frames were
        // left behind. Copying then produces a database quietly missing its most recent commits,
        // which is worse than refusing. The user would have no way to tell. `log` is the frames
        // still in the WAL afterwards, so `busy` alone is not the test, since a busy answer with an
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
            // case above refuses, so refuse here too rather than let the anomaly fall through.
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

    // Stage atomically. Copy to a temp name, then rename into the staged slot so a partial
    // copy is never picked up on the next startup.
    let staged = import_staged_path(db_path);
    let staging_tmp = sibling(db_path, ".import-staged.tmp");
    let _ = std::fs::remove_file(&staging_tmp);
    super::remove_stale_sidecars(&staging_tmp);
    // Full-file copy of the (possibly large) source database. Run it off the async runtime so a
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

    // Before the rename, so the staged slot only ever holds a database already in that state.
    if let Err(error) = prepare_staged_database(&staging_tmp, machine_paths).await {
        let _ = std::fs::remove_file(&staging_tmp);
        return Err(error);
    }

    // The flush, the rename (which retries a held file with sleeps on Windows) and the directory
    // flush on the blocking pool, like the copy above.
    run_blocking(move || {
        crate::services::filesystem::fsync_file(&staging_tmp)?;

        let _ = std::fs::remove_file(&staged);
        crate::services::filesystem::rename_retrying(&staging_tmp, &staged)
            .map_err(|error| backup_error("failed to stage database import", error))?;
        // Make the staged slot's directory entry durable, so a crash after this cannot lose the
        // rename and leave a `.import-staged.tmp` the next launch would ignore.
        crate::services::filesystem::fsync_parent_dir(&staged);

        Ok(())
    })
    .await
}

/// How many times the marker removal after a completed swap is attempted before giving up. A file
/// created a moment earlier is exactly what an antivirus or indexer is still holding open.
const MARKER_REMOVAL_ATTEMPTS: u32 = 5;

const MARKER_REMOVAL_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(200);

/// Removes the in-progress marker, retrying a held file, and says whether it is gone.
fn remove_import_applying_marker(marker: &Path) -> bool {
    for attempt in 1..=MARKER_REMOVAL_ATTEMPTS {
        match std::fs::remove_file(marker) {
            Ok(()) => return true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
            Err(error) if attempt == MARKER_REMOVAL_ATTEMPTS => {
                logger::error(
                    "db_backup",
                    format!(
                        "the import completed but its in-progress marker could not be removed: \
                         {error}. The next launch will read it as an interrupted import and set \
                         the current database aside as kavynex.db.displaced-*"
                    ),
                );
            }
            Err(_) => std::thread::sleep(MARKER_REMOVAL_RETRY_DELAY),
        }
    }

    false
}

/// Moves whatever sits at `db_path` to a `.displaced-<suffix>` sibling, its write-ahead log with it,
/// and returns where it went. `None` when there was nothing there.
///
/// The recovery paths below act on the marker's claim that `db_path` is the empty file the pool
/// created after a failed swap. That claim is also what a marker whose removal failed after a
/// completed import makes, and there `db_path` is the imported database with however much use it
/// has had since. Setting the file aside instead of deleting it keeps the claim from destroying
/// anything when it is wrong.
fn displace_database(db_path: &Path) -> AppResult<Option<PathBuf>> {
    if !db_path.exists() {
        set_aside_orphaned_wal(db_path)?;
        return Ok(None);
    }

    let displaced = sibling(
        db_path,
        &format!(".displaced-{}", crate::utils::naming::unique_temp_suffix()),
    );

    crate::services::filesystem::rename_retrying(db_path, &displaced).map_err(|error| {
        backup_error(
            "failed to set aside the database found at the database path",
            error,
        )
    })?;

    // The log goes with the file it belongs to, under the name SQLite looks for beside it, so the
    // displaced copy opens with every committed transaction. One that cannot be moved stops the
    // recovery. Left under the live name, it would be replayed into the database renamed in next,
    // since SQLite checks frames against the log's own header and not against the file. The import
    // then stays pending and is tried again on the next launch. The shared-memory index is rebuilt on
    // open and is only dropped.
    let live_wal = sibling(db_path, "-wal");

    if live_wal.exists() {
        crate::services::filesystem::rename_retrying(&live_wal, &sibling(&displaced, "-wal")).map_err(|error| {
            backup_error(
                "failed to set aside the write-ahead log of the database found at the database path",
                error,
            )
        })?;
    }

    let _ = std::fs::remove_file(sibling(db_path, "-shm"));
    crate::services::startup_notices::record_database_displaced();

    logger::error(
        "db_backup",
        format!(
            "an interrupted import was recovered and the database found in its place was kept as {}",
            logger::redact_path(&displaced)
        ),
    );

    Ok(Some(displaced))
}

/// Moves a write-ahead log found under the live name with no database beside it to a
/// `.displaced-<suffix>-wal` sibling. It is what an earlier [`displace_database`] leaves when it set
/// the file aside and then failed to move the log. A database renamed in next would have it replayed
/// into it, since SQLite checks frames against the log's own header and not against the file.
fn set_aside_orphaned_wal(db_path: &Path) -> AppResult<()> {
    let live_wal = sibling(db_path, "-wal");

    if live_wal.exists() {
        let kept = sibling(
            db_path,
            &format!(
                ".displaced-{}-wal",
                crate::utils::naming::unique_temp_suffix()
            ),
        );

        crate::services::filesystem::rename_retrying(&live_wal, &kept).map_err(|error| {
            backup_error(
                "failed to set aside a write-ahead log left without its database",
                error,
            )
        })?;
    }

    let _ = std::fs::remove_file(sibling(db_path, "-shm"));
    Ok(())
}

/// Moves the write-ahead log of the database just renamed from `from` to `to` under the name SQLite
/// looks for beside `to`, so it opens there with every committed transaction, and drops the
/// shared-memory index, which is rebuilt on open. Nothing to do when there is no log. The previous
/// database's log is only ever non-empty after a run that did not exit cleanly, since the app
/// checkpoints it at exit.
fn move_wal_with(from: &Path, to: &Path) -> std::io::Result<()> {
    let _ = std::fs::remove_file(sibling(from, "-shm"));
    let wal = sibling(from, "-wal");

    if !wal.exists() {
        return Ok(());
    }

    crate::services::filesystem::rename_retrying(&wal, &sibling(to, "-wal"))
}

/// Restores a `.pre-import` snapshot that an interrupted import stranded as the only copy of the
/// database, when its staged file is gone so the normal swap can never consume it. Sets aside the
/// file the pool may have created at `db_path` on an earlier launch (see [`displace_database`]),
/// renames the snapshot back into place, makes it durable and clears the marker.
fn recover_stranded_pre_import(db_path: &Path, pre_import: &Path, marker: &Path) -> AppResult<()> {
    logger::warn(
        "db_backup",
        "an interrupted import left the pre-import snapshot as the only database copy and its staged \
         file is gone; restoring the snapshot rather than starting with an empty database",
    );

    displace_database(db_path)?;

    crate::services::filesystem::rename_retrying(pre_import, db_path).map_err(|error| {
        backup_error("failed to restore the stranded pre-import snapshot", error)
    })?;

    // `displace_database` already moved any log at the live name away, so this one cannot land on
    // another database's. A failure leaves it beside the `.pre-import` name, where nothing reads it.
    if let Err(error) = move_wal_with(pre_import, db_path) {
        logger::error(
            "db_backup",
            format!(
                "the restored pre-import snapshot's write-ahead log stayed at \
                 kavynex.db.pre-import-wal, so its last transactions are not in the database: {error}"
            ),
        );
    }

    crate::services::filesystem::fsync_parent_dir(db_path);
    super::record_database_swap(db_path);
    remove_import_applying_marker(marker);
    crate::services::filesystem::fsync_parent_dir(marker);

    Ok(())
}

/// Applies a database import staged by `stage_database_import`, if one is pending. Runs at
/// startup before the pool opens. The current database is moved aside to `.pre-import` (a
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
        // path below handles that when the staged file is still present. If the staged file was
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
    // with `create_if_missing`, never their data. Moving that empty file aside would overwrite
    // the real snapshot and lose the library permanently, with no undo left to offer, so the
    // move-aside is skipped and `.pre-import` is kept as this run's undo copy. The file at
    // `db_path` is set aside rather than overwritten, in case the marker is lying.
    //
    // The marker is what makes the two states distinguishable at all. `db_path` present plus a
    // `.pre-import` plus a staged import is also exactly what a perfectly normal *second* import
    // looks like, and that one does have to consume the old undo copy.
    //
    // Reading the marker this way is only sound because it is written *after* the move-aside
    // succeeds (see below), so its presence really does mean `.pre-import` holds the database.
    // `.pre-import` is required to actually be there on top of that. A marker with no snapshot
    // behind it cannot be describing a database this function set aside, so the claim it makes is
    // not true and acting on it would skip the move-aside while `db_path` is still the user's real
    // library. That combination is unreachable through the ordering below, which is exactly why it
    // must not be trusted when it does turn up. A rollback that put the database back but failed
    // to clear the marker leaves it, as would anything editing these files out of band.
    let recovering_from_a_failed_swap = marker.exists() && pre_import.exists();

    if recovering_from_a_failed_swap {
        logger::warn(
            "db_backup",
            "an earlier import died mid-swap: keeping the existing pre-import snapshot as the undo copy",
        );

        // Not discarded by the swap below. See displace_database for why.
        displace_database(db_path)?;
    } else if db_path.exists() {
        // Only consume the previous undo snapshot when this run is about to replace it in the
        // same step, so a crash can never leave the database file gone with `.pre-import` already
        // removed. (`resume_interrupted_restore` only covers `.restore.tmp`, not a staged import,
        // and the move-aside is a rename rather than a copy, so nothing else would put it back.)
        let _ = std::fs::remove_file(&pre_import);

        // The previous undo copy's log goes with it. Left behind, SQLite would replay it into the
        // database renamed in next, since it checks frames against the log's own header and not
        // against the file.
        let _ = std::fs::remove_file(sibling(&pre_import, "-wal"));
        let _ = std::fs::remove_file(sibling(&pre_import, "-shm"));

        crate::services::filesystem::rename_retrying(db_path, &pre_import)
            .map_err(|error| backup_error("failed to set aside the current database", error))?;

        // The log of a run that did not exit cleanly holds its last transactions, which belong in
        // the undo copy. One that cannot be moved puts the database back and leaves the import
        // pending, since the swap below drops whatever is left under the live name.
        if let Err(error) = move_wal_with(db_path, &pre_import) {
            if let Err(rollback_error) =
                crate::services::filesystem::rename_retrying(&pre_import, db_path)
            {
                logger::error(
                    "db_backup",
                    format!(
                        "database import rollback failed after its write-ahead log could not be moved; the previous database is preserved at the .pre-import snapshot beside kavynex.db and must be restored by hand: {rollback_error}"
                    ),
                );
            }

            return Err(backup_error(
                "failed to set aside the current database's write-ahead log",
                error,
            ));
        }

        // Durable only once `.pre-import` actually holds the user's database, which is the claim
        // the recovery branch above reads it as. Written *before* the move-aside it would also
        // cover the window where that rename had not run yet, and there `db_path` is still the
        // user's real database, not the pool's empty file, so a crash in that window left the next
        // run skipping the move-aside and letting the swap below overwrite the library with no
        // undo copy behind it.
        if let Err(error) = write_import_applying_marker(&marker) {
            // Nothing is in flight for a marker to describe. Put the database back so the next run
            // sees an ordinary pending import rather than a half-applied one.
            if let Err(rollback_error) =
                crate::services::filesystem::rename_retrying(&pre_import, db_path)
            {
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
            } else {
                let _ = move_wal_with(&pre_import, db_path);
            }

            return Err(error);
        }
    }

    let _ = std::fs::remove_file(sibling(db_path, "-wal"));
    let _ = std::fs::remove_file(sibling(db_path, "-shm"));

    if let Err(error) = crate::services::filesystem::rename_retrying(&staged, db_path) {
        // Roll the previous database back so the app is never left without one. When the rollback
        // succeeds the database is whole again and the marker has to go with it. When it fails,
        // the marker is exactly what tells the next run that `.pre-import` is the only real copy.
        if crate::services::filesystem::rename_retrying(&pre_import, db_path).is_ok() {
            let _ = move_wal_with(&pre_import, db_path);
            remove_import_applying_marker(&marker);
        }

        return Err(backup_error("failed to apply the imported database", error));
    }

    // The imported database is in place. Flush the directory entry so the swap is durable, then
    // clear the marker and flush again so its removal is durable too, before anything else is
    // written.
    //
    // The second flush is not optional. `.pre-import` is deliberately kept as the undo copy after a
    // successful import, so once the marker is gone the on-disk shape (a database at `db_path`, a
    // `.pre-import`, no staged file) is a normal completed import, but with the marker still
    // present it is exactly the shape the recovery branch above acts on to revert. A plain
    // `remove_file` leaves the unlink in the OS write cache, so a crash here could resurrect the
    // marker and send the next launch into that revert, undoing a completed import. The swap and
    // lineage records below are durable writes of their own, which is why they wait until the
    // marker is gone. A crash strictly between the rename and the second flush is the residual
    // non-atomic rename+unlink window, the same shape the rest of this module accepts.
    crate::services::filesystem::fsync_parent_dir(db_path);
    remove_import_applying_marker(&marker);
    crate::services::filesystem::fsync_parent_dir(&marker);

    super::record_database_swap(db_path);

    // An imported database is another library as far as the external copies can tell. Keeping the
    // id of the one it replaced would let the mirror rotate that library's copies out under the
    // imported one's. With a new id they are set aside instead. An import of a copy of this same
    // library sets them aside too, which keeps more than needed and loses nothing.
    super::lineage::record_new_lineage(db_path);

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
/// reuses the normal import path (the same validation and the same atomic, deferred swap in
/// `apply_pending_database_import`), so the live connection pool is never swapped underneath
/// while the app is running, whether the undo is triggered from Settings (pool open) or from
/// the startup recovery flow (pool closed). The caller relaunches the app afterward. Errors
/// when there is no snapshot to revert to.
pub async fn stage_database_import_undo(
    db_path: &Path,
    machine_paths: Option<&MachinePaths>,
) -> AppResult<()> {
    let pre_import = pre_import_path(db_path);

    if !pre_import.exists() {
        return Err(AppError::from_code(
            AppErrorCode::NoDatabaseImportToUndo,
            "there is no previous database to restore from the last import",
        ));
    }

    stage_database_import(db_path, &pre_import, machine_paths).await
}
