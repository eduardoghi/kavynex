//! Importing a user-selected database file: validating it is a healthy kavynex database, staging
//! it atomically, and swapping it in on the next startup (the live connection pool is a
//! process-wide singleton that cannot be reopened in-process, so the actual swap is deferred).
//! The undo path reuses the same machinery to revert the last import.
//!
//! Tests for everything here live in the parent module's `mod tests`, alongside the backup and
//! restore tests they share helpers with; the internals those tests reach are `pub(super)`.

use std::path::{Path, PathBuf};

use sqlx::sqlite::SqlitePool;

use super::{backup_error, is_healthy, open, sibling};
use crate::services::logger;
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

pub(super) fn import_staged_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".import-staged")
}

pub(super) fn pre_import_path(db_path: &Path) -> PathBuf {
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
pub(super) fn import_applying_marker_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".import-applying")
}

/// Writes the marker durably. `sync_all` matters here: the window this guards is a process that
/// dies moments later, so a marker still sitting in the OS write cache would be worthless.
/// `fsync_parent_dir` flushes the directory entry too: without it a crash right after the create
/// can lose the entry on common Linux/Unix filesystems even though the bytes were fsynced, so the
/// marker the recovery in `apply_pending_database_import` reads would be absent on reboot.
pub(super) fn write_import_applying_marker(marker: &Path) -> AppResult<()> {
    use std::io::Write;

    let mut file = std::fs::File::create(marker)
        .map_err(|error| backup_error("failed to mark the import as in progress", error))?;
    file.write_all(b"import swap in progress\n")
        .and_then(|_| file.sync_all())
        .map_err(|error| backup_error("failed to mark the import as in progress", error))?;
    crate::services::filesystem::fsync_parent_dir(marker);
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
