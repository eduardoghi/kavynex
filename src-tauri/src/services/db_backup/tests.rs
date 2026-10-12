// The tests for the parent module, kept in a file of their own so the module reads as its
// production code. Same module as before (`mod tests` declared under `#[cfg(test)]` in the
// parent), so `use super::*` still reaches every private item it did.

use super::test_support::{filetime_set, seed_db, temp_dir};
use super::*;
use std::time::UNIX_EPOCH;

#[test]
fn duration_is_recent_classifies_recent_stale_and_backward_clock() {
    let now = UNIX_EPOCH + Duration::from_secs(1_000_000);
    let interval = 60;

    // Within the interval -> recent.
    assert!(duration_is_recent(
        now,
        now - Duration::from_secs(1),
        interval
    ));
    // Older than the interval -> not recent.
    assert!(!duration_is_recent(
        now,
        now - Duration::from_secs(120),
        interval
    ));
    // Exactly at the interval -> not recent (strict `<`).
    assert!(!duration_is_recent(
        now,
        now - Duration::from_secs(60),
        interval
    ));
    // Modified in the future (the clock moved backward) -> treated as recent, so the throttle
    // holds instead of firing a burst of spurious backups.
    assert!(duration_is_recent(
        now,
        now + Duration::from_secs(60),
        interval
    ));
}

