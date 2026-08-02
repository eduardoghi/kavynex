//! The full `PRAGMA integrity_check` and the throttle that runs it in the background.
//!
//! The automatic paths (open, backup) use the fast, shallow `quick_check` (see the shared helpers
//! in the parent module); this is the thorough check a subtly damaged page can otherwise slip past.
//!
//! Tests live in the parent module's `mod tests`, which reaches the test-only internals here
//! (`integrity_check_marker_path`, `MAX_INTEGRITY_PROBLEMS`) through the parent's `#[cfg(test)] use`.

use std::path::{Path, PathBuf};

use sqlx::SqlitePool;

use super::{backup_error, is_recent, sibling};
use crate::services::logger;
use crate::AppResult;

/// The outcome of a full `PRAGMA integrity_check`: whether the database is sound and, when it is
/// not, what SQLite actually reported.
#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct DatabaseIntegrityReport {
    pub ok: bool,
    /// The problems SQLite listed, one per entry, capped at [`MAX_INTEGRITY_PROBLEMS`]. Empty when
    /// `ok`.
    pub problems: Vec<String>,
    /// True when SQLite reported more problems than were kept, so the UI can say the list is
    /// partial rather than presenting a truncated list as the whole story.
    pub truncated: bool,
}

/// A corrupt database can report a problem per damaged page, which is unbounded and useless past
/// the first handful: the answer is the same either way ("restore from a backup"), and the point of
/// showing any of them is to say *what* is wrong, not to enumerate it. `pub(super)` so the parent
/// module's test can assert the cap.
pub(super) const MAX_INTEGRITY_PROBLEMS: usize = 20;

/// `SQLITE_CORRUPT` ("database disk image is malformed").
const SQLITE_CORRUPT_CODE: &str = "11";

/// The SQLite-native error code behind a `sqlx::Error`, when it has one. A failure that never
/// reached the database (a pool timeout, a decode error) has none.
fn sqlite_error_code(error: &sqlx::Error) -> Option<String> {
    match error {
        sqlx::Error::Database(database_error) => {
            database_error.code().map(|code| code.into_owned())
        }
        _ => None,
    }
}

/// Runs a full `PRAGMA integrity_check`, a thorough (and slower) check than the `quick_check`
/// used by the automatic health paths. User-triggered only, so the extra cost is fine.
///
/// `fetch_all` rather than `fetch_one`: on a healthy database the pragma returns the single row
/// `ok`, but on a damaged one it returns *a row per problem found*. Reading only the first row
/// threw away everything SQLite had to say about the damage, leaving the UI with a bare "there is
/// a problem" and the user with nothing to act on or report.
pub async fn run_full_integrity_check(pool: &SqlitePool) -> AppResult<DatabaseIntegrityReport> {
    let rows: Vec<(String,)> = match sqlx::query_as("PRAGMA integrity_check")
        .fetch_all(pool)
        .await
    {
        Ok(rows) => rows,
        // Past a certain amount of damage SQLite gives up on the pragma itself and fails the query
        // with SQLITE_CORRUPT instead of listing what is wrong. That is still an answer - the most
        // definitive one there is - so it must not surface as "the check could not run", which
        // reads like the tool broke rather than the database. Only this one code is treated this
        // way: an IO error or a lock timeout says nothing about integrity and still propagates.
        Err(error) => {
            if sqlite_error_code(&error).as_deref() == Some(SQLITE_CORRUPT_CODE) {
                return Ok(DatabaseIntegrityReport {
                    ok: false,
                    problems: vec![format!("SQLite reported the database as corrupt: {error}")],
                    truncated: false,
                });
            }

            return Err(backup_error(
                "failed to run the database integrity check",
                error,
            ));
        }
    };

    // The healthy answer is exactly one row reading `ok`; anything else is a list of problems.
    // Checking the shape rather than just the first row keeps a database that somehow reports `ok`
    // alongside real problems from being called sound.
    let ok = rows.len() == 1 && rows[0].0 == "ok";

    if ok {
        return Ok(DatabaseIntegrityReport {
            ok: true,
            problems: Vec::new(),
            truncated: false,
        });
    }

    let problems: Vec<String> = rows
        .iter()
        .take(MAX_INTEGRITY_PROBLEMS)
        .map(|(problem,)| problem.clone())
        .collect();

    Ok(DatabaseIntegrityReport {
        ok: false,
        truncated: rows.len() > problems.len(),
        problems,
    })
}

// How often the background full integrity check runs at most. The automatic paths (open, backup)
// use `quick_check`, which is fast but shallow: a subtly damaged page can pass it and then be
// migrated over. A full `integrity_check` catches that, but it reads the whole database, which is
// why it is deliberately not on the open path (see `services::database::build_pool_at`). This runs
// it off the startup critical path instead, throttled to once a week so it never becomes a
// per-launch cost.
const INTEGRITY_CHECK_MIN_INTERVAL_SECS: u64 = 7 * 24 * 60 * 60;

/// `pub(super)` so the parent module's test can assert the marker is written.
pub(super) fn integrity_check_marker_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".integrity-checked")
}

/// Whether a background full integrity check is due: true when the marker is missing (never run)
/// or older than [`INTEGRITY_CHECK_MIN_INTERVAL_SECS`]. The marker's mtime records the last check
/// that passed, so a database that keeps failing is re-checked every launch until it is repaired.
pub fn integrity_check_is_due(db_path: &Path) -> bool {
    !is_recent(
        &integrity_check_marker_path(db_path),
        INTEGRITY_CHECK_MIN_INTERVAL_SECS,
    )
}

