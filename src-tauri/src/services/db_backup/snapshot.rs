//! The automatic `.bak` snapshot family. Taking one, rotating the generations, and reporting on
//! what is there.
//!
//! Split out of `mod.rs` alongside `restore.rs`, which was the largest file in the tree and held
//! three independent machines (this one, the restore, and the marker-driven import), plus every
//! test for all of them. What stayed behind is what more than one of them needs. The scratch pool,
//! the health check, the sibling-path helper, the generation rotation, and
//! `managed_database_paths`, which is the map of *every* file this module owns and therefore
//! belongs to none of the three.
//!
//! The tests stay in the parent's `mod tests` as well, matching how `integrity.rs`, `external.rs`
//! and `import.rs` were split before this. They share fixtures (`temp_dir`, `seed_db`,
//! `memory_pool`) and, more to the point, most of them exercise a snapshot and a restore
//! *together*, which is the behavior worth pinning and would have to be duplicated or arbitrarily
//! assigned if the tests were split along the same line as the code.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::services::logger;
use crate::AppResult;

use super::{
    backup_error, database_schema_version, escape_sql_literal, is_healthy, is_recent,
    managed_database_paths, modified_ms, open, rotate_generations, sibling, total_size_bytes,
    BACKUP_IN_PROGRESS,
};

// The DB is snapshotted at most once per day so it does not add cost to every launch. Any
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

/// The current snapshot is `.bak` (generation 0), and older generations are `.bak.1` (newest
/// rotated) through `.bak.{BACKUP_ROTATED_GENERATIONS}` (oldest kept).
pub(super) fn generation_backup_path(db_path: &Path, generation: usize) -> PathBuf {
    if generation == 0 {
        backup_path(db_path)
    } else {
        sibling(db_path, &format!(".bak.{generation}"))
    }
}

/// Whether the database behind `pool` has any channel or media. A query that fails answers yes, so a
/// database the check cannot read is backed up as before rather than skipped.
pub(super) async fn holds_library(pool: &sqlx::SqlitePool) -> bool {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM channels) OR EXISTS(SELECT 1 FROM videos)",
    )
    .fetch_one(pool)
    .await
    .unwrap_or(true)
}

/// Whether any of the daily generations holds a library.
pub(super) async fn any_generation_holds_library(db_path: &Path) -> bool {
    let generations: Vec<PathBuf> = (0..=BACKUP_ROTATED_GENERATIONS)
        .map(|generation| generation_backup_path(db_path, generation))
        .collect();

    any_holds_library(&generations).await
}

/// Whether any of the snapshot files `paths` holds a channel or a media.
///
/// A file SQLite reports as damaged, or as not a database, counts as not holding one, since it is
/// not a copy worth keeping the rotation still for. A file that could not be read at all (another
/// program holding it) counts as holding one. Nothing is known about its contents, and the cost of
/// guessing wrong the other way is rotating out the snapshot that held the library.
pub(super) async fn any_holds_library(paths: &[PathBuf]) -> bool {
    for path in paths {
        if !path.exists() {
            continue;
        }

        let pool = match super::connect(path).await {
            Ok(pool) => pool,
            Err(error) => {
                if crate::services::database::sqlite_error_means_damage(&error) {
                    continue;
                }

                return true;
            }
        };

        let answer = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM channels) OR EXISTS(SELECT 1 FROM videos)",
        )
        .fetch_one(&pool)
        .await;
        pool.close().await;

        match answer {
            Ok(true) => return true,
            Ok(false) => {}
            Err(error) if crate::services::database::sqlite_error_means_damage(&error) => {}
            Err(_) => return true,
        }
    }

    false
}

/// Shifts the rotated backup generations up by one so a fresh snapshot can be promoted into
/// `.bak`. `.bak.{N}` is overwritten by `.bak.{N-1}`, down to `.bak` becoming `.bak.1`. Returns
/// whether `.bak` is free (see [`rotate_generations`]).
fn rotate_backups(db_path: &Path) -> bool {
    rotate_generations(db_path, BACKUP_ROTATED_GENERATIONS, generation_backup_path)
}

pub(super) fn temp_backup_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".bak.tmp")
}

/// A copy of a database whose last full check found damage, taken while the rotation is held still
/// for it (see [`backup_database`]). One file, replaced at most once a day.
pub(super) fn after_damage_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".after-damage")
}

pub(super) fn after_damage_temp_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".after-damage.tmp")
}

