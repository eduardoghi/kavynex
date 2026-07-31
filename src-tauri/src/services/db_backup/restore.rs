//! Restoring the database from a snapshot, and finishing a restore a crash interrupted.
//!
//! Split out of `mod.rs` alongside `snapshot.rs`; see that module's header for why the tests stay
//! in the parent and what stayed there with them.
//!
//! Two orderings here are load-bearing rather than incidental, and both are stated where they
//! happen: the chosen snapshot is staged and only then renamed into place, so a failure never
//! leaves the app with no database at all; and the corrupt database is moved under a scratch name
//! *before* the `.corrupt` generations are rotated, so a rename that fails cannot cost a generation
//! it has nothing to put back.

use std::path::{Path, PathBuf};

use crate::services::logger;
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

use super::snapshot::backup_candidates;
use super::{
    backup_error, database_quick_check_ok, database_schema_version, rotate_generations, sibling,
    BACKUP_IN_PROGRESS,
};

pub(super) const CORRUPT_ROTATED_GENERATIONS: usize = 2;

pub(super) fn corrupt_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".corrupt")
}

/// The database set aside by the most recent restore is `.corrupt` (generation 0); earlier ones
/// are `.corrupt.1` through `.corrupt.{CORRUPT_ROTATED_GENERATIONS}`.
pub(super) fn generation_corrupt_path(db_path: &Path, generation: usize) -> PathBuf {
    if generation == 0 {
        corrupt_path(db_path)
    } else {
        sibling(db_path, &format!(".corrupt.{generation}"))
    }
}

/// Shifts the corrupt snapshots up a generation so a second restore does not discard the
/// evidence from the first. Fewer generations are kept than for `.bak`: each one is a full copy
/// of a database that is already known to be broken, so this bounds the disk they can occupy
/// while still leaving repeated corruption diagnosable.
pub(super) fn rotate_corrupt_snapshots(db_path: &Path) {
    rotate_generations(
        db_path,
        CORRUPT_ROTATED_GENERATIONS,
        generation_corrupt_path,
    );
}

/// Where `restore_database_from_backup` stages the chosen snapshot before renaming it into place.
pub(super) fn restore_staging_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".restore.tmp")
}

