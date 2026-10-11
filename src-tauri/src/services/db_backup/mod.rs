//! Backup, restore, export, import. Everything this app does with the database *file* rather than
//! with its rows.
//!
//! What lives here is the machinery more than one of those needs, and nothing else. Each of the
//! four is a submodule of its own, split off as the file outgrew itself:
//!
//! - `snapshot.rs`: the automatic `.bak` family and the status report over it.
//! - `restore.rs`: restoring from one, and finishing a restore a crash interrupted.
//! - `import.rs`: staging a user-selected database and applying it at the next startup.
//! - `external.rs`: the user-triggered export and the once-a-day off-volume mirror.
//! - `integrity.rs`: the throttled full `PRAGMA integrity_check`.
//! - `compaction.rs`: the user-triggered `VACUUM`.
//!
//! Most of the tests for all of them are still this module's `mod tests` (in `tests.rs` beside this
//! file, so the module reads as its production code), and one reason for that
//! is genuine while the other was not. The genuine one. Many exercise more than one of the machines
//! together (a snapshot taken, the database corrupted, the restore checked), which is the behavior
//! worth pinning and would have to be duplicated or arbitrarily assigned if it were split along the
//! same line as the code.
//!
//! The other reason was the shared fixtures (`temp_dir`, `seed_db`, `filetime_set`). A test could
//! not move without them, so every split moved code out of this module and left its tests in, and
//! the test file kept growing as the code shrank. Those fixtures now live in `test_support.rs`, so a test that
//! belongs to exactly one submodule can go and live there. `integrity.rs` has taken its four; the
//! rest follow when their submodule is next touched, rather than as one large move of tests nobody
//! is otherwise changing.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

use crate::services::database::SQLITE_BUSY_TIMEOUT_MS;
use crate::services::logger;
use crate::{AppError, AppResult};
// Used by `mod tests` below, which asserts against the codes the submodules return.
#[cfg(test)]
use crate::AppErrorCode;

// Serializes `backup_database` so at most one snapshot runs at a time. Two independent schedulers
// drive it (the pool-init snapshot (services::database) and the periodic loop (lib.rs)), and the
// is_recent() throttle is mtime-based, so it only suppresses a second call once the first has
// finished and refreshed `.bak`. While the first is still vacuuming, a second would pass is_recent()
// too and race it on the shared `.bak.tmp` and the rotate/rename chain, at worst promoting a
// half-written snapshot or burning a rotated generation. A single static lock is enough. There is
// one database process-wide and, unlike the pool, this lock holds no state a test needs to inject.
//
// `restore_database_from_backup` takes it too, which is why it lives here rather than in
// `snapshot.rs`. The restore reads the same `.bak` family a rotation rewrites.
static BACKUP_IN_PROGRESS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn sibling(db_path: &Path, suffix: &str) -> PathBuf {
    let name = db_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("kavynex.db");

    db_path.with_file_name(format!("{name}{suffix}"))
}

/// Removes the journal, log and shared-memory files a crashed earlier attempt may have left beside
/// a staging file, before a fresh copy takes its name. SQLite would otherwise read a hot journal or
/// a log there as belonging to the new copy and roll it into it.
fn remove_stale_sidecars(staging: &Path) {
    for suffix in ["-journal", "-wal", "-shm"] {
        let _ = std::fs::remove_file(sibling(staging, suffix));
    }
}

