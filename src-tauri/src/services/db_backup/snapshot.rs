//! The automatic `.bak` snapshot family: taking one, rotating the generations, and reporting on
//! what is there.
//!
//! Split out of `mod.rs` alongside `restore.rs`, which was the largest file in the tree and held
//! three independent machines (this one, the restore, and the marker-driven import), plus every
//! test for all of them. What stayed behind is what more than one of them needs: the scratch pool,
//! the health check, the sibling-path helper, the generation rotation, and
//! `managed_database_paths`, which is the map of *every* file this module owns and therefore
//! belongs to none of the three.
//!
//! The tests stay in the parent's `mod tests` as well, matching how `integrity.rs`, `external.rs`
//! and `import.rs` were split before this: they share fixtures (`temp_dir`, `seed_db`,
//! `memory_pool`) and, more to the point, most of them exercise a snapshot and a restore
//! *together*, which is the behavior worth pinning and would have to be duplicated or arbitrarily
//! assigned if the tests were split along the same line as the code.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::services::logger;
use crate::AppResult;

use super::{
    backup_error, escape_sql_literal, is_healthy, is_recent, managed_database_paths, modified_ms,
    open, rotate_generations, sibling, total_size_bytes, BACKUP_IN_PROGRESS,
};

// The DB is snapshotted at most once per day so it does not add cost to every launch; any
// backup within this window already predates the current launch's migrations.
pub(super) const BACKUP_MIN_INTERVAL_SECS: u64 = 24 * 60 * 60;

// Keep several rotated generations of the snapshot (`.bak`, `.bak.1`, ...), not just one, so a
// corruption that goes unnoticed for a few days cannot overwrite every good snapshot with a
// degraded one before it is caught. This many *rotated* generations are kept in addition to the
// current `.bak`.
pub(super) const BACKUP_ROTATED_GENERATIONS: usize = 6;

pub(super) fn backup_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".bak")
}

/// The current snapshot is `.bak` (generation 0); older generations are `.bak.1` (newest
/// rotated) through `.bak.{BACKUP_ROTATED_GENERATIONS}` (oldest kept).
pub(super) fn generation_backup_path(db_path: &Path, generation: usize) -> PathBuf {
    if generation == 0 {
        backup_path(db_path)
    } else {
        sibling(db_path, &format!(".bak.{generation}"))
    }
}

/// Shifts the rotated backup generations up by one so a fresh snapshot can be promoted into
/// `.bak`: `.bak.{N}` is overwritten by `.bak.{N-1}`, down to `.bak` becoming `.bak.1`.
fn rotate_backups(db_path: &Path) {
    rotate_generations(db_path, BACKUP_ROTATED_GENERATIONS, generation_backup_path);
}

pub(super) fn temp_backup_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".bak.tmp")
}

/// Creates a consistent snapshot of the database (via `VACUUM INTO`) before migrations run,
/// so a bad migration or corruption can be rolled back. Best effort and throttled to once a
/// day; a source database that fails `quick_check` is skipped so a corrupt DB never
/// overwrites a good backup. Keeps several rotated generations (`.bak` plus `.bak.1`..
/// `.bak.{BACKUP_ROTATED_GENERATIONS}`). Returns true when a new snapshot was written.
pub async fn backup_database(db_path: &Path) -> AppResult<bool> {
    if !db_path.exists() {
        return Ok(false);
    }

    // Wait for any in-flight backup rather than skipping: once it releases the lock it has already
    // refreshed `.bak`, so the is_recent() check below then sees it and this caller returns early
    // without a redundant second vacuum. Waiting (not try_lock) is what makes that de-dup work.
    let _guard = BACKUP_IN_PROGRESS.lock().await;

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
    let vacuum_result = sqlx::query(sqlx::AssertSqlSafe(vacuum_sql))
        .execute(&pool)
        .await;
    pool.close().await;
    vacuum_result.map_err(|error| backup_error("failed to snapshot database", error))?;

    // Shift the existing generations up, then promote the fresh snapshot into `.bak`.
    rotate_backups(db_path);

    // Rotation has already moved the previous `.bak` to `.bak.1`, so a failure here leaves
    // generation 0 absent until the next successful backup. A restore still succeeds (the
    // candidate list falls through to `.bak.1` and beyond), but the newest snapshot silently
    // did not land, which is only inferable from backup timestamps. Log it before propagating
    // so the state is observable.
    if let Err(error) = std::fs::rename(&temp, &backup) {
        logger::warn(
            "db_backup",
            format!(
                "failed to promote the fresh snapshot after rotating generations; \
                 the newest backup slot is empty until the next run: {error}"
            ),
        );

        return Err(backup_error("failed to store database backup", error));
    }

    // Flush the directory entry so a crash right after the rename cannot lose it. The rotation
    // renames above live in the same directory, so this one flush covers the whole `.bak` family;
    // without it an unclean shutdown could silently revert to a rotated generation. Mirrors the
    // fsync the restore/import swaps already do (see resume_interrupted_restore / apply_pending_
    // database_import). Best effort, like those.
    crate::services::filesystem::fsync_parent_dir(&backup);

    Ok(true)
}