/// Copies a database the last full check found damaged into [`after_damage_path`], at most once a
/// day, and returns whether a copy was written.
///
/// The rotation stays still for such a database, so the generations from before the damage are not
/// pushed out by copies of it. Without this copy, whatever the user adds after the damage has no
/// backup at all until a check passes or the database is replaced. It is not a restore candidate,
/// since it is a copy of a database known to be damaged. `VACUUM INTO` rebuilds the indexes in it,
/// so damage limited to an index does not carry over.
async fn snapshot_after_damage(db_path: &Path, pool: &sqlx::SqlitePool) -> AppResult<bool> {
    let target = after_damage_path(db_path);

    if is_recent(&target, BACKUP_MIN_INTERVAL_SECS) {
        return Ok(false);
    }

    let temp = after_damage_temp_path(db_path);
    let _ = std::fs::remove_file(&temp);

    let vacuum_sql = format!(
        "VACUUM INTO '{}'",
        escape_sql_literal(&temp.to_string_lossy())
    );

    if let Err(error) = sqlx::query(sqlx::AssertSqlSafe(vacuum_sql))
        .execute(pool)
        .await
    {
        let _ = std::fs::remove_file(&temp);
        return Err(backup_error("failed to copy the damaged database", error));
    }

    crate::utils::task::run_blocking(move || {
        crate::services::filesystem::fsync_file(&temp)?;
        crate::services::filesystem::rename_retrying(&temp, &target)
            .map_err(|error| backup_error("failed to store the damaged database's copy", error))?;
        crate::services::filesystem::fsync_parent_dir(&target);
        Ok(true)
    })
    .await
}

/// How many pre-migration snapshots are kept. Each is a full copy, taken once per upgrade that
/// changes the schema, so this many cover the migration that just ran and one other.
pub(super) const PRE_MIGRATION_SNAPSHOTS_KEPT: usize = 2;

/// The snapshot taken right before a migration from `from_version` runs.
pub(super) fn pre_migration_path(db_path: &Path, from_version: i64) -> PathBuf {
    sibling(db_path, &format!(".pre-migration-v{from_version}"))
}

fn pre_migration_temp_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".pre-migration.tmp")
}

/// The versions whose pre-migration snapshots go, given the ones on disk and the one just written.
/// The one just written always stays, and the highest of the others fill the remaining `keep`
/// slots.
///
/// Keeping only the highest versions deleted the snapshot of a database older than the last two
/// upgrades (an imported export, a restored old backup) right after it was taken, so its migration
/// ran with no rollback point.
///
/// Pure so the retention can be pinned without a directory, because a wrong answer here deletes the
/// one copy taken before an upgrade.
pub(super) fn pre_migration_versions_to_prune(
    mut versions: Vec<i64>,
    just_written: i64,
    keep: usize,
) -> Vec<i64> {
    versions.retain(|version| *version != just_written);
    versions.sort_unstable_by(|left, right| right.cmp(left));
    versions.dedup();
    versions.into_iter().skip(keep.saturating_sub(1)).collect()
}

/// The schema versions of the pre-migration snapshots sitting beside `db_path`.
fn pre_migration_versions_on_disk(db_path: &Path) -> Vec<i64> {
    let (Some(dir), Some(name)) = (db_path.parent(), db_path.file_name()) else {
        return Vec::new();
    };
    let prefix = format!("{}.pre-migration-v", name.to_string_lossy());

    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    entries
        .flatten()
        .filter_map(|entry| {
            entry
                .file_name()
                .to_str()?
                .strip_prefix(&prefix)?
                .parse::<i64>()
                .ok()
        })
        .collect()
}

