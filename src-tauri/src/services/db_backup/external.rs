//! The user-triggered export and the once-a-day mirror of the database into a user-chosen external
//! directory (Settings > Database), so a disk failure that takes the app config directory does not
//! take every on-volume `.bak` snapshot with it.
//!
//! Tests live in the parent module's `mod tests`, which reaches the test-only internals here
//! (`external_backup_path`, `generation_external_backup_path`, `EXTERNAL_BACKUP_FILE_NAME`,
//! `EXTERNAL_BACKUP_ROTATED_GENERATIONS`) through the parent's `#[cfg(test)] use`.

use std::path::{Path, PathBuf};

// The throttle interval comes from `snapshot` rather than being re-declared here, deliberately.
// The mirror is throttled to the same once-a-day window as the local `.bak` snapshot, and two
// constants would let that pair drift silently.
use super::snapshot::BACKUP_MIN_INTERVAL_SECS;
use super::{
    backup_error, database_unreadable_error, escape_sql_literal, is_recent, open, pool_quick_check,
    rotate_generations, sibling, QuickCheck,
};
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

/// The current external mirror is generation 0 (`kavynex-backup.db`); `pub(super)` so the parent
/// module's mirror tests can name the generations.
pub(crate) const EXTERNAL_BACKUP_FILE_NAME: &str = "kavynex-backup.db";
pub(super) const EXTERNAL_BACKUP_ROTATED_GENERATIONS: usize = 2;

/// Whether the external mirror is set up, reachable and recent, for Settings to show. The mirror is
/// the one copy that outlives the disk the database is on, and when its folder went away (a drive
/// unplugged, a share offline, a drive letter reassigned) the daily copy stopped with nothing saying
/// so.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct ExternalBackupStatus {
    pub configured: bool,
    /// The folder is there as a directory right now.
    pub reachable: bool,
    /// When the current mirror was written, in epoch milliseconds. `None` before the first copy, or
    /// when the folder cannot be reached.
    #[ts(type = "number | null")]
    pub mirrored_at_ms: Option<u64>,
}

/// Reads [`ExternalBackupStatus`] for the configured folder `external_dir` (empty when the mirror is
/// off). Blocking, since the folder can be a stalled network share.
pub fn external_backup_status(external_dir: &str) -> ExternalBackupStatus {
    let external_dir = external_dir.trim();

    if external_dir.is_empty() {
        return ExternalBackupStatus::default();
    }

    let dir = Path::new(external_dir);

    if !dir.is_dir() {
        return ExternalBackupStatus {
            configured: true,
            reachable: false,
            mirrored_at_ms: None,
        };
    }

    ExternalBackupStatus {
        configured: true,
        reachable: true,
        mirrored_at_ms: super::modified_ms(&external_backup_path(dir)),
    }
}