/// Shifts a rotated snapshot family up by one generation, dropping the oldest, so a fresh file
/// can be promoted into generation 0 without discarding the previous ones. Generation `N` is
/// overwritten by `N-1`, and so on down to generation 0 becoming generation 1. Best effort. A
/// generation that cannot be moved is left where it is rather than failing the caller.
///
/// Shared by the `.bak`, `.corrupt` and external-mirror families, which is why it takes the
/// per-generation path function rather than knowing any of their names.
fn rotate_generations(db_path: &Path, generations: usize, path_for: fn(&Path, usize) -> PathBuf) {
    for generation in (1..=generations).rev() {
        let source = path_for(db_path, generation - 1);
        let target = path_for(db_path, generation);

        if !source.exists() {
            continue;
        }

        // `rename` already replaces an existing target on both Windows and Unix, so the removal
        // below is only a fallback for the targets rename itself refuses (a locked or read-only
        // file on Windows). It has to come *after* the first attempt rather than before it.
        // Clearing the target up front and then failing to rename into it leaves the snapshot
        // sitting in `source`, which the next iteration's removal would then delete without it
        // ever having been copied anywhere. Silently costing a generation.
        if std::fs::rename(&source, &target).is_ok() {
            continue;
        }

        let _ = std::fs::remove_file(&target);

        if std::fs::rename(&source, &target).is_err() {
            // Stop instead of shifting the generations below into a slot this one still holds.
            // Rotation is best effort, so a generation that cannot be promoted is left where it
            // is, but letting the loop continue would have generation N-1 overwrite it.
            logger::warn(
                "db_backup",
                format!(
                    "backup rotation stopped at generation {generation}: the snapshot could not be promoted"
                ),
            );
            return;
        }
    }
}

fn backup_error(message: impl Into<String>, error: impl std::fmt::Display) -> AppError {
    // Same shape as services::media_comments and the rest of the app. Reuse the single
    // db_error constructor rather than re-deriving the AppError here.
    crate::services::database::db_error(message, error)
}

async fn open(db_path: &Path) -> AppResult<SqlitePool> {
    connect(db_path)
        .await
        .map_err(|error| backup_error("failed to open database for backup", error))
}

/// [`open`] with the driver's error kept, for a caller that has to tell damage from a file it
/// merely could not reach.
async fn connect(db_path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(false)
        // Backup/export/import can run while the main pool holds the write lock; without
        // a busy timeout any contention surfaces as an immediate SQLITE_BUSY failure.
        .busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))
        // This pool also opens files that came from outside (an import, the external mirror), whose
        // schema SQLite parses on open. Untrusted schema may not call functions with side effects,
        // and a page whose cells overrun it is reported as damage rather than read past.
        .pragma("trusted_schema", "OFF")
        .pragma("cell_size_check", "ON");
    // Foreign keys are on here as well, through sqlx's own default rather than an explicit
    // `.foreign_keys(true)`. Nothing depends on it either way. This pool only reads (quick_check,
    // VACUUM INTO, import validation), so there is no INSERT/UPDATE/DELETE for it to guard.
    //
    // It is deliberately *not* opened with `query_only`/`read_only` even though it never
    // mutates the source: SQLite requires a writable connection for `VACUUM INTO` (it fails
    // with "attempt to write a readonly database" otherwise). Concurrency is still safe. The
    // main pool runs in WAL mode, where the read snapshot `VACUUM INTO` holds does not block
    // the writer, so the once-a-day background snapshot cannot starve a concurrent write.

    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
}

/// True when `modified` is within `min_interval_secs` of `now`. Extracted as a pure function so the
/// backward-clock branch can be tested without setting a file mtime into the future. A `modified`
/// timestamp in the future relative to `now` (the system clock moved backward. An NTP correction,
/// RTC drift) is treated as recent, so a backward clock cannot defeat the once-a-day throttle shared
/// by backup_database, the external mirror and the integrity check and trigger a burst of spurious
/// runs. Worst case is one skipped run until the clock catches back up, never data loss.
fn duration_is_recent(now: SystemTime, modified: SystemTime, min_interval_secs: u64) -> bool {
    match now.duration_since(modified) {
        Ok(age) => age.as_secs() < min_interval_secs,
        Err(_) => true,
    }
}

fn is_recent(path: &Path, min_interval_secs: u64) -> bool {
    let Ok(modified) = std::fs::metadata(path).and_then(|meta| meta.modified()) else {
        return false;
    };

    duration_is_recent(SystemTime::now(), modified, min_interval_secs)
}