/// Snapshots the database right before a schema migration from `from_version` runs, and returns
/// where it went.
///
/// Separate from [`backup_database`] for two reasons. That one is throttled to a day, so before a
/// migration it often wrote nothing and the rollback point was a `.bak` up to a day old. And its
/// generations rotate daily, so within a week the last copy in the old schema was gone, which is
/// the copy a downgrade needs. This one always runs, and is never pruned by the snapshot it is
/// taken alongside. The caller has already run `quick_check` on the database, so it is not repeated here.
pub async fn snapshot_before_migration(db_path: &Path, from_version: i64) -> AppResult<PathBuf> {
    let _guard = BACKUP_IN_PROGRESS.lock().await;

    let target = pre_migration_path(db_path, from_version);
    let temp = pre_migration_temp_path(db_path);
    let _ = std::fs::remove_file(&temp);

    let pool = open(db_path).await?;
    let vacuum_sql = format!(
        "VACUUM INTO '{}'",
        escape_sql_literal(&temp.to_string_lossy())
    );
    let vacuum_result = sqlx::query(sqlx::AssertSqlSafe(vacuum_sql))
        .execute(&pool)
        .await;
    pool.close().await;

    if let Err(error) = vacuum_result {
        let _ = std::fs::remove_file(&temp);
        return Err(backup_error(
            "failed to snapshot the database before a migration",
            error,
        ));
    }

    // The flush, the rename (which retries a held file with sleeps on Windows) and the prune are
    // blocking filesystem work, so they run on the blocking pool like the daily snapshot's.
    {
        let db_path = db_path.to_path_buf();
        let target = target.clone();
        crate::utils::task::run_blocking(move || {
            crate::services::filesystem::fsync_file(&temp)?;
            crate::services::filesystem::rename_retrying(&temp, &target).map_err(|error| {
                backup_error("failed to store the pre-migration snapshot", error)
            })?;
            crate::services::filesystem::fsync_parent_dir(&target);

            for version in pre_migration_versions_to_prune(
                pre_migration_versions_on_disk(&db_path),
                from_version,
                PRE_MIGRATION_SNAPSHOTS_KEPT,
            ) {
                let _ = std::fs::remove_file(pre_migration_path(&db_path, version));
            }

            Ok(())
        })
        .await?;
    }

    logger::info(
        "db_backup",
        format!("snapshotted the database before migrating from schema version {from_version}"),
    );

    Ok(target)
}