/// Exports a consistent, self-contained snapshot of the database to a user-chosen path via
/// `VACUUM INTO` (WAL-safe. The snapshot is always fully checkpointed, never combined with a
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

    match pool_quick_check(&pool).await {
        QuickCheck::Healthy => {}
        QuickCheck::Damaged => {
            pool.close().await;
            return Err(AppError::from_code(
                AppErrorCode::AppError,
                "cannot export a database that fails an integrity check",
            ));
        }
        // A lock is not damage, and the message must not send the user to restore a backup.
        QuickCheck::Unreadable(detail) => {
            pool.close().await;
            return Err(database_unreadable_error(detail));
        }
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
        // SQLite does not sync a VACUUM INTO target, and a removable or network destination is where
        // a write cut short is likeliest. Synced first, so the export that replaces the previous one
        // is whole. It is also what lets the external mirror adopt a leftover `.new` without
        // checking it again (mirror_database_to_external_dir).
        if let Err(error) = crate::services::filesystem::fsync_file(&staging_final) {
            let _ = std::fs::remove_file(&staging_final);
            return Err(error);
        }

        // rename overwrites an existing target atomically on both Windows and Unix, so the previous
        // export is never pre-deleted. A rename that then fails (a locked file, an AV/indexer hold, a
        // removable/network destination going away) must not leave the user with neither the old
        // export nor the new one. This matches rotate_generations, which relies on the same overwrite.
        crate::services::filesystem::rename_retrying(&staging_final, &dest).map_err(|error| {
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

/// The file beside the mirror's copies naming the database they were made from (see `lineage`).
pub(super) fn external_lineage_path(dir: &Path) -> PathBuf {
    dir.join("kavynex-backup.lineage")
}

/// The existing mirror generations in `dir`, newest first.
fn existing_external_generations(dir: &Path) -> Vec<PathBuf> {
    (0..=EXTERNAL_BACKUP_ROTATED_GENERATIONS)
        .map(|generation| generation_external_backup_path(dir, generation))
        .filter(|path| path.exists())
        .collect()
}

/// Renames every mirror generation in `dir` to `kavynex-backup-previous-<UTC time>[-N].db`, and its
/// lineage file with them, so the mirror of a new database starts beside them instead of rotating
/// them out. The `.db` extension is what lets Settings > Database > Import read one directly.
/// Returns how many copies were set aside.
fn set_aside_external_generations(dir: &Path) -> AppResult<usize> {
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let mut moved = 0;

    for (generation, path) in (0..=EXTERNAL_BACKUP_ROTATED_GENERATIONS)
        .map(|generation| (generation, generation_external_backup_path(dir, generation)))
    {
        if !path.exists() {
            continue;
        }

        let name = if generation == 0 {
            format!("kavynex-backup-previous-{stamp}.db")
        } else {
            format!("kavynex-backup-previous-{stamp}-{generation}.db")
        };

        crate::services::filesystem::rename_retrying(&path, &dir.join(name)).map_err(|error| {
            backup_error(
                "failed to set aside the external copies of an earlier database",
                error,
            )
        })?;
        moved += 1;
    }

    let lineage = external_lineage_path(dir);

    if lineage.exists() {
        let _ = crate::services::filesystem::rename_retrying(
            &lineage,
            &dir.join(format!("kavynex-backup-previous-{stamp}.lineage")),
        );
    }

    crate::services::filesystem::fsync_parent_dir(&external_backup_path(dir));

    Ok(moved)
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
/// The directory must already exist. An external drive that is currently unplugged (or a network
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
    // be an unplugged drive or an offline share, exactly the IO that can stall for seconds. Run
    // them (and the rotate and promote below) off the async runtime so a slow target never holds
    // a Tokio worker thread.
    {
        let external_dir = external_dir.to_path_buf();
        let current = current.clone();
        let staged = staged.clone();
        let should_skip = run_blocking(move || {
            if !external_dir.is_dir() {
                // The chosen directory is gone (drive unplugged, share offline). Skipped rather than
                // recreated, and logged, since Settings is the only other place that says so.
                crate::services::logger::warn(
                    "db_backup",
                    "external backup skipped: the chosen folder cannot be reached",
                );
                return Ok::<bool, AppError>(true);
            }

            // A staged file with no promoted mirror beside it is the leftover of a failed
            // promotion below, and the rotation had already emptied generation 0 when it was
            // written, so it is the newest good copy, not scrap. Adopt it as the mirror before
            // consulting the throttle. Deleting it up front (as this function once did) combined
            // with a second failure of the same flaky target could leave the directory with no
            // current copy at all. A leftover next to an intact mirror needs no cleanup here.
            // export_database only ever replaces it atomically with a verified fresh export.
            if !current.exists() && staged.exists() {
                let _ = crate::services::filesystem::rename_retrying(&staged, &current);
            }

            // A fresh mirror was already written (or just adopted) within the throttle window.
            Ok::<bool, AppError>(is_recent(&current, BACKUP_MIN_INTERVAL_SECS))
        })
        .await?;

        if should_skip {
            return Ok(false);
        }
    }

    // The same two rules the daily snapshot keeps (see `snapshot::backup_database`). A database whose
    // last full check found damage is not copied over the copies taken before it, and an empty
    // database is not rotated over copies that hold a library. The second is what a database
    // recreated empty does in the three days the mirror keeps.
    if super::integrity::integrity_check_failed(db_path) {
        crate::services::logger::warn(
            "db_backup",
            "external backup skipped: the last full integrity check found damage, so the copies              taken before it are kept",
        );
        return Ok(false);
    }

    let database_lineage = super::lineage::database_lineage(db_path);
    let (copies_lineage, generations) = {
        let external_dir = external_dir.to_path_buf();
        run_blocking(move || {
            Ok::<_, AppError>((
                super::lineage::read_id(&external_lineage_path(&external_dir)),
                existing_external_generations(&external_dir),
            ))
        })
        .await?
    };

    // Copies a database before this one left there, because the app was reinstalled or started over
    // and pointed at the same folder. They may be the only copy of that library left, so they are set
    // aside rather than rotated out under this database's copies.
    if !generations.is_empty()
        && super::lineage::copies_are_from_another_database(
            database_lineage.as_deref(),
            copies_lineage.as_deref(),
        )
        && super::snapshot::any_holds_library(&generations).await
    {
        let external_dir = external_dir.to_path_buf();
        let moved = run_blocking(move || set_aside_external_generations(&external_dir)).await?;

        crate::services::logger::warn(
            "db_backup",
            format!(
                "set aside {moved} external backup(s) made from an earlier database as                  kavynex-backup-previous-*.db"
            ),
        );
    } else {
        let pool = open(db_path).await?;
        let holds = super::snapshot::holds_library(&pool).await;
        pool.close().await;

        if !holds && super::snapshot::any_holds_library(&generations).await {
            crate::services::logger::warn(
                "db_backup",
                "external backup skipped: the database is empty and the external copies are not",
            );
            return Ok(false);
        }
    }

    // Export to a fresh staging file inside the external directory first, so a failed export (a
    // drive pulled mid-write) never disturbs the mirror generations already there. Only once the
    // fresh copy is complete are the older generations rotated up and it is promoted into
    // generation 0. This is stricter than backup_database's rotate-then-write, on purpose. An
    // external/removable target fails far more often than the app's own config volume.
    export_database(db_path, &staged).await?;

    let external_dir = external_dir.to_path_buf();
    run_blocking(move || {
        rotate_generations(
            &external_dir,
            EXTERNAL_BACKUP_ROTATED_GENERATIONS,
            generation_external_backup_path,
        );

        if let Err(error) = crate::services::filesystem::rename_retrying(&staged, &current) {
            // Leave the freshly exported, quick-check-passed staged file in place rather than
            // deleting it. rotate_generations above already emptied generation 0, so discarding the
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

        // Labels the copies with the database they came from, so a later database can tell them
        // from its own. Best effort. Copies left unlabelled by a failure here read as another
        // database's and are set aside the next day, which keeps them rather than losing them.
        if let Some(lineage) = database_lineage.as_deref() {
            if let Err(error) = crate::services::filesystem::write_file_durably(
                &external_lineage_path(&external_dir),
                lineage.as_bytes(),
            ) {
                crate::services::logger::warn(
                    "db_backup",
                    format!("could not label the external backup with its database: {error}"),
                );
            }
        }

        // Flush the external directory entry so a crash (or a drive pulled) right after the rename
        // cannot lose the freshly promoted mirror. The very copy that exists to survive a failure
        // of the app's own volume. The rotation renames above share this directory, so one flush
        // covers them. Best effort, like the on-volume snapshot.
        crate::services::filesystem::fsync_parent_dir(&current);

        Ok(true)
    })
    .await
}
