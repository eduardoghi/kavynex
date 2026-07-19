//! The full `PRAGMA integrity_check` and the throttle that runs it in the background.
//!
//! The automatic paths (open, backup) use the fast, shallow `quick_check` (see the shared helpers
//! in the parent module); this is the thorough check a subtly damaged page can otherwise slip past.

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
