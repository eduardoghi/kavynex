//! The user-triggered export and the once-a-day mirror of the database into a user-chosen external
//! directory (Settings > Database), so a disk failure that takes the app config directory does not
//! take every on-volume `.bak` snapshot with it.

use std::path::{Path, PathBuf};

use super::{
    backup_error, escape_sql_literal, is_healthy, is_recent, open, rotate_generations, sibling,
    BACKUP_MIN_INTERVAL_SECS,
};
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

    // The snapshot is confirmed good; only now is any previous export at dest_path replaced.
    // The caller's save dialog has already confirmed the overwrite.
    let _ = std::fs::remove_file(dest_path);
    std::fs::rename(&staging, dest_path).map_err(|error| {
        let _ = std::fs::remove_file(&staging);
        backup_error("failed to finalize database export", error)
    })?;

    Ok(())
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

    if !external_dir.is_dir() {
        // The chosen directory is gone (drive unplugged, share offline). Not something to surface
        // on every background tick: skip and try again next time.
        return Ok(false);
    }

    let current = external_backup_path(external_dir);

    if is_recent(&current, BACKUP_MIN_INTERVAL_SECS) {
        return Ok(false);
    }

    // Export to a fresh staging file inside the external directory first, so a failed export (a
    // drive pulled mid-write) never disturbs the mirror generations already there. Only once the
    // fresh copy is complete are the older generations rotated up and it is promoted into
    // generation 0. This is stricter than backup_database's rotate-then-write, on purpose: an
    // external/removable target fails far more often than the app's own config volume.
    let staged = external_dir.join(format!("{EXTERNAL_BACKUP_FILE_NAME}.new"));
    let _ = std::fs::remove_file(&staged);

    export_database(db_path, &staged).await?;

    rotate_generations(
        external_dir,
        EXTERNAL_BACKUP_ROTATED_GENERATIONS,
        generation_external_backup_path,
    );

    if let Err(error) = std::fs::rename(&staged, &current) {
        let _ = std::fs::remove_file(&staged);
        return Err(backup_error(
            "failed to promote the external database backup",
            error,
        ));
    }

    Ok(true)
}