async fn is_healthy(pool: &SqlitePool) -> bool {
    match sqlx::query_as::<_, (String,)>("PRAGMA quick_check")
        .fetch_one(pool)
        .await
    {
        Ok((result,)) => result == "ok",
        Err(_) => false,
    }
}

/// Escapes a value for embedding as a single-quoted SQLite string literal by doubling every
/// `'`. This is the ONE place in the whole database layer where non-constant, externally
/// influenced data (the `VACUUM INTO` destination. A user-chosen export path, or the internal
/// temp/backup path) is assembled into raw SQL text rather than bound as a `?` parameter, and it
/// only exists because `VACUUM INTO` is a statement SQLite does not let you parameterize. Every
/// other query in the codebase uses `.bind(...)`. If this function is ever changed, the doubling
/// of every single quote must be preserved. It is the sole guard keeping a path from breaking out
/// of the literal. Covered by the adversarial-path export tests below.
fn escape_sql_literal(value: &str) -> String {
    value.replace('\'', "''")
}

fn modified_ms(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()?;
    modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|age| age.as_millis() as u64)
}

/// Sums the sizes of whichever of `paths` exist. A path that cannot be stat'd contributes zero
/// rather than failing the whole report. This feeds a display-only number, and a missing
/// generation is the normal case, not an error.
fn total_size_bytes(paths: &[PathBuf]) -> u64 {
    paths
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .fold(0u64, |total, size| total.saturating_add(size))
}

/// Every file this module owns beside the live database in the app config directory. The database
/// itself, SQLite's WAL sidecars, all seven backup generations, all three corrupt snapshots, the
/// import undo/staging files, every short-lived scratch file, and the two markers.
/// `docs/DIRECTORIES.md` documents the same set for the user.
///
/// It lives here rather than in any one submodule because it is the only thing that has to know
/// about all of them at once (which is also why the split left it behind.
///
/// Deliberately pure), it names paths without touching the filesystem, so the set is pinned by a
/// test rather than by whatever happens to exist on the machine running it. That matters because
/// the whole point of summing these is that the number is *complete*. A file this module starts
/// writing later and forgets to add here does not report as an error, it silently stops being
/// counted, and the reported size drifts below the real one exactly when the total is largest.
fn managed_database_paths(db_path: &Path) -> Vec<PathBuf> {
    let mut paths = vec![
        db_path.to_path_buf(),
        // SQLite's write-ahead log and shared-memory sidecars, present while the app runs.
        sibling(db_path, "-wal"),
        sibling(db_path, "-shm"),
    ];

    // `.bak` plus `.bak.1`..`.bak.N`, and the scratch file a snapshot vacuums into.
    paths.extend(
        (0..=snapshot::BACKUP_ROTATED_GENERATIONS)
            .map(|generation| snapshot::generation_backup_path(db_path, generation)),
    );
    paths.push(snapshot::temp_backup_path(db_path));

    // One snapshot per schema version an upgrade migrated from, and the scratch name it vacuums
    // into. Named for every version up to this build's, since at most two exist at a time but which
    // two depends on the upgrades this machine went through.
    paths.extend(
        (0..crate::services::db_schema::SCHEMA_VERSION)
            .map(|version| snapshot::pre_migration_path(db_path, version)),
    );
    paths.push(sibling(db_path, ".pre-migration.tmp"));

    // `.corrupt` plus its rotated generations, and the scratch name a restore moves through.
    paths.extend(
        (0..=restore::CORRUPT_ROTATED_GENERATIONS)
            .map(|generation| restore::generation_corrupt_path(db_path, generation)),
    );
    paths.push(sibling(db_path, ".corrupt.tmp"));
    // The set-aside database's write-ahead log, kept beside it (see restore::set_aside_corrupt_wal).
    paths.push(restore::corrupt_wal_path(db_path));

    paths.extend([
        restore::restore_staging_path(db_path),
        import::pre_import_path(db_path),
        import::import_staged_path(db_path),
        sibling(db_path, ".import-staged.tmp"),
        import::import_applying_marker_path(db_path),
        integrity::integrity_check_marker_path(db_path),
        integrity::integrity_failed_marker_path(db_path),
        swap_marker_path(db_path),
        lineage::lineage_marker_path(db_path),
    ]);

    // What an import recovery set aside (`import::displace_database`), named by a unique suffix, so
    // read from the directory rather than spelled out. Nothing removes these, which is why their
    // size belongs in the total the user sees.
    if let (Some(dir), Some(name)) = (db_path.parent(), db_path.file_name()) {
        let prefix = format!("{}.displaced-", name.to_string_lossy());

        if let Ok(entries) = std::fs::read_dir(dir) {
            paths.extend(
                entries
                    .flatten()
                    .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
                    .map(|entry| entry.path()),
            );
        }
    }

    paths
}