/// Creates a consistent snapshot of the database (via `VACUUM INTO`) before migrations run,
/// so a bad migration or corruption can be rolled back. Best effort and throttled to once a
/// day. A source database that fails `quick_check` is skipped so a corrupt DB never
/// overwrites a good backup. Keeps several rotated generations (`.bak` plus `.bak.1`..
/// `.bak.{BACKUP_ROTATED_GENERATIONS}`). Returns true when a new snapshot was written.
pub async fn backup_database(db_path: &Path) -> AppResult<bool> {
    if !db_path.exists() {
        return Ok(false);
    }

    // Wait for any in-flight backup rather than skipping. Once it releases the lock it has already
    // refreshed `.bak`, so the is_recent() check below then sees it and this caller returns early
    // without a redundant second vacuum. Waiting (not try_lock) is what makes that de-dup work.
    let _guard = BACKUP_IN_PROGRESS.lock().await;

    let backup = backup_path(db_path);

    if is_recent(&backup, BACKUP_MIN_INTERVAL_SECS) {
        return Ok(false);
    }

    // A database newer than this build (a downgrade) is not snapshotted. This build cannot open it
    // and cannot restore a snapshot of it either, and rotating its copies in would push out, one a
    // day, the older generations that are the only ones this build can restore.
    if database_schema_version(db_path)
        .await
        .is_some_and(|version| version > crate::services::db_schema::SCHEMA_VERSION)
    {
        logger::warn(
            "db_backup",
            "skipping backup: the database was written by a newer version of Kavynex",
        );
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

    // A database whose last full check found damage is not rotated in until a check passes or it is
    // replaced. It passes `quick_check`, so without this each day would rotate out one generation
    // taken before the damage in favor of a copy of it. It still gets a daily copy of its own, outside
    // the rotation (see `snapshot_after_damage`).
    if super::integrity::integrity_check_failed(db_path) {
        let copied = snapshot_after_damage(db_path, &pool).await;
        pool.close().await;

        match copied {
            Ok(true) => logger::warn(
                "db_backup",
                "the last full integrity check found damage, so the snapshots from before it are \
                 kept and today's copy went to kavynex.db.after-damage",
            ),
            Ok(false) => {}
            Err(error) => logger::warn(
                "db_backup",
                format!("the damaged database could not be copied outside the rotation: {error}"),
            ),
        }

        return Ok(false);
    }

    // An empty database is never rotated over a snapshot that holds a library. Each daily run would
    // otherwise push out one good generation, and a week later none would be left. That is what a
    // database file recreated empty (a quarantine, a profile reset, starting over on purpose) does
    // to the backups. Once the new database holds something, backups resume as usual.
    if !holds_library(&pool).await && any_generation_holds_library(db_path).await {
        pool.close().await;
        logger::warn(
            "db_backup",
            "skipping backup: the database is empty and the latest snapshot is not",
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

    // The snapshot is checked before anything is rotated for it. Rotation drops the oldest
    // generation, which must not happen for a file that is not a sound copy.
    let snapshot_is_healthy = match open(&temp).await {
        Ok(snapshot) => {
            let healthy = is_healthy(&snapshot).await;
            snapshot.close().await;
            healthy
        }
        Err(_) => false,
    };

    if !snapshot_is_healthy {
        let _ = std::fs::remove_file(&temp);
        return Err(backup_error(
            "failed to snapshot database",
            "the snapshot failed quick_check, so the existing generations were kept",
        ));
    }

    // The flush, the rotation and the promotion are blocking filesystem work, and the flush of a
    // freshly vacuumed database can take seconds on a slow or scanned disk. Off the async runtime,
    // as the utils::task convention has it.
    let db_path = db_path.to_path_buf();

    crate::utils::task::run_blocking(move || {
        // On disk before anything is rotated. SQLite does not sync a VACUUM INTO target, and the
        // throttle reads `.bak`'s mtime, so a snapshot promoted and then cut short by a power loss
        // would read as a recent good backup and stop the next one from being taken for a day.
        crate::services::filesystem::fsync_file(&temp)?;

        // Shift the existing generations up, then promote the fresh snapshot into `.bak`. A rotation
        // that stopped short leaves the previous `.bak` in place, and promoting over it would discard
        // it. The fresh snapshot stays in `.bak.tmp` instead, already flushed and checked, where a
        // restore still finds it, and the next run tries the rotation again.
        if !rotate_backups(&db_path) {
            return Err(backup_error(
                "failed to rotate the database backups",
                "a backup generation could not be moved, so the newest snapshot was kept in .bak.tmp",
            ));
        }

        // Rotation has already moved the previous `.bak` to `.bak.1`, so a failure here leaves
        // generation 0 absent until the next successful backup. A restore still succeeds (the
        // candidate list falls through to `.bak.1` and beyond), but the newest snapshot silently
        // did not land, which is only inferable from backup timestamps. Log it before propagating
        // so the state is observable.
        if let Err(error) = crate::services::filesystem::rename_retrying(&temp, &backup) {
            logger::warn(
                "db_backup",
                format!(
                    "failed to promote the fresh snapshot after rotating generations. \
                     The newest backup slot is empty until the next run: {error}"
                ),
            );

            return Err(backup_error("failed to store database backup", error));
        }

        // Flush the directory entry so a crash right after the rename cannot lose it. The rotation
        // renames above live in the same directory, so this one flush covers the whole `.bak`
        // family. Without it an unclean shutdown could silently revert to a rotated generation.
        // Mirrors the fsync the restore/import swaps already do (see resume_interrupted_restore /
        // apply_pending_database_import). Best effort, like those.
        crate::services::filesystem::fsync_parent_dir(&backup);

        Ok(true)
    })
    .await
}

/// The folder, beside the database, that holds snapshots set aside when the user started over with an
/// empty database (see [`set_aside_backups_for_empty_start`]).
pub const SET_ASIDE_BACKUPS_DIR: &str = "set-aside-backups";

/// Moves every snapshot a restore could pick into `set-aside-backups/<UTC time>/` beside the database,
/// for a user who chose to start with an empty library rather than restore. Returns the folder, or
/// `None` when there was nothing to move.
///
/// Left where they were, the snapshots would be rotated out by the new database's own daily backup
/// one a day, once it holds anything, and nothing in the app could restore them after the new
/// database opened. Here they are kept for good, under names ending in `.db` so Settings > Database >
/// Import can read one directly.
pub fn set_aside_backups_for_empty_start(db_path: &Path) -> AppResult<Option<PathBuf>> {
    let candidates = backup_candidates(db_path);

    if candidates.is_empty() {
        return Ok(None);
    }

    let Some(parent) = db_path.parent() else {
        return Ok(None);
    };

    let folder = parent
        .join(SET_ASIDE_BACKUPS_DIR)
        .join(chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string());
    std::fs::create_dir_all(&folder)
        .map_err(|error| backup_error("failed to create the folder for the old backups", error))?;

    let prefix = db_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "kavynex.db".to_string());

    for candidate in candidates {
        let suffix = candidate
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .and_then(|name| name.strip_prefix(&prefix).map(str::to_string))
            .unwrap_or_default();

        // `.bak` -> `kavynex-bak.db`, `.bak.3` -> `kavynex-bak-3.db`, `.pre-migration-v15` ->
        // `kavynex-pre-migration-v15.db`.
        let label = suffix.trim_start_matches('.').replace('.', "-");
        let target = folder.join(format!("kavynex-{label}.db"));

        crate::services::filesystem::rename_retrying(&candidate, &target)
            .map_err(|error| backup_error("failed to set aside an old backup", error))?;
        // Both directories changed. The one the file left and the one it arrived in.
        crate::services::filesystem::fsync_parent_dir(&target);
    }

    crate::services::filesystem::fsync_parent_dir(db_path);

    logger::warn(
        "db_backup",
        format!(
            "started with an empty database and kept the old backups in {}",
            logger::redact_path(&folder)
        ),
    );

    Ok(Some(folder))
}

/// Whether any snapshot a restore could pick is on disk next to `db_path`.
pub fn has_backup_candidates(db_path: &Path) -> bool {
    !backup_candidates(db_path).is_empty()
}

/// The existing backup files, most recent first. Rotation always writes the freshest snapshot
/// to `.bak` (generation 0), so it precedes the rotated `.bak.1`.. `.bak.N` generations.
///
/// `.bak.tmp` is included last. `backup_database` snapshots into it and only renames it into
/// `.bak` once the `VACUUM INTO` succeeds, so a run that died in that window leaves a complete,
/// already-health-checked snapshot sitting there that nothing else would ever look at. It goes
/// last, not first, even though it is the freshest. A run that instead died *during* the vacuum
/// leaves a partial file under the same name, and there is no way to tell the two apart here.
/// Every caller re-runs `quick_check` on the candidate it picks, which is what makes offering
/// this safe. A torn file is rejected there, and a healthy one is only reached when no real
/// generation survived.
///
/// The pre-migration snapshots come after the daily generations, newest version first. Each is the
/// database as it was just before an upgrade, an older schema the migrations bring forward again
/// after a restore. They were never offered, so a library whose daily backups were all damaged
/// had healthy copies beside it that the restore did not look at.
pub(super) fn backup_candidates(db_path: &Path) -> Vec<PathBuf> {
    let mut pre_migration_versions = pre_migration_versions_on_disk(db_path);
    pre_migration_versions.sort_unstable_by(|left, right| right.cmp(left));

    (0..=BACKUP_ROTATED_GENERATIONS)
        .map(|generation| generation_backup_path(db_path, generation))
        .chain(
            pre_migration_versions
                .into_iter()
                .map(|version| pre_migration_path(db_path, version)),
        )
        .chain(std::iter::once(temp_backup_path(db_path)))
        .filter(|path| path.exists())
        .collect()
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct DatabaseBackupStatus {
    pub available: bool,
    /// Modification time of the backup that would be restored, in epoch milliseconds.
    #[cfg_attr(test, ts(type = "number | null"))]
    pub backed_up_at_ms: Option<u64>,
    /// Total bytes the database and every file this module keeps beside it currently occupy
    /// (see `managed_database_paths`). Annotated `number` because ts-rs emits `bigint` for
    /// `u64` by default, and this crosses IPC as a plain JSON number.
    #[cfg_attr(test, ts(type = "number"))]
    pub total_bytes: u64,
    /// [`total_bytes`](Self::total_bytes) rendered for display, using the same formatter as the
    /// library summary so the two sizes shown in Settings cannot disagree on units or rounding.
    pub formatted_total_size: String,
}

/// Reports whether a backup file exists (without verifying its integrity), when the most recent
/// one was written, and how much disk the database and its snapshots occupy in total.
///
/// The size is reported because nothing else in the app makes it visible. Up to thirteen full copies
/// of the database can sit in the app config directory (seven `.bak` generations, three `.corrupt`
/// ones, one `.pre-import`, two `.pre-migration-v<N>`), the rotation bounds how *many* exist but
/// never how *large* they get,
/// and that directory is the roaming profile on Windows. A database that grows with every comment
/// backed up can therefore take gigabytes there with nothing saying so.
pub fn database_backup_status(db_path: &Path) -> DatabaseBackupStatus {
    let total_bytes = total_size_bytes(&managed_database_paths(db_path));
    // Resolved once. backup_candidates stats every generation, and the two fields below both read
    // the same newest one.
    let newest_backup = backup_candidates(db_path).into_iter().next();

    DatabaseBackupStatus {
        available: newest_backup.is_some(),
        backed_up_at_ms: newest_backup.as_deref().and_then(modified_ms),
        total_bytes,
        formatted_total_size: crate::utils::format::format_bytes(total_bytes),
    }
}