/// Finishes a restore that was interrupted between moving the old database aside and renaming the
/// staged snapshot into place.
///
/// That window is only two renames wide, but if the process dies inside it the database file is
/// simply absent - and the pool opens with `create_if_missing(true)`, so the next launch would
/// create a fresh, empty one and present an empty library while the user's data sits untouched in
/// `.restore.tmp` (and `.corrupt`) right next to it. Nothing would say so: the app would look like
/// a first run. Recoverable by hand, but only by someone who knows to look.
///
/// Deliberately narrow: it acts only when the database is missing *and* a staging file is present,
/// which is exactly the interrupted state - a normal launch has a database and never reaches the
/// rename. Runs at startup before the pool can open, and before any pending import is applied, so
/// an import staged on top of a restore still sets the restored database aside as its undo
/// snapshot rather than nothing. Returns whether a restore was resumed.
pub fn resume_interrupted_restore(db_path: &Path) -> AppResult<bool> {
    let staged = restore_staging_path(db_path);

    if db_path.exists() || !staged.exists() {
        return Ok(false);
    }

    std::fs::rename(&staged, db_path)
        .map_err(|error| backup_error("failed to resume an interrupted restore", error))?;
    // Flush the directory entry so the swap survives a crash right after it; otherwise the next
    // launch could find the database missing again and re-run this from a staging file that the
    // rename appeared to consume.
    crate::services::filesystem::fsync_parent_dir(db_path);

    logger::warn(
        "db_backup",
        "resumed a restore that was interrupted before the database was renamed into place",
    );

    Ok(true)
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
    // Serialize against backup_database, which rotates and rewrites the same `.bak` family this
    // function reads. The periodic backup scheduler starts at launch, and a restore runs during that
    // same window (it is only reachable after the pool failed to open), so without sharing this lock
    // a rotation in flight could make a candidate vanish between backup_candidates' exists() filter
    // and the quick_check/copy on it - failing a recovery exactly when it matters most.
    let _guard = BACKUP_IN_PROGRESS.lock().await;

    let mut chosen: Option<PathBuf> = None;
    let mut skipped_newer_schema = false;

    for candidate in backup_candidates(db_path) {
        if !database_quick_check_ok(&candidate).await {
            continue;
        }

        // Refuse a backup whose schema is newer than this build supports: restoring it would only
        // "succeed" for `ensure_schema` to reject it on the next open (DatabaseSchemaTooNew),
        // leaving the app unable to start. Catching it here fails the restore itself with a clear
        // message. A backup written by this or an older build always passes.
        if let Some(version) = database_schema_version(&candidate).await {
            if version > crate::services::db_schema::SCHEMA_VERSION {
                skipped_newer_schema = true;
                continue;
            }
        }

        chosen = Some(candidate);
        break;
    }

    let backup = match chosen {
        Some(backup) => backup,
        None if skipped_newer_schema => {
            return Err(AppError::from_code_with_details(
                AppErrorCode::DatabaseSchemaTooNew,
                "the available database backup was created by a newer version of the app",
                "refused to restore a backup whose schema version is newer than this build supports",
            ));
        }
        None => {
            return Err(AppError::from_code(
                AppErrorCode::NoDatabaseBackupAvailable,
                "no healthy database backup is available to restore",
            ));
        }
    };

    // Stage the restored file first so the live database is never left missing on failure. The
    // copy is a full-file read/write of a possibly large database; run it off the async runtime so
    // a slow disk (a network share, a cloud-synced folder) never stalls a Tokio worker thread.
    let staged = restore_staging_path(db_path);
    let _ = std::fs::remove_file(&staged);
    {
        let copy_source = backup.clone();
        let copy_dest = staged.clone();
        run_blocking(move || {
            std::fs::copy(&copy_source, &copy_dest)
                .map_err(|error| backup_error("failed to stage restored database", error))?;
            // Flush the staged bytes to disk before the rename below. The rename is atomic against a
            // process crash, but without this a power loss could leave a truncated staged file that
            // the rename then makes the live database - and resume_interrupted_restore would finish
            // that rename on the next launch, trusting the staged file. This matches copy_file_atomic.
            crate::services::filesystem::fsync_file(&copy_dest)
        })
        .await?;
    }

    // Move the corrupt database aside and drop its sidecar WAL files. Rotate rather than
    // overwrite: a second restore (the restored database degraded again) would otherwise discard
    // the first failure's evidence, which is exactly the case where repeated corruption most
    // needs diagnosing.
    //
    // Move it under a scratch name *before* rotating. Rotating first would shift the existing
    // generations - dropping the oldest and emptying the `.corrupt` slot - and a rename that then
    // failed would leave that loss with nothing put in its place, so a couple of failed restores
    // would evict every earlier snapshot while adding none. Rotating only once the database is
    // safely out of the way keeps the generations intact on failure.
    if db_path.exists() {
        let pending = sibling(db_path, ".corrupt.tmp");
        let _ = std::fs::remove_file(&pending);

        if let Err(error) = std::fs::rename(db_path, &pending) {
            let _ = std::fs::remove_file(&staged);
            return Err(backup_error(
                "failed to move aside the corrupt database",
                error,
            ));
        }

        rotate_corrupt_snapshots(db_path);

        if let Err(error) = std::fs::rename(&pending, corrupt_path(db_path)) {
            // The database is already off the live path, so the restore can still proceed; the
            // evidence just keeps the scratch name. Say so rather than lose the thread.
            logger::warn(
                "db_backup",
                format!(
                    "the corrupt database was set aside as .corrupt.tmp because it could not be \
                     renamed into the .corrupt slot: {error}"
                ),
            );
        }
    }

    let _ = std::fs::remove_file(sibling(db_path, "-wal"));
    let _ = std::fs::remove_file(sibling(db_path, "-shm"));

    std::fs::rename(&staged, db_path)
        .map_err(|error| backup_error("failed to restore database from backup", error))?;
    // Flush the directory entry so the restored database is durably in place, not just staged.
    crate::services::filesystem::fsync_parent_dir(db_path);

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