/// Opens `db_path` and runs `quick_check`, returning whether it passes. A file that cannot even
/// be opened as a database (or fails the check) returns false. Used both to pick a healthy backup
/// to restore and, in the pool builder, to refuse migrating a database that is already damaged
/// (see `services::database::build_pool_at`).
pub async fn database_quick_check_ok(db_path: &Path) -> bool {
    database_quick_check(db_path).await == QuickCheck::Healthy
}

/// What a `quick_check` of a database file found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuickCheck {
    Healthy,
    /// The check ran and reported a problem, or SQLite reported the file as corrupt or as not a
    /// database.
    Damaged,
    /// The check could not run, for a reason that says nothing about the contents (a lock, a sharing
    /// violation, a permission error). Carries the driver's message.
    Unreadable(String),
}

/// Runs `quick_check` on `db_path`, telling a damaged file apart from one that could not be read.
///
/// Choosing a backup only needs [`database_quick_check_ok`], since a candidate that cannot be read
/// is as useless as a damaged one. The live database is the case that needs the difference. Read
/// as damaged, a file locked by an antivirus scan sends the user to restore a snapshot up to a day
/// old over a database that was fine.
pub async fn database_quick_check(db_path: &Path) -> QuickCheck {
    let pool = match connect(db_path).await {
        Ok(pool) => pool,
        Err(error) => return quick_check_failure(&error),
    };

    let result = sqlx::query_as::<_, (String,)>("PRAGMA quick_check")
        .fetch_one(&pool)
        .await;
    pool.close().await;

    match result {
        Ok((verdict,)) if verdict == "ok" => QuickCheck::Healthy,
        Ok(_) => QuickCheck::Damaged,
        Err(error) => quick_check_failure(&error),
    }
}

/// [`database_quick_check`] on a pool that is already open.
pub(super) async fn pool_quick_check(pool: &SqlitePool) -> QuickCheck {
    match sqlx::query_as::<_, (String,)>("PRAGMA quick_check")
        .fetch_one(pool)
        .await
    {
        Ok((verdict,)) if verdict == "ok" => QuickCheck::Healthy,
        Ok(_) => QuickCheck::Damaged,
        Err(error) => quick_check_failure(&error),
    }
}

/// How many times a snapshot that could not be read is tried before it is passed over, and how long
/// apart. A file written a moment ago is exactly what an antivirus scan is still holding open, and
/// passing over the newest snapshot for that restores one up to six days older.
const UNREADABLE_ATTEMPTS: u32 = 3;
const UNREADABLE_RETRY_DELAY: Duration = Duration::from_millis(500);

/// [`database_quick_check`], tried again while the file cannot be read.
pub(super) async fn database_quick_check_retrying(db_path: &Path) -> QuickCheck {
    let mut verdict = database_quick_check(db_path).await;

    for _ in 1..UNREADABLE_ATTEMPTS {
        if !matches!(verdict, QuickCheck::Unreadable(_)) {
            break;
        }

        tokio::time::sleep(UNREADABLE_RETRY_DELAY).await;
        verdict = database_quick_check(db_path).await;
    }

    verdict
}