#[tokio::test]
async fn backup_creates_a_valid_snapshot() {
    let dir = temp_dir("valid");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;

    assert!(backup_database(&db).await.unwrap());

    let bak = backup_path(&db);
    assert!(bak.exists());

    let options = SqliteConnectOptions::new()
        .filename(&bak)
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    let (value,): (String,) = sqlx::query_as("SELECT v FROM t LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(value, "hello");
    pool.close().await;

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn backup_is_throttled_when_recent() {
    let dir = temp_dir("throttle");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;

    assert!(backup_database(&db).await.unwrap());
    assert!(!backup_database(&db).await.unwrap());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn concurrent_backups_run_one_at_a_time() {
    // Model the two schedulers firing together (pool-init snapshot + periodic tick). With the
    // in-progress lock, exactly one call writes the snapshot and the other, once it acquires
    // the lock, sees the fresh `.bak` via is_recent and skips. Without the lock both would pass
    // is_recent (neither `.bak` written yet) and fight over the shared `.bak.tmp`, so both would
    // return true, which this asserts against.
    let dir = temp_dir("concurrent");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;

    let (first, second) = tokio::join!(backup_database(&db), backup_database(&db));
    let first = first.unwrap();
    let second = second.unwrap();

    assert_ne!(
        first, second,
        "one backup must run and the other skip, not both"
    );
    assert!(backup_path(&db).exists());

    // The promoted `.bak` must be a whole database, not a half-written `.bak.tmp`.
    let options = SqliteConnectOptions::new()
        .filename(backup_path(&db))
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    let (value,): (String,) = sqlx::query_as("SELECT v FROM t LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(value, "hello");
    pool.close().await;

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn an_empty_database_is_not_rotated_over_snapshots_of_a_library() {
    // A database file recreated empty, by a quarantine or a profile reset. Each daily backup of it
    // would push out one good generation until none was left.
    let dir = temp_dir("empty-over-library");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "kept").await;
    std::fs::copy(&db, generation_backup_path(&db, 1)).unwrap();

    let pool = open(&db).await.unwrap();
    sqlx::query("DELETE FROM videos")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;

    assert!(!backup_database(&db).await.unwrap());
    assert!(!backup_path(&db).exists(), "nothing was promoted");
    assert_eq!(
        read_title(&generation_backup_path(&db, 1)).await,
        "kept",
        "the snapshot of the library is where it was"
    );

    // Once the new database holds something, backups resume.
    let pool = open(&db).await.unwrap();
    sqlx::query("INSERT INTO videos (title) VALUES ('new')")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;

    assert!(backup_database(&db).await.unwrap());

    let _ = std::fs::remove_dir_all(&dir);
}

async fn read_title(path: &Path) -> String {
    let pool = open(path).await.unwrap();
    let (title,): (String,) = sqlx::query_as("SELECT title FROM videos LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    pool.close().await;
    title
}

#[tokio::test]
async fn a_failed_full_check_keeps_the_rotation_still_until_a_check_passes() {
    // The damage a full check finds passes quick_check, so each daily run would otherwise rotate
    // out a generation taken before it.
    let dir = temp_dir("integrity-failed");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;

    mark_integrity_check_failed(&db);
    assert!(!backup_database(&db).await.unwrap());
    assert!(!backup_path(&db).exists());

    // What is added meanwhile still gets a copy, outside the rotation and once a day.
    let after_damage = snapshot::after_damage_path(&db);
    assert!(after_damage.exists());
    assert!(!snapshot::after_damage_temp_path(&db).exists());
    let copied_at = std::fs::metadata(&after_damage)
        .unwrap()
        .modified()
        .unwrap();
    assert!(!backup_database(&db).await.unwrap());
    assert_eq!(
        std::fs::metadata(&after_damage)
            .unwrap()
            .modified()
            .unwrap(),
        copied_at
    );

    mark_integrity_check_passed(&db);
    assert!(!integrity_check_failed(&db));
    assert!(backup_database(&db).await.unwrap());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_replaced_database_drops_the_failed_check_of_the_one_before() {
    let dir = temp_dir("integrity-failed-swap");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;
    assert!(backup_database(&db).await.unwrap());

    mark_integrity_check_failed(&db);
    std::fs::write(&db, b"not a database").unwrap();
    restore_database_from_backup(&db).await.unwrap();

    assert!(!integrity_check_failed(&db));

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn backup_skips_when_source_missing() {
    let dir = temp_dir("missing");
    let db = dir.join("kavynex.db");

    assert!(!backup_database(&db).await.unwrap());

    let _ = std::fs::remove_dir_all(&dir);
}

async fn read_single_value(path: &Path) -> String {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    let (value,): (String,) = sqlx::query_as("SELECT v FROM t LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    pool.close().await;
    value
}

#[tokio::test]
async fn mirror_writes_a_readable_copy_into_the_external_dir() {
    let dir = temp_dir("ext-write-src");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;

    let external = temp_dir("ext-write-dest");

    assert!(mirror_database_to_external_dir(&db, &external)
        .await
        .unwrap());

    let current = external_backup_path(&external);
    assert!(current.exists());
    assert_eq!(read_single_value(&current).await, "hello");
    // The staging file is renamed into place, never left behind.
    assert!(!external
        .join(format!("{EXTERNAL_BACKUP_FILE_NAME}.new"))
        .exists());

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&external);
}

#[tokio::test]
async fn the_external_backup_status_says_whether_the_folder_is_there_and_when_it_was_copied() {
    assert_eq!(
        external_backup_status("  "),
        ExternalBackupStatus::default()
    );

    let missing = temp_dir("ext-status-missing").join("gone");
    let status = external_backup_status(&missing.to_string_lossy());
    assert!(status.configured);
    assert!(!status.reachable);
    assert_eq!(status.mirrored_at_ms, None);

    let dir = temp_dir("ext-status");
    let db = dir.join("kavynex.db");
    let external = temp_dir("ext-status-target");
    seed_db(&db).await;

    let before = external_backup_status(&external.to_string_lossy());
    assert!(before.reachable);
    assert_eq!(before.mirrored_at_ms, None, "nothing copied yet");

    assert!(mirror_database_to_external_dir(&db, &external)
        .await
        .unwrap());
    assert!(external_backup_status(&external.to_string_lossy())
        .mirrored_at_ms
        .is_some());

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&external);
}

/// Ages every file in `dir` past the mirror's 24h throttle.
fn age_external_copies(dir: &Path) {
    let two_days_ago = SystemTime::now() - Duration::from_secs(2 * 24 * 60 * 60);

    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        filetime_set(&entry.path(), two_days_ago);
    }
}

async fn empty_kavynex_db(path: &Path) {
    seed_kavynex_db(path, "placeholder").await;
    let pool = open(path).await.unwrap();
    sqlx::query("DELETE FROM videos")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}

#[tokio::test]
async fn mirror_does_not_rotate_an_empty_database_over_copies_of_a_library() {
    let dir = temp_dir("ext-empty-src");
    let db = dir.join("kavynex.db");
    let external = temp_dir("ext-empty-dest");
    seed_kavynex_db(&db, "the library").await;
    assert!(mirror_database_to_external_dir(&db, &external)
        .await
        .unwrap());
    age_external_copies(&external);

    std::fs::remove_file(&db).unwrap();
    empty_kavynex_db(&db).await;

    assert!(!mirror_database_to_external_dir(&db, &external)
        .await
        .unwrap());
    assert_eq!(
        read_title(&external_backup_path(&external)).await,
        "the library"
    );
    assert!(!generation_external_backup_path(&external, 1).exists());

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&external);
}

#[tokio::test]
async fn mirror_keeps_the_copies_taken_before_a_failed_full_check() {
    let dir = temp_dir("ext-damaged-src");
    let db = dir.join("kavynex.db");
    let external = temp_dir("ext-damaged-dest");
    seed_kavynex_db(&db, "before the damage").await;
    assert!(mirror_database_to_external_dir(&db, &external)
        .await
        .unwrap());
    age_external_copies(&external);

    mark_integrity_check_failed(&db);

    assert!(!mirror_database_to_external_dir(&db, &external)
        .await
        .unwrap());
    assert!(!generation_external_backup_path(&external, 1).exists());
    assert!(external.join("kavynex-backup.after-damage.db").exists());

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&external);
}

#[tokio::test]
async fn mirror_sets_aside_copies_an_earlier_database_left_in_the_folder() {
    // A reinstall pointed at the folder holding the only copy of the old library. The new database
    // has a lineage of its own, and the copies there carry none.
    let dir = temp_dir("ext-foreign-src");
    let db = dir.join("kavynex.db");
    let external = temp_dir("ext-foreign-dest");
    seed_kavynex_db(&external_backup_path(&external), "the old library").await;
    seed_kavynex_db(&generation_external_backup_path(&external, 1), "older").await;
    age_external_copies(&external);

    seed_kavynex_db(&db, "the new library").await;
    record_new_lineage(&db);

    assert!(mirror_database_to_external_dir(&db, &external)
        .await
        .unwrap());

    assert_eq!(
        read_title(&external_backup_path(&external)).await,
        "the new library"
    );
    let set_aside: Vec<String> = std::fs::read_dir(&external)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("kavynex-backup-previous-") && name.ends_with(".db"))
        .collect();
    assert_eq!(set_aside.len(), 2, "both copies were kept: {set_aside:?}");

    // The fresh copy is labelled, so the next run rotates it like any other.
    age_external_copies(&external);
    assert!(mirror_database_to_external_dir(&db, &external)
        .await
        .unwrap());
    assert!(generation_external_backup_path(&external, 1).exists());

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&external);
}

#[tokio::test]
async fn an_empty_start_moves_the_snapshots_where_import_can_read_them() {
    let dir = temp_dir("empty-start");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "the old library").await;
    assert!(backup_database(&db).await.unwrap());
    std::fs::copy(backup_path(&db), generation_backup_path(&db, 2)).unwrap();
    std::fs::remove_file(&db).unwrap();

    let folder = set_aside_backups_for_empty_start(&db)
        .unwrap()
        .expect("there were snapshots to move");

    assert!(!has_backup_candidates(&db));
    assert_eq!(
        read_title(&folder.join("kavynex-bak.db")).await,
        "the old library"
    );
    assert!(folder.join("kavynex-bak-2.db").exists());
    assert!(folder.starts_with(dir.join(SET_ASIDE_BACKUPS_DIR)));

    assert!(
        set_aside_backups_for_empty_start(&db).unwrap().is_none(),
        "nothing left to move"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn mirror_is_throttled_when_recent() {
    let dir = temp_dir("ext-throttle-src");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;

    let external = temp_dir("ext-throttle-dest");

    assert!(mirror_database_to_external_dir(&db, &external)
        .await
        .unwrap());
    // A second run within the 24h window is a no-op. The mirror was just written.
    assert!(!mirror_database_to_external_dir(&db, &external)
        .await
        .unwrap());

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&external);
}

#[tokio::test]
async fn mirror_skips_when_the_external_dir_is_missing() {
    let dir = temp_dir("ext-missing-src");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;

    // A path that does not exist stands in for an unplugged external drive.
    let external = dir.join("unplugged-drive");
    assert!(!external.exists());

    assert!(!mirror_database_to_external_dir(&db, &external)
        .await
        .unwrap());
    // The missing directory is never recreated (it could now resolve to another device).
    assert!(!external.exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn mirror_adopts_a_recent_stranded_staged_copy_instead_of_deleting_it() {
    let dir = temp_dir("ext-adopt-src");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;

    // A failed promotion leaves the staged file as the only copy in the directory. The
    // rotation already consumed generation 0 before the rename failed.
    let external = temp_dir("ext-adopt-dest");
    let staged = external.join(format!("{EXTERNAL_BACKUP_FILE_NAME}.new"));
    std::fs::write(&staged, b"stranded").unwrap();

    // The stranded copy is fresh, so after adoption the throttle applies. No new export.
    assert!(!mirror_database_to_external_dir(&db, &external)
        .await
        .unwrap());

    let current = external_backup_path(&external);
    assert_eq!(std::fs::read(&current).unwrap(), b"stranded");
    assert!(!staged.exists());

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&external);
}

#[tokio::test]
async fn mirror_rotates_a_stale_stranded_staged_copy_behind_a_fresh_export() {
    let dir = temp_dir("ext-adopt-stale-src");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;

    let external = temp_dir("ext-adopt-stale-dest");
    let staged = external.join(format!("{EXTERNAL_BACKUP_FILE_NAME}.new"));
    std::fs::write(&staged, b"stranded-old").unwrap();
    let old = SystemTime::now() - std::time::Duration::from_secs(BACKUP_MIN_INTERVAL_SECS * 2);
    filetime_set(&staged, old);

    // Past the throttle window the adopted copy is refreshed, but never thrown away. It is
    // rotated up as a generation while the fresh export becomes the current mirror.
    assert!(mirror_database_to_external_dir(&db, &external)
        .await
        .unwrap());

    let current = external_backup_path(&external);
    assert_eq!(read_single_value(&current).await, "hello");
    assert_eq!(
        std::fs::read(generation_external_backup_path(&external, 1)).unwrap(),
        b"stranded-old"
    );
    assert!(!staged.exists());

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&external);
}

#[test]
fn external_backup_generations_rotate_up() {
    let dir = temp_dir("ext-rotate");

    std::fs::write(generation_external_backup_path(&dir, 0), b"gen0").unwrap();
    std::fs::write(generation_external_backup_path(&dir, 1), b"gen1").unwrap();

    assert!(rotate_generations(
        &dir,
        EXTERNAL_BACKUP_ROTATED_GENERATIONS,
        generation_external_backup_path,
    ));

    // gen0 -> gen1 and gen1 -> gen2, leaving generation 0 free for a fresh mirror.
    assert!(!generation_external_backup_path(&dir, 0).exists());
    assert_eq!(
        std::fs::read(generation_external_backup_path(&dir, 1)).unwrap(),
        b"gen0"
    );
    assert_eq!(
        std::fs::read(generation_external_backup_path(&dir, 2)).unwrap(),
        b"gen1"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn managed_database_paths_names_every_file_this_module_writes() {
    // Pins the set the size report sums. Written as an exact comparison rather than a handful
    // of `contains` assertions on purpose. The number is only worth showing if it is complete,
    // and a file added to the module without being added here would silently stop being
    // counted. A failure means "add the new file", not "loosen the test".
    let db = Path::new("/config/kavynex.db");
    let named: Vec<String> = managed_database_paths(db)
        .iter()
        .map(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap()
                .to_string()
        })
        .collect();

    // The pre-migration snapshots are named per schema version, so their run is built from the
    // version this build ships rather than written out, or every new migration would break this.
    let pre_migration: Vec<String> = (0..crate::services::db_schema::SCHEMA_VERSION)
        .map(|version| format!("kavynex.db.pre-migration-v{version}"))
        .chain(std::iter::once("kavynex.db.pre-migration.tmp".to_string()))
        .collect();

    let mut expected: Vec<String> = [
        "kavynex.db",
        "kavynex.db-wal",
        "kavynex.db-shm",
        "kavynex.db.bak",
        "kavynex.db.bak.1",
        "kavynex.db.bak.2",
        "kavynex.db.bak.3",
        "kavynex.db.bak.4",
        "kavynex.db.bak.5",
        "kavynex.db.bak.6",
        "kavynex.db.bak.tmp",
        "kavynex.db.bak.rotating",
        "kavynex.db.after-damage",
        "kavynex.db.after-damage.tmp",
    ]
    .iter()
    .map(|name| name.to_string())
    .collect();
    expected.extend(pre_migration);
    expected.extend(
        [
            "kavynex.db.corrupt",
            "kavynex.db.corrupt.1",
            "kavynex.db.corrupt.2",
            "kavynex.db.corrupt.tmp",
            "kavynex.db.corrupt.rotating",
            "kavynex.db.corrupt-wal",
            "kavynex.db.restore.tmp",
            "kavynex.db.restore.partial",
            "kavynex.db.pre-import",
            "kavynex.db.pre-import-wal",
            "kavynex.db.import-staged",
            "kavynex.db.import-staged.tmp",
            "kavynex.db.import-applying",
            "kavynex.db.integrity-checked",
            "kavynex.db.integrity-failed",
            "kavynex.db.swapped-at",
            "kavynex.db.lineage",
        ]
        .iter()
        .map(|name| name.to_string()),
    );

    assert_eq!(named, expected);

    // Every entry is a sibling of the database, never somewhere else on disk. The report is
    // about what this one directory holds.
    for path in managed_database_paths(db) {
        assert_eq!(path.parent(), db.parent());
    }
}

#[test]
fn total_size_ignores_missing_paths_and_directories() {
    let dir = temp_dir("total-size");

    let present = dir.join("present.bin");
    std::fs::write(&present, vec![0u8; 300]).unwrap();

    let subdir = dir.join("a-directory");
    std::fs::create_dir_all(&subdir).unwrap();

    let missing = dir.join("never-written.bin");

    // A missing generation is the normal case, and a directory sharing a managed name must
    // never contribute its metadata size, both count as zero, so only the real file's bytes
    // are reported.
    assert_eq!(
        total_size_bytes(&[present.clone(), subdir, missing]),
        300,
        "only existing regular files contribute to the total"
    );

    assert_eq!(total_size_bytes(&[]), 0);

    let second = dir.join("second.bin");
    std::fs::write(&second, vec![0u8; 45]).unwrap();
    // Summed, not maxed or counted. Two files report the sum of their sizes.
    assert_eq!(total_size_bytes(&[present, second]), 345);

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn backup_status_reports_the_size_of_the_database_and_its_snapshots() {
    let dir = temp_dir("status-size");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;

    let database_only = database_backup_status(&db);
    let database_bytes = std::fs::metadata(&db).unwrap().len();

    // With no snapshot yet the total is at least the database itself (the WAL sidecars may or
    // may not linger after seed_db closes its pool, so this is a floor, not an equality).
    assert!(
        database_only.total_bytes >= database_bytes,
        "total {} should cover the {database_bytes}-byte database",
        database_only.total_bytes
    );

    assert!(backup_database(&db).await.unwrap());

    let with_snapshot = database_backup_status(&db);
    let snapshot_bytes = std::fs::metadata(backup_path(&db)).unwrap().len();

    // Taking a snapshot must grow the reported total by that snapshot. This is the whole point
    // of the number, and it is what a mutant reporting only the database's own size loses.
    assert!(
        with_snapshot.total_bytes >= database_only.total_bytes + snapshot_bytes,
        "total should grow by the {snapshot_bytes}-byte snapshot, went from {} to {}",
        database_only.total_bytes,
        with_snapshot.total_bytes
    );

    // The formatted string is derived from the same count, not computed independently.
    assert_eq!(
        with_snapshot.formatted_total_size,
        crate::utils::format::format_bytes(with_snapshot.total_bytes)
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn backup_status_reports_availability() {
    let dir = temp_dir("status");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;

    assert!(!database_backup_status(&db).available);

    assert!(backup_database(&db).await.unwrap());

    let status = database_backup_status(&db);
    assert!(status.available);
    assert!(status.backed_up_at_ms.is_some());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn restore_replaces_corrupt_database_and_preserves_it() {
    let dir = temp_dir("restore");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;
    assert!(backup_database(&db).await.unwrap());

    // Corrupt the live database by overwriting it with garbage.
    std::fs::write(&db, b"not a database").unwrap();

    restore_database_from_backup(&db).await.unwrap();

    // The restored database is usable again and holds the backed-up data.
    assert_eq!(read_single_value(&db).await, "hello");

    // The corrupt copy is preserved for inspection, not deleted.
    assert!(corrupt_path(&db).exists());
    assert_eq!(std::fs::read(corrupt_path(&db)).unwrap(), b"not a database");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_restore_of_a_database_nobody_wrote_for_weeks_still_reads_as_a_recent_swap() {
    // The set-aside database keeps the time of its last write, which a rename does not change.
    // Read from that, a database untouched for weeks made the swap look weeks old, and the orphan
    // removal's 30-day refusal never applied.
    let dir = temp_dir("swap-recent");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;
    assert!(backup_database(&db).await.unwrap());

    std::fs::write(&db, b"not a database").unwrap();
    let weeks_ago = SystemTime::now() - Duration::from_secs(60 * 24 * 60 * 60);
    filetime_set(&db, weeks_ago);

    restore_database_from_backup(&db).await.unwrap();

    let thirty_days = Duration::from_secs(30 * 24 * 60 * 60);
    assert!(database_swapped_within(&db, thirty_days));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_old_swap_marker_and_an_old_set_aside_file_end_the_window() {
    let dir = temp_dir("swap-old");
    let db = dir.join("kavynex.db");
    std::fs::write(corrupt_path(&db), b"set aside long ago").unwrap();
    let sixty_days = Duration::from_secs(60 * 24 * 60 * 60);
    filetime_set(&corrupt_path(&db), SystemTime::now() - sixty_days);

    let sixty_days_ago = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        - sixty_days.as_secs();
    std::fs::write(swap_marker_path(&db), sixty_days_ago.to_string()).unwrap();

    assert!(!database_swapped_within(
        &db,
        Duration::from_secs(30 * 24 * 60 * 60)
    ));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_marker_a_later_swap_failed_to_rewrite_does_not_end_the_window() {
    // The set-aside file is never newer than the swap that set it aside, so a recent one means a
    // recent swap whatever an older marker says. That marker is what a failed rewrite leaves.
    let dir = temp_dir("swap-stale-marker");
    let db = dir.join("kavynex.db");
    std::fs::write(corrupt_path(&db), b"set aside a moment ago").unwrap();

    let sixty_days_ago = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        - 60 * 24 * 60 * 60;
    std::fs::write(swap_marker_path(&db), sixty_days_ago.to_string()).unwrap();

    assert!(database_swapped_within(
        &db,
        Duration::from_secs(30 * 24 * 60 * 60)
    ));

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_restore_keeps_this_machines_folders_rather_than_the_snapshots() {
    // A snapshot from before a library move names the folder the move emptied.
    let dir = temp_dir("restore-machine-paths");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "kept").await;
    set_setting(&db, "library_path", "/old/library").await;
    assert!(backup_database(&db).await.unwrap());

    set_setting(&db, "library_path", "/new/library").await;
    set_setting(&db, "external_backup_dir", "/mirror").await;

    restore_database_from_backup(&db).await.unwrap();

    let paths = read_machine_paths(&db).await.unwrap();
    assert_eq!(paths.library_path, "/new/library");
    assert_eq!(paths.external_backup_dir, "/mirror");

    let _ = std::fs::remove_dir_all(&dir);
}

async fn set_setting(db: &Path, key: &str, value: &str) {
    let pool = open(db).await.unwrap();
    sqlx::query(
        "INSERT INTO app_settings (key, value) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;
}

#[tokio::test]
async fn restore_rotates_previous_corrupt_snapshots_instead_of_discarding_them() {
    let dir = temp_dir("restore-corrupt-rotate");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;
    assert!(backup_database(&db).await.unwrap());

    // First corruption and restore. The broken database lands in `.corrupt`.
    std::fs::write(&db, b"first corruption").unwrap();
    restore_database_from_backup(&db).await.unwrap();
    assert_eq!(
        std::fs::read(corrupt_path(&db)).unwrap(),
        b"first corruption"
    );

    // A second corruption and restore must not throw the first one away. It rotates to
    // `.corrupt.1` while the newest takes `.corrupt`. Overwriting instead would destroy the
    // evidence of exactly the repeated-corruption case worth diagnosing.
    std::fs::write(&db, b"second corruption").unwrap();
    restore_database_from_backup(&db).await.unwrap();

    assert_eq!(read_single_value(&db).await, "hello");
    assert_eq!(
        std::fs::read(corrupt_path(&db)).unwrap(),
        b"second corruption"
    );
    assert_eq!(
        std::fs::read(generation_corrupt_path(&db, 1)).unwrap(),
        b"first corruption"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn corrupt_snapshot_rotation_drops_only_the_oldest_generation() {
    let dir = temp_dir("corrupt-rotate-bound");
    let db = dir.join("kavynex.db");

    // Fill every kept generation, then rotate once more. The oldest falls off the end and
    // the rest shift up, so the family stays bounded instead of growing per restore.
    for generation in 0..=CORRUPT_ROTATED_GENERATIONS {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            generation_corrupt_path(&db, generation),
            format!("gen{generation}"),
        )
        .unwrap();
    }

    assert!(rotate_corrupt_snapshots(&db));

    // Generation 0 is now free for the incoming snapshot.
    assert!(!corrupt_path(&db).exists());

    for generation in 1..=CORRUPT_ROTATED_GENERATIONS {
        assert_eq!(
            std::fs::read(generation_corrupt_path(&db, generation)).unwrap(),
            format!("gen{}", generation - 1).into_bytes()
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn rotation_stops_instead_of_overwriting_a_generation_it_could_not_promote() {
    // Rotation walks the generations oldest-first, promoting each into the slot above it. A
    // promotion that fails leaves that snapshot still sitting in its own slot, so carrying on
    // to the next generation would rename the one below straight over it, destroying a snapshot
    // that was never copied anywhere. Stopping is what keeps a failed promotion cost-free.
    let dir = temp_dir("rotate-blocked-generation");
    let db = dir.join("kavynex.db");
    std::fs::create_dir_all(&dir).unwrap();

    std::fs::write(generation_corrupt_path(&db, 0), b"gen0").unwrap();
    std::fs::write(generation_corrupt_path(&db, 1), b"gen1").unwrap();

    // A directory on the oldest slot is something `rename` refuses to write over and
    // `remove_file` cannot clear, so generation 1 has nowhere to be promoted to. This is the
    // stand-in for what blocks it in the wild. A locked or read-only file on Windows.
    std::fs::create_dir(generation_corrupt_path(&db, CORRUPT_ROTATED_GENERATIONS)).unwrap();

    assert!(
        !rotate_corrupt_snapshots(&db),
        "a rotation that stopped short reports that generation 0 is still occupied"
    );

    // Generation 1 could not be promoted, so it has to be left intact rather than overwritten
    // by generation 0 shifting up into a slot that is still occupied.
    assert_eq!(
        std::fs::read(generation_corrupt_path(&db, 1)).unwrap(),
        b"gen1"
    );
    assert_eq!(
        std::fs::read(generation_corrupt_path(&db, 0)).unwrap(),
        b"gen0"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_held_newest_generation_leaves_the_older_ones_where_they_are() {
    // Generation 0 is the file a sync client or a backup tool holds. The rotation used to shift
    // every older generation first, so each day of the hold moved them up one slot and dropped the
    // oldest, until only the held file was left.
    let dir = temp_dir("rotate-held-newest");
    let db = dir.join("kavynex.db");
    std::fs::create_dir_all(&dir).unwrap();

    std::fs::write(generation_corrupt_path(&db, 0), b"gen0").unwrap();
    std::fs::write(generation_corrupt_path(&db, 1), b"gen1").unwrap();
    std::fs::write(generation_corrupt_path(&db, 2), b"gen2").unwrap();

    // A non-empty directory on the parked name, which `rename` cannot write over, is the stand-in
    // for generation 0 being held.
    let mut parked = generation_corrupt_path(&db, 0).into_os_string();
    parked.push(".rotating");
    let parked = PathBuf::from(parked);
    std::fs::create_dir_all(parked.join("held")).unwrap();

    for _day in 0..3 {
        assert!(!rotate_corrupt_snapshots(&db));
    }

    assert_eq!(
        std::fs::read(generation_corrupt_path(&db, 0)).unwrap(),
        b"gen0"
    );
    assert_eq!(
        std::fs::read(generation_corrupt_path(&db, 1)).unwrap(),
        b"gen1"
    );
    assert_eq!(
        std::fs::read(generation_corrupt_path(&db, 2)).unwrap(),
        b"gen2"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_rotation_interrupted_after_parking_puts_the_snapshot_back() {
    // A process that died between parking generation 0 and placing it. The parked file is the only
    // copy of that snapshot, and the next rotation finds it and carries on as usual.
    let dir = temp_dir("rotate-interrupted");
    let db = dir.join("kavynex.db");
    std::fs::create_dir_all(&dir).unwrap();

    let mut parked = generation_corrupt_path(&db, 0).into_os_string();
    parked.push(".rotating");
    std::fs::write(PathBuf::from(&parked), b"parked").unwrap();
    std::fs::write(generation_corrupt_path(&db, 1), b"gen1").unwrap();

    assert!(rotate_corrupt_snapshots(&db));

    assert!(!PathBuf::from(&parked).exists());
    assert_eq!(
        std::fs::read(generation_corrupt_path(&db, 1)).unwrap(),
        b"parked"
    );
    assert_eq!(
        std::fs::read(generation_corrupt_path(&db, 2)).unwrap(),
        b"gen1"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_backup_whose_rotation_stops_short_keeps_the_previous_snapshot() {
    // A generation another program holds stops the rotation with `.bak` still in its slot.
    // Promoting the fresh snapshot then overwrote it, every day the hold lasted.
    let dir = temp_dir("rotate-blocked-backup");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;
    assert!(backup_database(&db).await.unwrap());

    let previous = std::fs::read(backup_path(&db)).unwrap();
    let a_day_ago = SystemTime::now() - Duration::from_secs(BACKUP_MIN_INTERVAL_SECS + 60);
    filetime_set(&backup_path(&db), a_day_ago);

    // Every generation from 1 up holds a file, and the oldest slot is a directory that neither
    // `rename` nor `remove_file` can clear, the stand-in for a file held open on Windows.
    for generation in 1..BACKUP_ROTATED_GENERATIONS {
        std::fs::write(generation_backup_path(&db, generation), b"older").unwrap();
    }
    std::fs::create_dir(generation_backup_path(&db, BACKUP_ROTATED_GENERATIONS)).unwrap();

    assert!(backup_database(&db).await.is_err());

    assert_eq!(std::fs::read(backup_path(&db)).unwrap(), previous);
    assert!(
        temp_backup_path(&db).exists(),
        "the fresh snapshot is kept where a restore still finds it"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_mirror_whose_rotation_stops_short_keeps_the_current_copy() {
    let dir = temp_dir("rotate-blocked-mirror-src");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;

    let external = temp_dir("rotate-blocked-mirror-dest");
    std::fs::write(generation_external_backup_path(&external, 0), b"current").unwrap();
    std::fs::write(generation_external_backup_path(&external, 1), b"older").unwrap();
    std::fs::create_dir(generation_external_backup_path(
        &external,
        EXTERNAL_BACKUP_ROTATED_GENERATIONS,
    ))
    .unwrap();
    let a_day_ago = SystemTime::now() - Duration::from_secs(BACKUP_MIN_INTERVAL_SECS + 60);
    filetime_set(&generation_external_backup_path(&external, 0), a_day_ago);

    assert!(mirror_database_to_external_dir(&db, &external)
        .await
        .is_err());

    assert_eq!(
        std::fs::read(generation_external_backup_path(&external, 0)).unwrap(),
        b"current"
    );
    assert!(external
        .join(format!("{EXTERNAL_BACKUP_FILE_NAME}.new"))
        .exists());

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&external);
}

/// Reproduces the crash window in `restore_database_from_backup`. The process dies between
/// the rename that moves the old database aside and the one that renames the staged snapshot
/// into place, leaving no database at all next to a `.restore.tmp` holding the real data.
fn simulate_restore_interrupted_after_moving_db_aside(db: &Path, staged_contents: &Path) {
    std::fs::copy(staged_contents, restore_staging_path(db)).unwrap();
    std::fs::rename(db, corrupt_path(db)).unwrap();
}

#[tokio::test]
async fn resume_finishes_a_restore_interrupted_before_the_final_rename() {
    let dir = temp_dir("resume-restore");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;
    assert!(backup_database(&db).await.unwrap());

    simulate_restore_interrupted_after_moving_db_aside(&db, &backup_path(&db));

    // The state a crash leaves behind. No database, but the staged snapshot is right there.
    // Opening the pool now would create_if_missing a fresh, empty one.
    assert!(!db.exists());
    assert!(restore_staging_path(&db).exists());

    assert!(resume_interrupted_restore(&db).unwrap());

    // The database is back with its data, and the staging file is consumed.
    assert_eq!(read_single_value(&db).await, "hello");
    assert!(!restore_staging_path(&db).exists());
}

#[tokio::test]
async fn resume_sets_aside_the_damaged_databases_log_before_renaming_the_snapshot_in() {
    // A restore that died right after moving the database aside left its `-wal` under the live
    // name. Renamed in beside it, the snapshot would have the damaged database's frames replayed
    // into it on the next open.
    let dir = temp_dir("resume-restore-wal");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;
    assert!(backup_database(&db).await.unwrap());

    simulate_restore_interrupted_after_moving_db_aside(&db, &backup_path(&db));
    std::fs::write(
        dir.join("kavynex.db-wal"),
        b"frames of the damaged database",
    )
    .unwrap();
    std::fs::write(dir.join("kavynex.db-shm"), b"index").unwrap();

    assert!(resume_interrupted_restore(&db).unwrap());

    assert!(!dir.join("kavynex.db-wal").exists());
    assert!(!dir.join("kavynex.db-shm").exists());
    assert_eq!(
        std::fs::read(restore::corrupt_wal_path(&db)).unwrap(),
        b"frames of the damaged database"
    );
    assert_eq!(read_single_value(&db).await, "hello");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_copy_cut_short_is_never_resumed_into_the_database() {
    // A restore offered for a missing database died while copying the snapshot. Under the staging
    // name, the next launch would have renamed the partial copy in as the database.
    let dir = temp_dir("resume-partial");
    let db = dir.join("kavynex.db");
    std::fs::write(
        restore::restore_partial_path(&db),
        b"the first half of a snapshot",
    )
    .unwrap();

    assert!(!resume_interrupted_restore(&db).unwrap());
    assert!(!db.exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn resume_is_a_noop_on_a_normal_launch() {
    let dir = temp_dir("resume-noop");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;

    // No staging file: nothing was interrupted.
    assert!(!resume_interrupted_restore(&db).unwrap());
    assert_eq!(read_single_value(&db).await, "hello");

    // A staging file left over while the database is present must not clobber the live
    // database, only the "database missing" state is the interrupted one.
    std::fs::write(restore_staging_path(&db), b"not a database").unwrap();
    assert!(!resume_interrupted_restore(&db).unwrap());
    assert_eq!(read_single_value(&db).await, "hello");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn an_interrupted_import_already_resumes_itself() {
    // Unlike the restore path, an import interrupted in the same window needs no help. Its
    // staging file is `.import-staged`, which apply_pending_database_import already looks for
    // at startup, and it skips the move-aside when the database is missing. Pinned so the
    // asymmetry is a documented fact rather than something to be re-derived.
    let dir = temp_dir("import-resumes");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    let source = dir.join("incoming.db");
    seed_kavynex_db(&source, "imported").await;
    stage_database_import(&db, &source, None).await.unwrap();

    // Crash after the database was moved aside, before the staged file was renamed in.
    std::fs::rename(&db, pre_import_path(&db)).unwrap();
    assert!(!db.exists());

    assert!(apply_pending_database_import(&db).unwrap());
    assert_eq!(read_video_title(&db).await, "imported");

    // The interrupted run left `.pre-import` holding the *only* copy of the previous
    // database (the move-aside above is a rename, not a copy). Applying the staged import
    // must not consume it. Without this, the undo snapshot (and with it the user's whole
    // previous library) is deleted here with no way back, since the resume path never
    // repopulates it.
    assert!(pre_import_path(&db).exists());
    assert_eq!(read_video_title(&pre_import_path(&db)).await, "current");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn an_import_retried_after_a_failed_swap_keeps_the_real_pre_import_snapshot() {
    // The state left by a swap that failed *and* whose rollback also failed. The database was
    // moved aside into `.pre-import` (the only copy of the user's library), the staged import
    // never made it in, and the app then carried on and let the pool create an empty
    // `kavynex.db` in its place. On the next launch this function runs again and sees a
    // database file. The empty one. Without the marker it cannot tell that state apart from a
    // normal second import, consumes `.pre-import` for the empty file, and the library is gone
    // permanently with no undo left. Same class as the crash the test above pins, one restart
    // later.
    let dir = temp_dir("import-retry-after-failed-swap");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    let source = dir.join("incoming.db");
    seed_kavynex_db(&source, "imported").await;
    stage_database_import(&db, &source, None).await.unwrap();

    // The failed swap. Database moved aside, marker still in place because the rollback did
    // not get it back.
    write_import_applying_marker(&import_applying_marker_path(&db)).unwrap();
    std::fs::rename(&db, pre_import_path(&db)).unwrap();
    // The app kept running and the pool created a fresh empty database in its place.
    seed_kavynex_db(&db, "empty interim database").await;

    assert!(apply_pending_database_import(&db).unwrap());
    assert_eq!(read_video_title(&db).await, "imported");

    // The undo copy must still be the user's real database, not the interim file.
    assert!(pre_import_path(&db).exists());
    assert_eq!(read_video_title(&pre_import_path(&db)).await, "current");
    // A completed swap clears the marker, so the next import behaves normally again.
    assert!(!import_applying_marker_path(&db).exists());
    // The interim file is set aside, not discarded, in case it held more than the marker claimed.
    let displaced = displaced_databases(&db);
    assert_eq!(displaced.len(), 1);
    assert_eq!(
        read_video_title(&displaced[0]).await,
        "empty interim database"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

fn displaced_databases(db: &std::path::Path) -> Vec<std::path::PathBuf> {
    let prefix = format!("{}.displaced-", db.file_name().unwrap().to_string_lossy());

    std::fs::read_dir(db.parent().unwrap())
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            name.starts_with(&prefix) && !name.ends_with("-wal") && !name.ends_with("-shm")
        })
        .collect()
}

#[tokio::test]
async fn a_marker_left_behind_by_a_completed_import_never_destroys_the_database_in_use() {
    // The marker's removal after a completed swap can fail (a scanner holding the file it just
    // created). The next launches then see a marker, a `.pre-import` and no staged file, the same
    // shape a swap that died with its staged file lost leaves. The database at db_path is the
    // imported one with whatever was done in it since, and it has to survive the recovery.
    let dir = temp_dir("stale-import-marker");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    let source = dir.join("incoming.db");
    seed_kavynex_db(&source, "imported").await;
    stage_database_import(&db, &source, None).await.unwrap();
    assert!(apply_pending_database_import(&db).unwrap());

    // The removal that failed, and days of use of the imported database.
    write_import_applying_marker(&import_applying_marker_path(&db)).unwrap();
    rename_video_title(&db, "imported and used for days").await;

    assert!(!apply_pending_database_import(&db).unwrap());

    let displaced = displaced_databases(&db);
    assert_eq!(displaced.len(), 1);
    assert_eq!(
        read_video_title(&displaced[0]).await,
        "imported and used for days"
    );
    assert!(!import_applying_marker_path(&db).exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_stranded_pre_import_is_restored_when_the_staged_file_is_gone() {
    // The same failed-swap state as the test above, but the staged import file was additionally
    // lost in that window (external deletion, disk trouble on that file). With no staged file the
    // normal swap can never run, so a bare early return would let the pool create an empty
    // database over `.pre-import`. The only remaining copy of the library. Recovery must instead
    // salvage the snapshot.
    let dir = temp_dir("stranded-pre-import");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    let source = dir.join("incoming.db");
    seed_kavynex_db(&source, "imported").await;
    stage_database_import(&db, &source, None).await.unwrap();

    // Failed swap. Marker written, database moved aside into `.pre-import`.
    write_import_applying_marker(&import_applying_marker_path(&db)).unwrap();
    std::fs::rename(&db, pre_import_path(&db)).unwrap();
    // Then the staged file is lost and the pool created an empty interim database in its place.
    std::fs::remove_file(import_staged_path(&db)).unwrap();
    seed_kavynex_db(&db, "empty interim database").await;

    // No import is applied (the staged file is gone), but the snapshot is salvaged. The real
    // library is back at db_path, the undo copy is consumed, and the marker is cleared.
    assert!(!apply_pending_database_import(&db).unwrap());
    assert_eq!(read_video_title(&db).await, "current");
    assert!(!pre_import_path(&db).exists());
    assert!(!import_applying_marker_path(&db).exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_log_left_without_its_database_is_not_paired_with_the_stranded_snapshot() {
    // An earlier recovery set the database aside and then failed to move its log, so the log is
    // still under the live name with nothing beside it. Renaming the snapshot in next to it would
    // pair the two.
    let dir = temp_dir("stranded-orphan-wal");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;
    write_import_applying_marker(&import_applying_marker_path(&db)).unwrap();
    std::fs::rename(&db, pre_import_path(&db)).unwrap();
    std::fs::write(sibling(&db, "-wal"), b"a log belonging to another file").unwrap();

    assert!(!apply_pending_database_import(&db).unwrap());

    assert!(
        !sibling(&db, "-wal").exists(),
        "the orphaned log was moved away"
    );
    assert!(
        std::fs::read_dir(&dir).unwrap().any(|entry| {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            name.starts_with("kavynex.db.displaced-") && name.ends_with("-wal")
        }),
        "and kept rather than deleted"
    );
    assert_eq!(read_video_title(&db).await, "current");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_restore_ignores_a_journal_an_earlier_attempt_left_beside_its_staging_file() {
    let dir = temp_dir("restore-stale-journal");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "kept").await;
    assert!(backup_database(&db).await.unwrap());
    std::fs::write(&db, b"not a database").unwrap();
    std::fs::write(
        sibling(&restore_staging_path(&db), "-journal"),
        b"a hot journal from another copy",
    )
    .unwrap();

    restore_database_from_backup(&db).await.unwrap();

    assert!(!sibling(&restore_staging_path(&db), "-journal").exists());
    assert_eq!(read_video_title(&db).await, "kept");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_marker_with_no_snapshot_behind_it_never_skips_the_move_aside() {
    // The other half of the marker's contract, and the one that decides whether it is safe to
    // act on at all. The marker only means "`.pre-import` holds the user's database" because
    // it is written *after* the move-aside succeeds. Written before it, it would also be there
    // in the window where that rename had not run yet, and there `db_path` is still the real
    // library rather than the pool's empty file, so treating the marker as a recovery signal
    // would skip the move-aside and let the swap below overwrite the library outright, with
    // nothing in `.pre-import` to undo it with.
    //
    // The ordering makes that state unreachable; requiring `.pre-import` to actually exist is
    // what keeps it survivable if it shows up anyway (a rollback that restored the database but
    // failed to clear the marker leaves exactly this).
    let dir = temp_dir("import-marker-without-snapshot");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    let source = dir.join("incoming.db");
    seed_kavynex_db(&source, "imported").await;
    stage_database_import(&db, &source, None).await.unwrap();

    // A marker claiming a move-aside that never happened. The database is untouched and there
    // is no snapshot behind the claim.
    write_import_applying_marker(&import_applying_marker_path(&db)).unwrap();
    assert!(!pre_import_path(&db).exists());

    assert!(apply_pending_database_import(&db).unwrap());
    assert_eq!(read_video_title(&db).await, "imported");

    // The library that was sitting at `db_path` has to have been set aside rather than
    // overwritten, so the import stays undoable.
    assert!(pre_import_path(&db).exists());
    assert_eq!(read_video_title(&pre_import_path(&db)).await, "current");
    assert!(!import_applying_marker_path(&db).exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_move_aside_whose_marker_cannot_be_written_is_rolled_back() {
    // The move-aside now runs before the marker, so a failure to write the marker leaves the
    // database already set aside with nothing recording that fact. Returning the error there
    // and walking away would leave `db_path` missing, and the app carries on past a failed
    // import (lib.rs only logs), so the pool would create an empty database in its place and
    // the next run would read that as an ordinary second import and consume `.pre-import`,
    // the only copy. Undoing the move-aside is what keeps the failure inert.
    let dir = temp_dir("import-marker-write-fails");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    let source = dir.join("incoming.db");
    seed_kavynex_db(&source, "imported").await;
    stage_database_import(&db, &source, None).await.unwrap();

    // A directory sitting on the marker path is something `File::create` cannot write over,
    // which fails the marker write without touching anything else.
    std::fs::create_dir(import_applying_marker_path(&db)).unwrap();

    assert!(apply_pending_database_import(&db).is_err());

    // The database has to be back where it was, still holding the user's library, with the
    // import left pending rather than half-applied.
    assert!(db.exists());
    assert_eq!(read_video_title(&db).await, "current");
    assert!(!pre_import_path(&db).exists());
    assert!(import_staged_path(&db).exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn the_undo_copy_keeps_what_a_crashed_run_left_in_the_write_ahead_log() {
    // A run that did not exit cleanly leaves its last transactions in `-wal`, not yet folded into
    // the file. The import moves the file aside as the undo copy, and the log has to go with it.
    let dir = temp_dir("import-crashed-wal");
    let db = dir.join("kavynex.db");
    let live = dir.join("live.db");
    seed_kavynex_db(&live, "checkpointed").await;

    let options = SqliteConnectOptions::new()
        .filename(&live)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::query("PRAGMA wal_autocheckpoint = 0")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE videos SET title = 'only in the log'")
        .execute(&pool)
        .await
        .unwrap();

    // Copied while the connection is still open, which is what a crash leaves on disk.
    std::fs::copy(&live, &db).unwrap();
    std::fs::copy(sibling(&live, "-wal"), sibling(&db, "-wal")).unwrap();
    pool.close().await;

    let source = dir.join("imported.db");
    seed_kavynex_db(&source, "imported").await;
    stage_database_import(&db, &source, None).await.unwrap();
    assert!(apply_pending_database_import(&db).unwrap());

    assert_eq!(read_video_title(&db).await, "imported");
    assert_eq!(
        read_video_title(&pre_import_path(&db)).await,
        "only in the log"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_normal_second_import_still_replaces_the_previous_undo_snapshot() {
    // The counterpart to the test above, and the reason the marker exists rather than a plain
    // "does `.pre-import` exist?" check. On disk, a second import looks exactly like the
    // recovery state (staged import + `.pre-import` + a file at db_path). This one *must*
    // consume the old undo copy. Skipping the move-aside here would let the swap overwrite
    // the user's live database with no undo at all.
    let dir = temp_dir("import-second-normal");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "first").await;
    record_new_lineage(&db);
    let first_lineage = lineage::database_lineage(&db).unwrap();

    let first_source = dir.join("second.db");
    seed_kavynex_db(&first_source, "second").await;
    stage_database_import(&db, &first_source, None)
        .await
        .unwrap();
    assert!(apply_pending_database_import(&db).unwrap());
    assert_eq!(read_video_title(&pre_import_path(&db)).await, "first");

    // The imported library is not the one the external copies were made from.
    assert_ne!(lineage::database_lineage(&db).unwrap(), first_lineage);

    let second_source = dir.join("third.db");
    seed_kavynex_db(&second_source, "third").await;
    stage_database_import(&db, &second_source, None)
        .await
        .unwrap();
    assert!(apply_pending_database_import(&db).unwrap());

    assert_eq!(read_video_title(&db).await, "third");
    // The undo copy tracks the *last* import, so it is now the database this import replaced.
    assert_eq!(read_video_title(&pre_import_path(&db)).await, "second");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn import_rejects_a_namesake_database_whose_columns_are_wrong() {
    // The four table names with the wrong columns. Another app's namesake schema, a
    // hand-edited file, a half-finished migration. Stamped at this build's SCHEMA_VERSION,
    // so ensure_schema would consider it current and repair nothing. It would swap in
    // cleanly and then fail with "no such column" on the first query, after the previous
    // database had already been set aside. It has to be refused here instead.
    let dir = temp_dir("import-wrong-columns");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    let source = dir.join("namesake.db");
    let options = SqliteConnectOptions::new()
        .filename(&source)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();

    for ddl in [
        "CREATE TABLE channels (id INTEGER PRIMARY KEY, label TEXT)",
        "CREATE TABLE videos (id INTEGER PRIMARY KEY, name TEXT)",
        "CREATE TABLE video_comments (id INTEGER PRIMARY KEY, body TEXT)",
        "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)",
    ] {
        sqlx::query(ddl).execute(&pool).await.unwrap();
    }

    sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA user_version = {}",
        crate::services::db_schema::SCHEMA_VERSION
    )))
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    let error = stage_database_import(&db, &source, None).await.unwrap_err();
    assert_eq!(error.code, AppErrorCode::DatabaseImportInvalid.as_str());

    // Nothing was staged, so the next startup has no import to apply.
    assert!(!import_staged_path(&db).exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn import_rejects_a_database_missing_the_media_unique_key() {
    // Right tables, right columns, stamped current, but the (channel_id, file_path) unique
    // key that insert_media's ON CONFLICT upsert targets is absent. Accepting it would swap in
    // a database on which every media insert then fails at runtime, so it is refused here (a
    // column check alone cannot see the missing constraint).
    let dir = temp_dir("import-no-unique");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    let source = dir.join("namesake.db");
    seed_namesake_with_videos_ddl(
        &source,
        "CREATE TABLE videos (id INTEGER PRIMARY KEY, channel_id INTEGER, file_path TEXT, \
         media_type TEXT, \
         FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE)",
    )
    .await;

    let error = stage_database_import(&db, &source, None).await.unwrap_err();
    assert_eq!(error.code, AppErrorCode::DatabaseImportInvalid.as_str());
    assert!(!import_staged_path(&db).exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn import_rejects_a_database_missing_the_channel_cascade() {
    // Right tables, right columns, the unique key present, but no videos -> channels
    // ON DELETE CASCADE. Accepting it would let a later channel delete orphan that channel's
    // videos and their comments, since PRAGMA foreign_keys can only enforce a foreign key the
    // DDL declares and never adds a missing one, so it is refused here.
    let dir = temp_dir("import-no-cascade");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    let source = dir.join("namesake.db");
    seed_namesake_with_videos_ddl(
        &source,
        "CREATE TABLE videos (id INTEGER PRIMARY KEY, channel_id INTEGER, file_path TEXT, \
         media_type TEXT, UNIQUE (channel_id, file_path))",
    )
    .await;

    let error = stage_database_import(&db, &source, None).await.unwrap_err();
    assert_eq!(error.code, AppErrorCode::DatabaseImportInvalid.as_str());
    assert!(!import_staged_path(&db).exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn import_rejects_a_database_missing_the_comment_cascade() {
    // Right tables, right columns, both videos constraints present, but no
    // video_comments -> videos ON DELETE CASCADE. Accepting it would let a later media delete
    // (a bare DELETE FROM videos, see library::cleanup) orphan that media's comment rows
    // forever, with nothing in the library diagnostics to reconcile them. PRAGMA foreign_keys
    // can only enforce a cascade the DDL declares and never adds a missing one, so it is
    // refused here alongside the two videos constraints.
    let dir = temp_dir("import-no-comment-cascade");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    let source = dir.join("namesake.db");
    seed_namesake_with_comments_ddl(
        &source,
        "CREATE TABLE video_comments (id INTEGER PRIMARY KEY, video_id INTEGER, text TEXT)",
    )
    .await;

    let error = stage_database_import(&db, &source, None).await.unwrap_err();
    assert_eq!(error.code, AppErrorCode::DatabaseImportInvalid.as_str());
    assert!(!import_staged_path(&db).exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn restore_reaches_a_snapshot_stranded_in_the_backup_temp_file() {
    // backup_database vacuums into `.bak.tmp` and only renames it into `.bak` once that
    // succeeds. A run that died in that window leaves a complete, healthy snapshot there that
    // nothing else would ever look at, so with no other generation on disk the restore used
    // to report "no backup available" while a good one sat right next to the database.
    let dir = temp_dir("backup-temp-orphan");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "corrupted").await;
    seed_kavynex_db(&temp_backup_path(&db), "stranded").await;

    assert!(!backup_path(&db).exists());

    restore_database_from_backup(&db).await.unwrap();

    assert_eq!(read_video_title(&db).await, "stranded");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn restore_prefers_a_real_generation_over_the_backup_temp_file() {
    // `.bak.tmp` is also where a run that died *during* the vacuum leaves a partial file, and
    // nothing here can tell that apart from the complete one above. So it is the last resort,
    // never preferred over a real generation, even though it would be the fresher of the two.
    let dir = temp_dir("backup-temp-order");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "corrupted").await;
    seed_kavynex_db(&backup_path(&db), "rotated-generation").await;
    seed_kavynex_db(&temp_backup_path(&db), "stranded").await;

    restore_database_from_backup(&db).await.unwrap();

    assert_eq!(read_video_title(&db).await, "rotated-generation");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn restore_fails_when_no_backup_exists() {
    let dir = temp_dir("restore-none");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;

    let error = restore_database_from_backup(&db).await.unwrap_err();
    assert_eq!(error.code, AppErrorCode::NoDatabaseBackupAvailable.as_str());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn restore_falls_back_to_rotated_backup_when_primary_is_corrupt() {
    let dir = temp_dir("restore-rotated");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;

    // First backup becomes the rotated generation after a second run.
    assert!(backup_database(&db).await.unwrap());
    // Force a second, non-throttled backup so the first rotates to .bak.1.
    let old = SystemTime::now() - std::time::Duration::from_secs(BACKUP_MIN_INTERVAL_SECS * 2);
    filetime_set(&backup_path(&db), old);
    assert!(backup_database(&db).await.unwrap());

    // Corrupt the current .bak so restore must fall back to the rotated .bak.1.
    std::fs::write(backup_path(&db), b"corrupt bak").unwrap();
    std::fs::write(&db, b"corrupt db").unwrap();

    restore_database_from_backup(&db).await.unwrap();
    assert_eq!(read_single_value(&db).await, "hello");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn restore_refuses_a_backup_with_a_newer_schema_version() {
    let dir = temp_dir("restore-newer-schema");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;
    assert!(backup_database(&db).await.unwrap());

    // Stamp the healthy backup with a schema version newer than this build supports.
    let options = SqliteConnectOptions::new().filename(backup_path(&db));
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA user_version = {}",
        crate::services::db_schema::SCHEMA_VERSION + 1
    )))
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    // Corrupt the live database so a restore is attempted.
    std::fs::write(&db, b"corrupt db").unwrap();

    // The only backup is from a newer schema, so restore fails up front with a clear code
    // instead of "succeeding" into a database the next open would reject.
    let error = restore_database_from_backup(&db).await.unwrap_err();
    assert_eq!(error.code, AppErrorCode::DatabaseSchemaTooNew.as_str());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn restore_accepts_a_backup_at_the_current_schema_version() {
    // The boundary of the newer-schema refusal. A backup stamped at exactly SCHEMA_VERSION is
    // this build's own and must be restored, not skipped. Pins the `>` in the version gate
    // against a `>=` that would refuse a current-version backup and fail the recovery.
    let dir = temp_dir("restore-current-schema");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;
    assert!(backup_database(&db).await.unwrap());

    let options = SqliteConnectOptions::new().filename(backup_path(&db));
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA user_version = {}",
        crate::services::db_schema::SCHEMA_VERSION
    )))
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    std::fs::write(&db, b"corrupt db").unwrap();

    restore_database_from_backup(&db)
        .await
        .expect("a backup at the current schema version must be restored");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn import_accepts_a_normalized_current_schema_database() {
    // A v>=11 database whose rows are all normalized (unnormalized == 0) is a valid import and
    // must be accepted. Pins the `> 0` count check against a `>= 0`, which (being true for
    // every count) would reject every modern database as if its titles were never computed.
    let dir = temp_dir("import-normalized-current");
    let db = dir.join("kavynex.db");
    let source = dir.join("incoming.db");

    let options = SqliteConnectOptions::new()
        .filename(&source)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    for ddl in [
        "CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, youtube_handle TEXT)",
        "CREATE TABLE videos (id INTEGER PRIMARY KEY, channel_id INTEGER, title TEXT, \
         title_normalized TEXT, file_path TEXT, media_type TEXT, \
         FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE, \
         UNIQUE (channel_id, file_path))",
        "CREATE TABLE video_comments (id INTEGER PRIMARY KEY, video_id INTEGER, text TEXT, \
         original_text TEXT, \
         FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE)",
        "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)",
        // A single fully-normalized row, so COUNT(title_normalized IS NULL) is zero.
        "INSERT INTO videos (title, title_normalized) VALUES ('clip', 'clip')",
    ] {
        sqlx::query(ddl).execute(&pool).await.unwrap();
    }
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA user_version = {}",
        crate::services::db_schema::SCHEMA_VERSION
    )))
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    stage_database_import(&db, &source, None)
        .await
        .expect("a normalized current-schema database must import");
    assert!(import_staged_path(&db).exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn import_rejects_a_live_chat_flag_with_no_stored_path() {
    // A database stamped at v13+ (so the swap would skip the migration that enforces it) with a
    // row flagged has_live_chat = 1 but no live_chat_file_path violates the invariant an import
    // cannot repair, and must be refused rather than swapped in, mirroring the title_normalized
    // gate for the sibling invariant from the same migration.
    let dir = temp_dir("import-live-chat-flag-no-path");
    let db = dir.join("kavynex.db");
    let source = dir.join("incoming.db");

    let options = SqliteConnectOptions::new()
        .filename(&source)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    for ddl in [
        "CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, youtube_handle TEXT)",
        "CREATE TABLE videos (id INTEGER PRIMARY KEY, channel_id INTEGER, title TEXT, \
         title_normalized TEXT, file_path TEXT, media_type TEXT, has_live_chat INTEGER, \
         live_chat_file_path TEXT, \
         FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE, \
         UNIQUE (channel_id, file_path))",
        "CREATE TABLE video_comments (id INTEGER PRIMARY KEY, video_id INTEGER, text TEXT, \
         original_text TEXT, \
         FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE)",
        "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)",
        // Flagged as having a live chat, but with no path behind it. The exact state the
        // invariant rejects.
        "INSERT INTO videos (title, title_normalized, has_live_chat, live_chat_file_path) \
         VALUES ('clip', 'clip', 1, NULL)",
    ] {
        sqlx::query(ddl).execute(&pool).await.unwrap();
    }
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA user_version = {}",
        crate::services::db_schema::SCHEMA_VERSION
    )))
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    let error = stage_database_import(&db, &source, None)
        .await
        .expect_err("a live-chat flag with no stored path must be refused");
    assert_eq!(
        error.code,
        crate::AppErrorCode::DatabaseImportInvalid.as_str()
    );
    assert!(!import_staged_path(&db).exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn import_accepts_a_live_chat_flag_with_a_stored_path() {
    // The mirror of the reject test above. A v13+ database whose live-chat invariant holds (a
    // flagged row has its stored path, an unflagged row is fine) has zero violating rows and
    // must import. Pins the `flagged_without_path > 0` count check against a `>= 0`, which, being
    // true for every count, would reject every valid modern database as if its live chats had no
    // files. The reject test uses a violating row (count >= 1), where `> 0` and `>= 0` agree, so
    // only this zero-count case tells them apart.
    let dir = temp_dir("import-live-chat-flag-with-path");
    let db = dir.join("kavynex.db");
    let source = dir.join("incoming.db");

    let options = SqliteConnectOptions::new()
        .filename(&source)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    for ddl in [
        "CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, youtube_handle TEXT)",
        "CREATE TABLE videos (id INTEGER PRIMARY KEY, channel_id INTEGER, title TEXT, \
         title_normalized TEXT, file_path TEXT, media_type TEXT, has_live_chat INTEGER, \
         live_chat_file_path TEXT, \
         FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE, \
         UNIQUE (channel_id, file_path))",
        "CREATE TABLE video_comments (id INTEGER PRIMARY KEY, video_id INTEGER, text TEXT, \
         original_text TEXT, \
         FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE)",
        "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)",
        // A flagged row with a real path, and an unflagged row. Both satisfy the invariant, so
        // the flagged-without-path count is zero.
        "INSERT INTO videos (title, title_normalized, has_live_chat, live_chat_file_path) \
         VALUES ('clip', 'clip', 1, 'live_chat/clip.live_chat.json.gz')",
        "INSERT INTO videos (title, title_normalized, has_live_chat, live_chat_file_path) \
         VALUES ('other', 'other', 0, NULL)",
    ] {
        sqlx::query(ddl).execute(&pool).await.unwrap();
    }
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA user_version = {}",
        crate::services::db_schema::SCHEMA_VERSION
    )))
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    stage_database_import(&db, &source, None)
        .await
        .expect("a live-chat flag with a stored path must import");
    assert!(import_staged_path(&db).exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn import_accepts_a_v13_database_that_lacks_the_live_chat_path_column() {
    // The live-chat invariant is only checked when *both* has_live_chat and live_chat_file_path
    // columns exist (neither is in the required-columns spot-check, so a minimal look-alike
    // stamped at a high version can reach the check without them). A database that has
    // has_live_chat but not live_chat_file_path must import, because the invariant query would
    // reference a column that is not there. Pins the `has_flag && has_path` guard against an
    // `||`, which would enter the block and error on the missing column instead of skipping it.
    let dir = temp_dir("import-live-chat-no-path-column");
    let db = dir.join("kavynex.db");
    let source = dir.join("incoming.db");

    let options = SqliteConnectOptions::new()
        .filename(&source)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    for ddl in [
        "CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, youtube_handle TEXT)",
        // has_live_chat is present, live_chat_file_path deliberately is not.
        "CREATE TABLE videos (id INTEGER PRIMARY KEY, channel_id INTEGER, title TEXT, \
         title_normalized TEXT, file_path TEXT, media_type TEXT, has_live_chat INTEGER, \
         FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE, \
         UNIQUE (channel_id, file_path))",
        "CREATE TABLE video_comments (id INTEGER PRIMARY KEY, video_id INTEGER, text TEXT, \
         original_text TEXT, \
         FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE)",
        "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)",
        "INSERT INTO videos (title, title_normalized, has_live_chat) VALUES ('clip', 'clip', 0)",
    ] {
        sqlx::query(ddl).execute(&pool).await.unwrap();
    }
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA user_version = {}",
        crate::services::db_schema::SCHEMA_VERSION
    )))
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    stage_database_import(&db, &source, None)
        .await
        .expect("a database without the live_chat_file_path column must import");
    assert!(import_staged_path(&db).exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn mirror_keeps_an_intact_recent_mirror_and_ignores_a_leftover_staged_copy() {
    // The counterpart to mirror_adopts_a_recent_stranded_staged_copy. When the current mirror is
    // already present (and recent), a leftover staged file beside it must be ignored, never
    // renamed over the intact mirror. Adoption only fires when current is *missing*; pins the
    // `!current.exists() && staged.exists()` guard against an `||`, which would clobber the good
    // mirror with the leftover staged copy.
    let dir = temp_dir("ext-intact-src");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;

    let external = temp_dir("ext-intact-dest");
    let current = external_backup_path(&external);
    let staged = external.join(format!("{EXTERNAL_BACKUP_FILE_NAME}.new"));
    std::fs::write(&current, b"intact-mirror").unwrap();
    std::fs::write(&staged, b"leftover-staged").unwrap();

    // The current mirror is fresh, so the throttle skips a new export; the assertion is about
    // which bytes survive, not whether an export ran.
    assert!(!mirror_database_to_external_dir(&db, &external)
        .await
        .unwrap());

    // The intact mirror is preserved and the leftover staged copy was not adopted over it.
    assert_eq!(std::fs::read(&current).unwrap(), b"intact-mirror");

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&external);
}

#[tokio::test]
async fn backup_status_reports_the_snapshot_modified_time() {
    // The reported timestamp must be the backup file's real mtime, not a fixed sentinel. A
    // freshly written snapshot is far more recent than the epoch, so a mutant returning Some(0)
    // or Some(1) is caught by requiring a plausibly-recent value.
    let dir = temp_dir("backup-status-mtime");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;
    assert!(backup_database(&db).await.unwrap());

    let status = database_backup_status(&db);
    assert!(status.available);
    // 2020-01-01 in ms; any real backup taken now is well past it, epoch-based sentinels are not.
    assert!(
        status
            .backed_up_at_ms
            .is_some_and(|ms| ms > 1_577_836_800_000),
        "backup timestamp must be the file's real mtime, got {:?}",
        status.backed_up_at_ms
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn backup_min_interval_is_twenty_four_hours() {
    // Pin the throttle window's value so an accidental change to the `24 * 60 * 60` arithmetic
    // (which nothing else asserts exactly) is caught.
    assert_eq!(BACKUP_MIN_INTERVAL_SECS, 86_400);
}

#[tokio::test]
async fn apply_pending_does_not_revert_a_leftover_undo_snapshot() {
    // After a completed import, `.pre-import` persists as the undo snapshot with no marker and
    // no staged file. On the next startup apply_pending must do nothing. A mutant recovering on
    // `marker OR pre_import` (instead of AND) would restore that snapshot over the live database
    // on every launch, silently reverting the user's data.
    let dir = temp_dir("apply-leftover-pre-import");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "live").await;
    seed_kavynex_db(&pre_import_path(&db), "old undo").await;

    assert!(!apply_pending_database_import(&db).unwrap());

    assert_eq!(read_video_title(&db).await, "live");
    assert!(
        pre_import_path(&db).exists(),
        "a leftover undo snapshot must be left untouched"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

async fn seed_kavynex_db(path: &Path, title: &str) {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    // Import validation requires every core table, the columns each is queried through, and
    // the constraints the app relies on at runtime (the (channel_id, file_path) unique key
    // behind insert_media's upsert, the videos -> channels ON DELETE CASCADE, and the
    // video_comments -> videos ON DELETE CASCADE), so a representative kavynex database in
    // tests must carry all of them. Still a reduced shape otherwise (only the columns the
    // validation names, no extra indexes), since these tests are about the file swap, not the
    // full schema.
    for ddl in [
        "CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, youtube_handle TEXT)",
        "CREATE TABLE videos (id INTEGER PRIMARY KEY, channel_id INTEGER, title TEXT, \
         file_path TEXT, media_type TEXT, \
         FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE, \
         UNIQUE (channel_id, file_path))",
        "CREATE TABLE video_comments (id INTEGER PRIMARY KEY, video_id INTEGER, text TEXT, \
         original_text TEXT, \
         FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE)",
        "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)",
    ] {
        sqlx::query(ddl).execute(&pool).await.unwrap();
    }
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO videos (title) VALUES ('{title}')"
    )))
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;
}

// Builds a namesake database whose four core tables all carry the required columns and which
// is stamped at this build's SCHEMA_VERSION (so ensure_schema would treat it as current and
// repair nothing), letting a test vary only the videos DDL to probe a single missing
// constraint the column check cannot catch.
// The `videos` and `video_comments` DDL a valid kavynex database carries. The three
// constraints import validation requires (the (channel_id, file_path) unique key, the
// videos -> channels cascade, and the video_comments -> videos cascade). A namesake test
// seeds one of these in its varied, constraint-missing form and the rest as valid, so the
// rejection it asserts can only come from the constraint under test.
const VALID_VIDEOS_DDL: &str = "CREATE TABLE videos (id INTEGER PRIMARY KEY, channel_id \
     INTEGER, file_path TEXT, media_type TEXT, \
     FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE, \
     UNIQUE (channel_id, file_path))";
const VALID_COMMENTS_DDL: &str = "CREATE TABLE video_comments (id INTEGER PRIMARY KEY, \
     video_id INTEGER, text TEXT, \
     FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE)";

async fn seed_namesake(source: &Path, videos_ddl: &str, comments_ddl: &str) {
    let options = SqliteConnectOptions::new()
        .filename(source)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();

    sqlx::query("CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, youtube_handle TEXT)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(videos_ddl))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(comments_ddl))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA user_version = {}",
        crate::services::db_schema::SCHEMA_VERSION
    )))
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;
}

/// A namesake database whose `videos` DDL is varied (to omit a constraint under test) while
/// every other table carries the shape a valid kavynex database has.
async fn seed_namesake_with_videos_ddl(source: &Path, videos_ddl: &str) {
    seed_namesake(source, videos_ddl, VALID_COMMENTS_DDL).await;
}

/// A namesake database whose `video_comments` DDL is varied (to omit the cascade under test)
/// while every other table carries the shape a valid kavynex database has.
async fn seed_namesake_with_comments_ddl(source: &Path, comments_ddl: &str) {
    seed_namesake(source, VALID_VIDEOS_DDL, comments_ddl).await;
}

async fn read_video_title(path: &Path) -> String {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    let (title,): (String,) = sqlx::query_as("SELECT title FROM videos LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    pool.close().await;
    title
}

async fn rename_video_title(path: &Path, title: &str) {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::query("UPDATE videos SET title = ?")
        .bind(title)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}

#[tokio::test]
async fn export_creates_importable_snapshot() {
    let dir = temp_dir("export");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "hello").await;

    let dest = dir.join("exported.db");
    export_database(&db, &dest).await.unwrap();

    assert!(dest.exists());
    assert_eq!(read_video_title(&dest).await, "hello");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn export_overwrites_an_existing_destination_via_the_staging_path() {
    let dir = temp_dir("export_overwrite");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "fresh").await;

    let dest = dir.join("exported.db");
    std::fs::write(&dest, b"stale export contents").unwrap();

    export_database(&db, &dest).await.unwrap();

    assert_eq!(read_video_title(&dest).await, "fresh");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn export_preserves_existing_destination_when_vacuum_fails() {
    let dir = temp_dir("export_fail");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "hello").await;

    let dest = dir.join("exported.db");
    std::fs::write(&dest, b"previous export contents").unwrap();

    // The staging path (a sibling of dest_path) is a directory rather than a regular
    // file, so `VACUUM INTO` cannot write to it and the export fails, without ever
    // touching the pre-existing destination file.
    let staging = sibling(&dest, ".export-staging");
    std::fs::create_dir_all(&staging).unwrap();

    let error = export_database(&db, &dest).await.unwrap_err();
    assert_eq!(error.code, AppErrorCode::AppError.as_str());

    assert_eq!(std::fs::read(&dest).unwrap(), b"previous export contents");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn escape_sql_literal_doubles_single_quotes() {
    assert_eq!(escape_sql_literal("O'Brien"), "O''Brien");
    assert_eq!(escape_sql_literal("a'b'c"), "a''b''c");
    assert_eq!(escape_sql_literal("no quotes"), "no quotes");

    // Adversarial paths. A classic break-out attempt and an already-doubled quote must both
    // be neutralized to an even number of quotes, so the value can only ever be data inside
    // the literal, never the start of a new clause. Backslashes are not SQL-significant in
    // SQLite string literals and are left untouched.
    assert_eq!(
        escape_sql_literal("'; DROP TABLE videos; --"),
        "''; DROP TABLE videos; --"
    );
    assert_eq!(escape_sql_literal("a'' b"), "a'''' b");
    assert_eq!(
        escape_sql_literal(r"C:\Users\O'Neil\db"),
        r"C:\Users\O''Neil\db"
    );
}

#[tokio::test]
async fn export_handles_a_destination_path_with_a_single_quote() {
    // Regression guard. `VACUUM INTO` cannot bind parameters, so the destination path
    // is interpolated after escaping. A path containing a single quote (e.g. a user
    // named O'Brien) must not break the statement.
    let dir = temp_dir("export_quote");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "hello").await;

    let quoted_dir = dir.join("O'Brien");
    std::fs::create_dir_all(&quoted_dir).unwrap();
    let dest = quoted_dir.join("exported.db");

    export_database(&db, &dest).await.unwrap();

    assert!(dest.exists());
    assert_eq!(read_video_title(&dest).await, "hello");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn database_quick_check_ok_reports_health() {
    let dir = temp_dir("quick_check");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "hello").await;

    // A freshly seeded database passes.
    assert!(database_quick_check_ok(&db).await);

    // A file that is not a database at all is reported unhealthy, so the pool builder's
    // pre-migration gate refuses to migrate over it instead of amplifying the damage.
    let garbage = dir.join("garbage.db");
    std::fs::write(&garbage, b"this is not a sqlite database").unwrap();
    assert!(!database_quick_check_ok(&garbage).await);

    // A missing file is likewise not openable (open uses create_if_missing(false)).
    assert!(!database_quick_check_ok(&dir.join("missing.db")).await);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn pre_migration_retention_keeps_the_one_just_written_and_the_highest_other() {
    assert_eq!(
        pre_migration_versions_to_prune(vec![13, 15, 14], 15, 2),
        vec![13]
    );
    assert_eq!(
        pre_migration_versions_to_prune(vec![15, 14], 15, 2),
        Vec::<i64>::new()
    );
    assert_eq!(
        pre_migration_versions_to_prune(vec![15], 15, 2),
        Vec::<i64>::new()
    );
    assert_eq!(
        pre_migration_versions_to_prune(Vec::new(), 15, 2),
        Vec::<i64>::new()
    );
    assert_eq!(
        pre_migration_versions_to_prune(vec![9, 12, 10, 11], 12, 2),
        vec![10, 9]
    );
    // A database older than the last two upgrades, imported or restored. Its own snapshot stays
    // even though both others have a higher version.
    assert_eq!(
        pre_migration_versions_to_prune(vec![15, 16, 12], 12, 2),
        vec![15]
    );
    assert_eq!(PRE_MIGRATION_SNAPSHOTS_KEPT, 2);
}

#[tokio::test]
async fn a_pre_migration_snapshot_is_written_whatever_the_daily_throttle_says() {
    // The daily .bak is fresh, which made the old path write nothing and leave a rollback point up
    // to a day old. The pre-migration snapshot is the database as it is now.
    let dir = temp_dir("pre_migration");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "before the upgrade").await;
    std::fs::write(backup_path(&db), b"a recent daily snapshot").unwrap();

    let written = snapshot_before_migration(&db, 14).await.unwrap();

    assert_eq!(written, dir.join("kavynex.db.pre-migration-v14"));
    assert!(database_quick_check_ok(&written).await);
    assert!(!dir.join("kavynex.db.pre-migration.tmp").exists());

    // Later upgrades replace older snapshots, never the latest two.
    snapshot_before_migration(&db, 15).await.unwrap();
    snapshot_before_migration(&db, 16).await.unwrap();

    assert!(!dir.join("kavynex.db.pre-migration-v14").exists());
    assert!(dir.join("kavynex.db.pre-migration-v15").exists());
    assert!(dir.join("kavynex.db.pre-migration-v16").exists());

    // An older database brought in after those upgrades. Its snapshot is the rollback point of
    // the migration about to run, so it stays, and the lower of the other two goes.
    let written = snapshot_before_migration(&db, 12).await.unwrap();

    assert!(written.exists());
    assert!(!dir.join("kavynex.db.pre-migration-v15").exists());
    assert!(dir.join("kavynex.db.pre-migration-v16").exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn the_daily_backup_leaves_a_newer_database_alone() {
    // After a downgrade this build cannot open the database or restore a snapshot of it, and the
    // older .bak generations are the only ones it can restore. Rotating new copies in would push
    // them out one a day.
    let dir = temp_dir("downgrade_backup");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "written by a newer build").await;

    {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(&db))
            .await
            .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "PRAGMA user_version = {}",
            crate::services::db_schema::SCHEMA_VERSION + 1
        )))
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
    }

    assert!(!backup_database(&db).await.unwrap());
    assert!(!backup_path(&db).exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn database_quick_check_tells_damage_from_a_file_it_could_not_read() {
    // The live database's gate restores a backup only for the first kind. A file that could not be
    // reached at all (here a missing one, which SQLite answers with CANTOPEN) says nothing about
    // its contents, so it must not read as damaged.
    let dir = temp_dir("quick_check_kinds");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "hello").await;
    assert_eq!(database_quick_check(&db).await, QuickCheck::Healthy);

    let garbage = dir.join("garbage.db");
    std::fs::write(&garbage, b"this is not a sqlite database at all, just text").unwrap();
    assert_eq!(database_quick_check(&garbage).await, QuickCheck::Damaged);

    assert!(matches!(
        database_quick_check(&dir.join("missing.db")).await,
        QuickCheck::Unreadable(_)
    ));

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_quick_check_that_answers_with_a_problem_is_damage() {
    // The other way damage arrives. The file opens and the pragma runs, but its answer is a row
    // naming a problem rather than "ok". A row that violates a CHECK constraint, written with the
    // constraint switched off, is a deterministic one, since quick_check verifies CHECK and
    // NOT NULL.
    let dir = temp_dir("quick_check_answer");
    let db = dir.join("kavynex.db");

    {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&db)
                    .create_if_missing(true),
            )
            .await
            .unwrap();

        for statement in [
            "CREATE TABLE guarded (value INTEGER CHECK (value > 0))",
            "PRAGMA ignore_check_constraints = ON",
            "INSERT INTO guarded (value) VALUES (-1)",
        ] {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }

        pool.close().await;
    }

    assert_eq!(database_quick_check(&db).await, QuickCheck::Damaged);

    let _ = std::fs::remove_dir_all(&dir);
}

/// Holds `path` open with no sharing, the way an antivirus scan or a sync client can on Windows.
#[cfg(windows)]
fn hold_exclusively(path: &std::path::Path) -> std::fs::File {
    use std::os::windows::fs::OpenOptionsExt;

    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(path)
        .unwrap()
}

#[cfg(windows)]
#[tokio::test]
async fn a_database_another_process_holds_is_unreadable_not_damaged() {
    let dir = temp_dir("quick_check_locked");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "hello").await;

    let held = hold_exclusively(&db);
    assert!(matches!(
        database_quick_check(&db).await,
        QuickCheck::Unreadable(_)
    ));
    drop(held);

    assert_eq!(database_quick_check(&db).await, QuickCheck::Healthy);

    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(windows)]
#[tokio::test]
async fn a_restore_stops_at_a_held_snapshot_instead_of_taking_an_older_one() {
    let dir = temp_dir("restore-held");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "older").await;
    std::fs::copy(&db, generation_backup_path(&db, 1)).unwrap();
    seed_kavynex_db(&dir.join("newer.db"), "newer").await;
    std::fs::rename(dir.join("newer.db"), backup_path(&db)).unwrap();
    std::fs::write(&db, b"not a database").unwrap();

    let held = hold_exclusively(&backup_path(&db));
    let error = restore_database_from_backup(&db)
        .await
        .expect_err("the newest snapshot is only held, not damaged");
    drop(held);

    assert_eq!(error.code, AppErrorCode::DatabaseUnavailable.as_str());
    assert_eq!(
        std::fs::read(&db).unwrap(),
        b"not a database",
        "nothing was restored"
    );

    restore_database_from_backup(&db).await.unwrap();
    assert_eq!(read_title(&db).await, "newer");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn stage_and_apply_import_swaps_database_and_keeps_previous() {
    let dir = temp_dir("import");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    let source = dir.join("incoming.db");
    seed_kavynex_db(&source, "imported").await;

    stage_database_import(&db, &source, None).await.unwrap();
    assert!(import_staged_path(&db).exists());

    assert!(apply_pending_database_import(&db).unwrap());

    assert_eq!(read_video_title(&db).await, "imported");
    assert!(pre_import_path(&db).exists());
    assert_eq!(read_video_title(&pre_import_path(&db)).await, "current");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_staged_import_keeps_this_machines_remote_image_choice() {
    // A file from anywhere must not turn on requests to Google's image servers.
    let dir = temp_dir("import-remote-images");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    let source = dir.join("incoming.db");
    seed_kavynex_db(&source, "imported").await;
    {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(&source))
            .await
            .unwrap();
        sqlx::query("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)")
            .bind("load_remote_images")
            .bind("true")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
    }

    let local = MachinePaths {
        library_path: "C:\\This machine\\Library".to_string(),
        external_backup_dir: String::new(),
        load_remote_images: "false".to_string(),
    };

    stage_database_import(&db, &source, Some(&local))
        .await
        .unwrap();

    assert_eq!(
        read_machine_paths(&import_staged_path(&db))
            .await
            .unwrap()
            .load_remote_images,
        "false"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_staged_import_carries_this_machines_folders() {
    // The imported file names the folders of the machine it came from. Applied as they are, the
    // library pointed at a path that may not exist here and every media read as missing.
    let dir = temp_dir("import-machine-paths");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    let source = dir.join("incoming.db");
    seed_kavynex_db(&source, "imported").await;
    {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(&source))
            .await
            .unwrap();
        for (key, value) in [
            ("library_path", "D:\\Other machine\\Library"),
            ("external_backup_dir", "E:\\Other machine\\Mirror"),
        ] {
            sqlx::query("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)")
                .bind(key)
                .bind(value)
                .execute(&pool)
                .await
                .unwrap();
        }
        pool.close().await;
    }

    let local = MachinePaths {
        library_path: "C:\\This machine\\Library".to_string(),
        external_backup_dir: String::new(),
        ..Default::default()
    };

    stage_database_import(&db, &source, Some(&local))
        .await
        .unwrap();

    let staged = import_staged_path(&db);
    assert_eq!(read_machine_paths(&staged).await.unwrap(), local);
    // Only the .db is carried across to the swap, so the write must not have left its changes in
    // a sidecar.
    assert!(!sibling(&staged, "-wal").exists());

    // And the database itself is still the imported one, swapped in as before.
    assert!(apply_pending_database_import(&db).unwrap());
    assert_eq!(read_video_title(&db).await, "imported");
    assert_eq!(read_machine_paths(&db).await.unwrap(), local);

    // The source file the user picked is never written to.
    assert_eq!(
        read_machine_paths(&source).await.unwrap().library_path,
        "D:\\Other machine\\Library"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn apply_import_is_noop_when_nothing_staged() {
    let dir = temp_dir("import-noop");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    assert!(!apply_pending_database_import(&db).unwrap());
    assert_eq!(read_video_title(&db).await, "current");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn stage_import_rejects_non_kavynex_database() {
    let dir = temp_dir("import-reject");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    // A valid SQLite database, but without a `videos` table.
    let foreign = dir.join("foreign.db");
    seed_db(&foreign).await;

    let error = stage_database_import(&db, &foreign, None)
        .await
        .unwrap_err();
    assert_eq!(error.code, AppErrorCode::DatabaseImportInvalid.as_str());
    assert!(!import_staged_path(&db).exists());

    let _ = std::fs::remove_dir_all(&dir);
}

/// Seeds a database whose `videos` carries `title_normalized`, stamped at `user_version`, with
/// one row whose normalized title is NULL. The state an import must be judged on.
async fn seed_db_with_null_normalized_title(path: &Path, user_version: i64) {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();

    for ddl in [
        "CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, youtube_handle TEXT)",
        "CREATE TABLE videos (id INTEGER PRIMARY KEY, channel_id INTEGER, title TEXT, \
         title_normalized TEXT, file_path TEXT, media_type TEXT, \
         FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE, \
         UNIQUE (channel_id, file_path))",
        // The video_comments -> videos cascade has been present since the first released
        // schema (user_version 5), so a realistic older database carries it; import validation
        // requires it regardless of version.
        "CREATE TABLE video_comments (id INTEGER PRIMARY KEY, video_id INTEGER, text TEXT, \
         original_text TEXT, \
         FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE)",
        "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)",
    ] {
        sqlx::query(ddl).execute(&pool).await.unwrap();
    }

    sqlx::query("INSERT INTO videos (title, title_normalized) VALUES ('Ação', NULL)")
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA user_version = {user_version}"
    )))
    .execute(&pool)
    .await
    .unwrap();

    pool.close().await;
}

#[tokio::test]
async fn import_rejects_a_current_database_whose_titles_were_never_normalized() {
    // Stamped at the current version, so ensure_schema treats it as fully migrated and never
    // runs the v11 backfill. The media would sit in the library permanently invisible to every
    // title search, with nothing to say so. The triggers cannot catch this (an import replaces
    // the file wholesale, so no INSERT fires), which is why it has to be refused here.
    let dir = temp_dir("import-null-normalized");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    let source = dir.join("unnormalized.db");
    seed_db_with_null_normalized_title(&source, crate::services::db_schema::SCHEMA_VERSION).await;

    let error = stage_database_import(&db, &source, None).await.unwrap_err();

    assert_eq!(error.code, AppErrorCode::DatabaseImportInvalid.as_str());
    assert!(!import_staged_path(&db).exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn import_accepts_an_older_database_whose_titles_are_not_normalized_yet() {
    // The counterpart, and the reason the check is gated on the version rather than applied to
    // every database. Below v11 a NULL title_normalized is simply what that schema looks like.
    // Refusing it would block the genuine "import my library from an older Kavynex" case, which
    // ensure_schema fixes by running the v11 backfill right after the swap.
    let dir = temp_dir("import-old-unnormalized");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    let source = dir.join("older.db");
    seed_db_with_null_normalized_title(&source, 10).await;

    stage_database_import(&db, &source, None).await.unwrap();

    assert!(import_staged_path(&db).exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn stage_import_rejects_database_missing_a_core_table() {
    let dir = temp_dir("import-missing-table");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    // A database that has `videos` but is missing the other core tables must be rejected,
    // otherwise it would swap in and then fail queries at runtime with "no such table".
    let partial = dir.join("partial.db");
    let options = SqliteConnectOptions::new()
        .filename(&partial)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE videos (id INTEGER PRIMARY KEY, title TEXT)")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;

    let error = stage_database_import(&db, &partial, None)
        .await
        .unwrap_err();
    assert_eq!(error.code, AppErrorCode::DatabaseImportInvalid.as_str());
    assert!(!import_staged_path(&db).exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn undo_reverts_the_last_import_on_the_next_startup() {
    let dir = temp_dir("undo");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    let source = dir.join("incoming.db");
    seed_kavynex_db(&source, "imported").await;

    // Apply an import, leaving the previous database as the `.pre-import` snapshot.
    stage_database_import(&db, &source, None).await.unwrap();
    assert!(apply_pending_database_import(&db).unwrap());
    assert_eq!(read_video_title(&db).await, "imported");
    assert!(database_import_undo_available(&db));

    // Undo stages the pre-import snapshot; the swap happens on the next startup, like a
    // normal import, so the live database is never swapped underneath.
    stage_database_import_undo(&db, None).await.unwrap();
    assert!(import_staged_path(&db).exists());
    assert!(apply_pending_database_import(&db).unwrap());

    // The database is back to the pre-import content.
    assert_eq!(read_video_title(&db).await, "current");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn undo_fails_when_no_import_was_applied() {
    let dir = temp_dir("undo-none");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    assert!(!database_import_undo_available(&db));
    assert_eq!(
        stage_database_import_undo(&db, None)
            .await
            .unwrap_err()
            .code,
        AppErrorCode::NoDatabaseImportToUndo.as_str()
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn is_schema_migration_pending_reflects_user_version() {
    let dir = temp_dir("pending");
    let db = dir.join("kavynex.db");

    // A missing file: opening it creates the schema, so a migration is pending.
    assert!(is_schema_migration_pending(&db).await);

    // A database stamped below the current version still needs migrating.
    seed_kavynex_db(&db, "x").await; // user_version defaults to 0
    assert!(is_schema_migration_pending(&db).await);

    // Stamp the current version. Nothing to migrate, so the backup can be deferred.
    let options = SqliteConnectOptions::new()
        .filename(&db)
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA user_version = {}",
        crate::services::db_schema::SCHEMA_VERSION
    )))
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    assert!(!is_schema_migration_pending(&db).await);

    let _ = std::fs::remove_dir_all(&dir);
}

/// A database built by the real `ensure_schema`, so it carries the app's own triggers.
async fn seed_current_schema_db(path: &Path) -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    crate::services::db_schema::ensure_schema(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO channels (id, name, youtube_handle) VALUES (1, 'C', '@c')")
        .execute(&pool)
        .await
        .unwrap();

    pool
}

async fn trigger_and_view_names(path: &Path) -> Vec<String> {
    let pool = open(path).await.unwrap();
    let names: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM sqlite_master WHERE type IN ('trigger', 'view') ORDER BY name",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    pool.close().await;

    names.into_iter().map(|(name,)| name).collect()
}

#[tokio::test]
async fn an_imported_database_keeps_only_the_apps_own_triggers() {
    // A trigger the file brought along runs with every later write, the settings write the import
    // itself makes included, so this one would have put the mirror folder back on a share right
    // after the import set this machine's. A view is dropped too, since the app defines none.
    let dir = temp_dir("import-foreign-triggers");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    let source = dir.join("incoming.db");
    let pool = seed_current_schema_db(&source).await;
    let own_triggers = trigger_and_view_names(&source).await;
    for statement in [
        "CREATE TRIGGER evil_settings AFTER UPDATE ON app_settings BEGIN \
         UPDATE app_settings SET value = '//attacker/share' WHERE key = 'external_backup_dir'; END",
        "CREATE VIEW evil_view AS SELECT * FROM videos",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    pool.close().await;

    let local = MachinePaths {
        library_path: r"C:\This machine\Library".to_string(),
        external_backup_dir: r"E:\Mirror".to_string(),
        ..Default::default()
    };

    stage_database_import(&db, &source, Some(&local))
        .await
        .unwrap();

    let staged = import_staged_path(&db);
    assert_eq!(read_machine_paths(&staged).await.unwrap(), local);
    assert_eq!(trigger_and_view_names(&staged).await, own_triggers);
    assert!(!own_triggers.is_empty());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn an_imported_database_naming_files_outside_the_library_is_refused() {
    let dir = temp_dir("import-absolute-paths");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    for stored in [
        "//attacker/share/avatar.png",
        r"\\attacker\share\avatar.png",
        r"C:\Users\me\avatar.png",
        "../outside/avatar.png",
        "avatar.png",
    ] {
        let source = dir.join(format!(
            "incoming-{}.db",
            crate::utils::naming::unique_temp_suffix()
        ));
        let pool = seed_current_schema_db(&source).await;
        sqlx::query("UPDATE channels SET avatar_path = ? WHERE id = 1")
            .bind(stored)
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        let error = stage_database_import(&db, &source, None)
            .await
            .expect_err("a stored path outside the managed folders must be refused");

        assert_eq!(
            error.code,
            AppErrorCode::DatabaseImportInvalid.as_str(),
            "{stored}"
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn an_imported_database_whose_rows_point_at_nothing_is_refused() {
    let dir = temp_dir("import-orphans");
    let db = dir.join("kavynex.db");
    seed_kavynex_db(&db, "current").await;

    let source = dir.join("incoming.db");
    let pool = seed_current_schema_db(&source).await;
    let mut conn = pool.acquire().await.unwrap();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO videos (channel_id, title, title_normalized, file_path, media_type) \
         VALUES (999, 'orphan', 'orphan', 'video/media_x.mp4', 'video')",
    )
    .execute(&mut *conn)
    .await
    .unwrap();
    drop(conn);
    pool.close().await;

    let error = stage_database_import(&db, &source, None)
        .await
        .expect_err("a media whose channel is gone must be refused");

    assert_eq!(error.code, AppErrorCode::DatabaseImportInvalid.as_str());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_pre_migration_snapshot_is_restored_when_no_daily_backup_is_left() {
    // The daily generations can all be gone or damaged while the snapshot taken before the last
    // upgrade sits beside them, and the restore never looked at it.
    let dir = temp_dir("restore-pre-migration");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;
    std::fs::copy(&db, snapshot::pre_migration_path(&db, 14)).unwrap();

    std::fs::write(&db, b"not a database").unwrap();

    restore_database_from_backup(&db).await.unwrap();

    assert_eq!(read_single_value(&db).await, "hello");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_daily_backups_come_before_the_pre_migration_snapshots_newest_first() {
    let dir = temp_dir("candidates-order");
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("kavynex.db");

    for path in [
        sibling(&db, ".bak"),
        snapshot::pre_migration_path(&db, 13),
        snapshot::pre_migration_path(&db, 14),
    ] {
        std::fs::write(path, b"x").unwrap();
    }

    assert_eq!(
        snapshot::backup_candidates(&db),
        vec![
            sibling(&db, ".bak"),
            snapshot::pre_migration_path(&db, 14),
            snapshot::pre_migration_path(&db, 13),
        ]
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_restore_keeps_the_corrupt_databases_write_ahead_log_beside_it() {
    // Commits that were never checkpointed live only in the log, and deleting it left the copy
    // kept for inspection without them.
    let dir = temp_dir("restore-corrupt-wal");
    let db = dir.join("kavynex.db");
    seed_db(&db).await;
    assert!(backup_database(&db).await.unwrap());

    std::fs::write(&db, b"not a database").unwrap();
    std::fs::write(sibling(&db, "-wal"), b"uncheckpointed frames").unwrap();

    restore_database_from_backup(&db).await.unwrap();

    assert_eq!(
        std::fs::read(restore::corrupt_wal_path(&db)).unwrap(),
        b"uncheckpointed frames"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