/// Records that a full integrity check just passed, so [`integrity_check_is_due`] throttles the
/// next one for a week. Best effort: a marker that cannot be written only means the check runs
/// again next launch, which is harmless. Called only after a clean check, never after a failing
/// one, so a damaged database stays flagged on every launch until it is restored.
pub fn mark_integrity_check_passed(db_path: &Path) {
    let marker = integrity_check_marker_path(db_path);

    if let Err(error) = std::fs::File::create(&marker) {
        logger::warn(
            "db_integrity",
            format!("failed to write the integrity-check marker: {error}"),
        );
    }
}

#[cfg(test)]
mod tests {
    use std::time::SystemTime;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;
    use crate::services::db_backup::test_support::{filetime_set, temp_dir};

    // These four moved here from the parent's `mod tests`, which is where every db_backup test
    // still lived after the module was split - not by choice, but because they all shared the
    // helpers that now live in `test_support`. A test for the weekly throttle and one for what
    // `PRAGMA integrity_check` reports belong next to the functions that decide both.
    #[test]
    fn integrity_check_is_due_until_a_pass_is_marked() {
        let dir = temp_dir("integrity-due");
        let db = dir.join("kavynex.db");

        // Never run: due.
        assert!(integrity_check_is_due(&db));

        // After a clean check is recorded, the throttle suppresses the next one.
        mark_integrity_check_passed(&db);
        assert!(integrity_check_marker_path(&db).exists());
        assert!(!integrity_check_is_due(&db));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn integrity_check_is_not_due_within_the_weekly_throttle_window() {
        // A marker aged three days is well inside the one-week throttle, so a background check is not
        // due. Pins INTEGRITY_CHECK_MIN_INTERVAL_SECS = 7 * 24 * 60 * 60: any of its `*` operators
        // mutated to `+`/`/` collapses the interval to a few seconds (or zero), which would make a
        // three-day-old marker read as due.
        let dir = temp_dir("integrity-throttle");
        let db = dir.join("kavynex.db");
        let marker = integrity_check_marker_path(&db);
        std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
        std::fs::write(&marker, b"").unwrap();
        let three_days_ago = SystemTime::now() - std::time::Duration::from_secs(3 * 24 * 60 * 60);
        filetime_set(&marker, three_days_ago);

        assert!(
            !integrity_check_is_due(&db),
            "a three-day-old marker is within the one-week throttle, so a check is not due"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_full_integrity_check_reports_ok_for_a_healthy_schema() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::services::db_schema::ensure_schema(&pool)
            .await
            .unwrap();

        let report = run_full_integrity_check(&pool).await.unwrap();

        assert!(report.ok);
        assert!(report.problems.is_empty());
        assert!(!report.truncated);

        pool.close().await;
    }

    #[tokio::test]
    async fn run_full_integrity_check_keeps_what_sqlite_reported_about_a_damaged_database() {
        // The whole point of the change this pins: `PRAGMA integrity_check` answers with one row
        // per problem, so reading a single row threw away everything SQLite had to say and left the
        // UI with a bare "there is a problem" and the user with nothing to act on.
        //
        // The damage is real rather than simulated: an index page is overwritten with garbage while
        // the file is closed, which leaves the database openable (the header and schema are intact)
        // but internally inconsistent - exactly the state this check exists to find, and the one
        // "not a database" never reaches because it fails at open instead.
        let dir = temp_dir("integrity-damaged");
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("kavynex.db");

        // The real schema rather than the reduced `seed_kavynex_db` shape: this test is about what
        // `integrity_check` finds inside the file, so the indexes it walks have to be the real ones.
        {
            let options = SqliteConnectOptions::new()
                .filename(&db)
                .create_if_missing(true);
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(options)
                .await
                .unwrap();
            crate::services::db_schema::ensure_schema(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO channels (id, name, youtube_handle) VALUES (1, 'C', '@c')")
                .execute(&pool)
                .await
                .unwrap();

            for id in 2..400 {
                sqlx::query(
                    "INSERT INTO videos (id, channel_id, title, title_normalized, file_path, media_type) \
                     VALUES (?, 1, ?, ?, ?, 'video')",
                )
                .bind(id)
                .bind(format!("title {id}"))
                .bind(format!("title {id}"))
                .bind(format!("video/{id}.mp4"))
                .execute(&pool)
                .await
                .unwrap();
            }

            // Fold the WAL back in so the damage below lands on the database file itself rather
            // than on pages the next open would replay over.
            sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;
        }

        let mut bytes = std::fs::read(&db).unwrap();
        let page_size = u16::from_be_bytes([bytes[16], bytes[17]]) as usize;
        assert!(page_size >= 512, "unexpected page size: {page_size}");

        // Scribble over the interior of several pages, leaving page 1 (the header and schema)
        // alone so the file still opens.
        for page in 3..8 {
            let start = page * page_size + 16;
            let end = start + 64;

            if end < bytes.len() {
                bytes[start..end].fill(0x5A);
            }
        }
        std::fs::write(&db, &bytes).unwrap();

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&format!("sqlite://{}", db.to_string_lossy()))
            .await
            .unwrap();

        let report = run_full_integrity_check(&pool).await.unwrap();

        // Damage this heavy is reported one of two ways depending on what SQLite manages to walk:
        // a list of problems, or a flat SQLITE_CORRUPT on the pragma itself. Both are integrity
        // answers and both have to arrive as one - never as "the check could not run", which reads
        // as the tool breaking rather than the database being broken.
        assert!(
            !report.ok,
            "the damaged database must not be reported sound"
        );
        assert!(
            !report.problems.is_empty(),
            "what SQLite reported has to reach the caller, not just the fact that it failed"
        );
        assert!(
            report.problems.len() <= MAX_INTEGRITY_PROBLEMS,
            "the problem list is capped so a shredded database cannot report unboundedly"
        );

        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