/// The error for a database that could not be read, as opposed to one found damaged.
pub(super) fn database_unreadable_error(detail: impl Into<String>) -> AppError {
    AppError::from_code_with_details(
        crate::AppErrorCode::DatabaseUnavailable,
        "the database could not be read, which usually means another program is holding it",
        detail.into(),
    )
}

fn quick_check_failure(error: &sqlx::Error) -> QuickCheck {
    if crate::services::database::sqlite_error_means_damage(error) {
        QuickCheck::Damaged
    } else {
        QuickCheck::Unreadable(error.to_string())
    }
}

/// Reads a database file's `user_version` (schema version) without migrating it. Used by restore
/// to refuse a backup produced by a newer app build. Returns `None` if the file cannot be opened
/// or the pragma read fails.
pub(crate) async fn database_schema_version(db_path: &Path) -> Option<i64> {
    let pool = open(db_path).await.ok()?;
    let version: Result<(i64,), _> = sqlx::query_as("PRAGMA user_version").fetch_one(&pool).await;
    pool.close().await;
    version.ok().map(|(value,)| value)
}

/// Whether opening the database will run a schema migration. true when the file is missing
/// (the schema is created on first open) or its `user_version` is below the version this
/// build ships. Callers use this to decide whether the pre-migration snapshot must block
/// startup (only when a migration will actually run), or can be deferred to the background.
/// When the database cannot be inspected, a migration is assumed pending so the safety
/// snapshot is still taken.
pub async fn is_schema_migration_pending(db_path: &Path) -> bool {
    if !db_path.exists() {
        return true;
    }

    let Ok(pool) = open(db_path).await else {
        return true;
    };

    let version: Result<(i64,), _> = sqlx::query_as("PRAGMA user_version").fetch_one(&pool).await;

    pool.close().await;

    match version {
        Ok((current,)) => current < crate::services::db_schema::SCHEMA_VERSION,
        Err(_) => true,
    }
}

// The automatic `.bak` snapshot family and the status report over it.
mod snapshot;
pub use snapshot::{
    backup_database, database_backup_status, has_backup_candidates,
    set_aside_backups_for_empty_start, snapshot_before_migration, DatabaseBackupStatus,
    SET_ASIDE_BACKUPS_DIR,
};
// The parent module's snapshot tests assert against these internals; test-only so a non-test build
// does not flag them unused.
#[cfg(test)]
use snapshot::{
    backup_path, generation_backup_path, pre_migration_versions_to_prune, temp_backup_path,
    BACKUP_MIN_INTERVAL_SECS, PRE_MIGRATION_SNAPSHOTS_KEPT,
};

// Restoring from a snapshot, and finishing a restore a crash interrupted.
mod restore;
#[cfg(test)]
use restore::{
    corrupt_path, generation_corrupt_path, restore_staging_path, rotate_corrupt_snapshots,
    CORRUPT_ROTATED_GENERATIONS,
};
pub use restore::{restore_database_from_backup, resume_interrupted_restore};

// The full `PRAGMA integrity_check` and its background throttle live in the `integrity` submodule.
mod integrity;
pub use integrity::{
    integrity_check_failed, integrity_check_is_due, mark_integrity_check_failed,
    mark_integrity_check_passed, run_full_integrity_check, DatabaseIntegrityReport,
};
// The integrity tests now live in `integrity.rs` itself, so the `#[cfg(test)] use` that used to
// pull `integrity_check_marker_path` and `MAX_INTEGRITY_PROBLEMS` up here for them is gone with
// them, which is the point of the move. An internal a submodule's own tests reach no longer has
// to be visible to its parent.

// Which database a backup was made from, so the mirror can tell an earlier database's copies.
mod lineage;
pub use lineage::record_new_lineage;