/// The existing backup files, most recent first. Rotation always writes the freshest snapshot
/// to `.bak` (generation 0), so it precedes the rotated `.bak.1`.. `.bak.N` generations.
///
/// `.bak.tmp` is included last. `backup_database` snapshots into it and only renames it into
/// `.bak` once the `VACUUM INTO` succeeds, so a run that died in that window leaves a complete,
/// already-health-checked snapshot sitting there that nothing else would ever look at. It goes
/// last, not first, even though it is the freshest: a run that instead died *during* the vacuum
/// leaves a partial file under the same name, and there is no way to tell the two apart here.
/// Every caller re-runs `quick_check` on the candidate it picks, which is what makes offering
/// this safe. A torn file is rejected there, and a healthy one is only reached when no real
/// generation survived.
pub(super) fn backup_candidates(db_path: &Path) -> Vec<PathBuf> {
    (0..=BACKUP_ROTATED_GENERATIONS)
        .map(|generation| generation_backup_path(db_path, generation))
        .chain(std::iter::once(temp_backup_path(db_path)))
        .filter(|path| path.exists())
        .collect()
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct DatabaseBackupStatus {
    pub available: bool,
    /// Modification time of the backup that would be restored, in epoch milliseconds.
    #[ts(type = "number | null")]
    pub backed_up_at_ms: Option<u64>,
    /// Total bytes the database and every file this module keeps beside it currently occupy
    /// (see `managed_database_paths`). Annotated `number` because ts-rs emits `bigint` for
    /// `u64` by default, and this crosses IPC as a plain JSON number.
    #[ts(type = "number")]
    pub total_bytes: u64,
    /// [`total_bytes`](Self::total_bytes) rendered for display, using the same formatter as the
    /// library summary so the two sizes shown in Settings cannot disagree on units or rounding.
    pub formatted_total_size: String,
}

/// Reports whether a backup file exists (without verifying its integrity), when the most recent
/// one was written, and how much disk the database and its snapshots occupy in total.
///
/// The size is reported because nothing else in the app makes it visible. Up to eleven full copies
/// of the database can sit in the app config directory (seven `.bak` generations, three `.corrupt`
/// ones, one `.pre-import`), the rotation bounds how *many* exist but never how *large* they get,
/// and that directory is the roaming profile on Windows. A database that grows with every comment
/// backed up can therefore take gigabytes there with nothing saying so.
pub fn database_backup_status(db_path: &Path) -> DatabaseBackupStatus {
    let total_bytes = total_size_bytes(&managed_database_paths(db_path));
    // Resolved once: backup_candidates stats every generation, and the two fields below both read
    // the same newest one.
    let newest_backup = backup_candidates(db_path).into_iter().next();

    DatabaseBackupStatus {
        available: newest_backup.is_some(),
        backed_up_at_ms: newest_backup.as_deref().and_then(modified_ms),
        total_bytes,
        formatted_total_size: crate::utils::format::format_bytes(total_bytes),
    }
}
