//! The user-triggered export and the once-a-day mirror of the database into a user-chosen external
//! directory (Settings > Database), so a disk failure that takes the app config directory does not
//! take every on-volume `.bak` snapshot with it.

use std::path::{Path, PathBuf};

use super::{
    backup_error, escape_sql_literal, is_healthy, is_recent, open, rotate_generations, sibling,
    BACKUP_MIN_INTERVAL_SECS,
};
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

/// The current external mirror is generation 0 (`kavynex-backup.db`); `pub(super)` so the parent
/// module's mirror tests can name the generations.
pub(super) const EXTERNAL_BACKUP_FILE_NAME: &str = "kavynex-backup.db";
pub(super) const EXTERNAL_BACKUP_ROTATED_GENERATIONS: usize = 2;

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

    // The snapshot is confirmed good; only now is any previous export at dest_path replaced. These
    // are filesystem calls on a possibly slow/removable/network destination, so run them off the
    // async runtime, consistent with the rest of the app's blocking IO. The caller's save dialog
    // has already confirmed the overwrite.
    let staging_final = staging.clone();
    let dest = dest_path.to_path_buf();
    run_blocking(move || {
        // rename overwrites an existing target atomically on both Windows and Unix, so the previous
        // export is never pre-deleted: a rename that then fails (a locked file, an AV/indexer hold, a
        // removable/network destination going away) must not leave the user with neither the old
        // export nor the new one. This matches rotate_generations, which relies on the same overwrite.
        std::fs::rename(&staging_final, &dest).map_err(|error| {
            let _ = std::fs::remove_file(&staging_final);
            backup_error("failed to finalize database export", error)
        })?;

        // Flush the directory entry so a crash right after the rename cannot leave the promoted
        // export unwritten, silently reverting to no file (or an older one) at the destination.
        // Best effort, mirroring the db-backup swaps.
        crate::services::filesystem::fsync_parent_dir(&dest);
        Ok(())
    })
    .await
}

pub(super) fn external_backup_path(dir: &Path) -> PathBuf {
    dir.join(EXTERNAL_BACKUP_FILE_NAME)
}

/// The current external mirror is generation 0 (`kavynex-backup.db`); older ones are
/// `kavynex-backup.db.1`..`kavynex-backup.db.{EXTERNAL_BACKUP_ROTATED_GENERATIONS}`. `pub(super)`
/// so the parent module's rotation test can reach it.
pub(super) fn generation_external_backup_path(dir: &Path, generation: usize) -> PathBuf {
    if generation == 0 {
        external_backup_path(dir)
    } else {
        dir.join(format!("{EXTERNAL_BACKUP_FILE_NAME}.{generation}"))
    }
}

/// Mirrors the database into a user-chosen external backup directory (Settings > Database) so a
/// disk failure that takes the app config directory does not also take every snapshot with it.
/// Best effort and throttled to once a day, exactly like the on-volume `.bak` snapshot; only the
/// database is copied (the media files are far larger and live under the library directory, which
/// the user backs up separately). Returns true when a fresh mirror was written.
///
/// The directory must already exist: an external drive that is currently unplugged (or a network
/// share that is offline) is skipped quietly rather than recreated, since a recreated folder at a
/// path that now resolves to a different device would silently write the backup to the wrong
/// place. `export_database` refuses a source that fails its integrity check, so a corrupt database
/// never overwrites a good external mirror.
pub async fn mirror_database_to_external_dir(
    db_path: &Path,
    external_dir: &Path,
) -> AppResult<bool> {
    if !db_path.exists() {
        return Ok(false);
    }

    let current = external_backup_path(external_dir);
    let staged = external_dir.join(format!("{EXTERNAL_BACKUP_FILE_NAME}.new"));

    // The directory probe and the throttle's mtime read both touch the external target, which may
    // be an unplugged drive or an offline share - exactly the IO that can stall for seconds. Run
    // them (and the rotate and promote below) off the async runtime so a slow target never holds
    // a Tokio worker thread.
    {
        let external_dir = external_dir.to_path_buf();
        let current = current.clone();
        let staged = staged.clone();
        let should_skip = run_blocking(move || {
            if !external_dir.is_dir() {
                // The chosen directory is gone (drive unplugged, share offline); skip quietly.
                return Ok::<bool, AppError>(true);
            }

            // A staged file with no promoted mirror beside it is the leftover of a failed
            // promotion below, and the rotation had already emptied generation 0 when it was
            // written - so it is the newest good copy, not scrap. Adopt it as the mirror before
            // consulting the throttle: deleting it up front (as this function once did) combined
            // with a second failure of the same flaky target could leave the directory with no
            // current copy at all. A leftover next to an intact mirror needs no cleanup here -
            // export_database only ever replaces it atomically with a verified fresh export.
            if !current.exists() && staged.exists() {
                let _ = std::fs::rename(&staged, &current);
            }

            // A fresh mirror was already written (or just adopted) within the throttle window.
            Ok::<bool, AppError>(is_recent(&current, BACKUP_MIN_INTERVAL_SECS))
        })
        .await?;

        if should_skip {
            return Ok(false);
        }
    }

    // Export to a fresh staging file inside the external directory first, so a failed export (a
    // drive pulled mid-write) never disturbs the mirror generations already there. Only once the
    // fresh copy is complete are the older generations rotated up and it is promoted into
    // generation 0. This is stricter than backup_database's rotate-then-write, on purpose: an
    // external/removable target fails far more often than the app's own config volume.
    export_database(db_path, &staged).await?;

    let external_dir = external_dir.to_path_buf();
    run_blocking(move || {
        rotate_generations(
            &external_dir,
            EXTERNAL_BACKUP_ROTATED_GENERATIONS,
            generation_external_backup_path,
        );

        if let Err(error) = std::fs::rename(&staged, &current) {
            // Leave the freshly exported, quick-check-passed staged file in place rather than
            // deleting it: rotate_generations above already emptied generation 0, so discarding the
            // replacement here would throw away the newest good copy on a failure of the exact
            // (removable/network) target this module is meant to be careful with. Nothing on the
            // restore path reads this file automatically (unlike backup_database's `.bak.tmp`,
            // which is a last-resort restore candidate); instead, the next mirror run adopts it
            // as the current mirror while the directory is still missing one.
            return Err(backup_error(
                "failed to promote the external database backup (the fresh copy was kept)",
                error,
            ));
        }

        // Flush the external directory entry so a crash (or a drive pulled) right after the rename
        // cannot lose the freshly promoted mirror - the very copy that exists to survive a failure
        // of the app's own volume. The rotation renames above share this directory, so one flush
        // covers them. Best effort, like the on-volume snapshot.
        crate::services::filesystem::fsync_parent_dir(&current);

        Ok(true)
    })
    .await
}