// The user-triggered `VACUUM`, which takes the backup lock above.
mod compaction;
pub use compaction::{compact_database, DatabaseCompaction};

// The user-triggered export and the once-a-day external mirror live in the `external` submodule.
mod external;
pub(crate) mod gates;
pub(crate) use external::EXTERNAL_BACKUP_FILE_NAME;
pub use external::{
    export_database, external_backup_status, mirror_database_to_external_dir, ExternalBackupStatus,
};
// The parent module's mirror tests reach these internals; test-only so a non-test build does not
// flag the imports unused.
#[cfg(test)]
use external::{
    external_backup_path, generation_external_backup_path, EXTERNAL_BACKUP_ROTATED_GENERATIONS,
};

mod import;
pub(crate) use import::pre_import_path;
pub use import::{
    apply_pending_database_import, database_import_undo_available, read_machine_paths,
    stage_database_import, stage_database_import_undo, MachinePaths,
};
/// The file recording when the database at `db_path` was last replaced by an import, an undo or a
/// restore, as seconds since the epoch.
pub(super) fn swap_marker_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".swapped-at")
}

/// Records that the database at `db_path` was just replaced. Best effort. A marker that cannot be
/// written leaves [`database_swapped_within`] reading the modification time of the set-aside
/// database, as it did before the marker existed.
pub(crate) fn record_database_swap(db_path: &Path) {
    // A failed full check described the database that was just replaced.
    integrity::clear_integrity_failure(db_path);

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // The previous swap's time goes first, so a write that fails below leaves no marker rather than
    // one naming a swap from months ago.
    let _ = std::fs::remove_file(swap_marker_path(db_path));

    if let Err(error) = crate::services::filesystem::write_file_durably(
        &swap_marker_path(db_path),
        now.to_string().as_bytes(),
    ) {
        logger::warn(
            "db_backup",
            format!("could not record when the database was replaced: {error}"),
        );
    }
}

/// Whether `swapped_at` (seconds since the epoch) is within `window` of `now`. A time in the future
/// counts as recent, so a clock that moved back cannot end the window early.
fn swap_is_within(now: SystemTime, swapped_at: SystemTime, window: Duration) -> bool {
    now.duration_since(swapped_at)
        .map_or(true, |age| age < window)
}

/// Whether the database at `db_path` replaced another one within `window`, by an import or a
/// restore.
///
/// Read from the marker the swap writes. The set-aside database (`.pre-import`, `.corrupt`) keeps
/// the modification time of its last write, because a rename does not change it, so a restore of a
/// database nothing had written for weeks read as a swap from weeks ago and let the orphan removal
/// run at once. Those times are still consulted, alongside the marker rather than only without
/// one, so a marker a later swap failed to rewrite cannot end the window early. Either answering
/// recent is enough, which errs toward refusing the removal.
pub(crate) fn database_swapped_within(db_path: &Path, window: Duration) -> bool {
    let now = SystemTime::now();

    let marked_recent = std::fs::read_to_string(swap_marker_path(db_path))
        .ok()
        .and_then(|text| text.trim().parse::<u64>().ok())
        .is_some_and(|secs| swap_is_within(now, UNIX_EPOCH + Duration::from_secs(secs), window));

    if marked_recent {
        return true;
    }

    [pre_import_path(db_path), restore::corrupt_path(db_path)]
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok()?.modified().ok())
        .any(|modified| swap_is_within(now, modified, window))
}

// The parent module's import tests reach these internals; test-only so a non-test build does
// not flag the imports unused.
#[cfg(test)]
use import::{import_applying_marker_path, import_staged_path, write_import_applying_marker};

// The fixtures the tests in this family share. Declared here rather than inside `mod tests` so a
// submodule's own tests can reach them too; see the module docs above for why that mattered.
#[cfg(test)]
mod test_support;

#[cfg(test)]
mod tests;
