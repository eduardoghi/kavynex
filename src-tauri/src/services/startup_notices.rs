//! What the background startup tasks found that the user has to be told, kept until the frontend
//! takes it.
//!
//! Those tasks report through an event, emitted seconds to minutes after launch. An event reaches
//! only a listener that is already attached, so one emitted before the window finished loading, or
//! while it was reloading, was lost, and the finding stayed in the log. Each finding is now recorded
//! here before its event goes out, the event only tells the frontend to come and look, and the
//! frontend also looks once when it mounts (`take_startup_notices`). Taking a notice clears it, so
//! each one is shown once whichever of the two paths gets it.

use std::sync::{Mutex, OnceLock};

use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct StartupNotices {
    /// The background integrity check failed. The problems themselves stay in the log.
    pub database_integrity_failed: bool,
    /// How many crashed media creations the startup sweep stopped retrying.
    #[ts(type = "number | null")]
    pub pending_media_abandoned: Option<usize>,
    /// How many files the rows of a just-applied import name that the library folder lacks.
    #[ts(type = "number | null")]
    pub imported_missing_files: Option<usize>,
    /// A staged database import could not be applied at startup, so the previous database is
    /// still the one in use.
    pub import_apply_failed: bool,
    /// An interrupted import was recovered, and the database found at the database path was set
    /// aside as `kavynex.db.displaced-*` rather than deleted.
    pub database_displaced: bool,
}

fn pending() -> &'static Mutex<StartupNotices> {
    static PENDING: OnceLock<Mutex<StartupNotices>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(StartupNotices::default()))
}

fn update(apply: impl FnOnce(&mut StartupNotices)) {
    apply(
        &mut pending()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
    );
}

pub fn record_database_integrity_failed() {
    update(|notices| notices.database_integrity_failed = true);
}

pub fn record_pending_media_abandoned(abandoned: usize) {
    update(|notices| {
        notices.pending_media_abandoned =
            Some(notices.pending_media_abandoned.unwrap_or(0) + abandoned)
    });
}

pub fn record_imported_missing_files(missing: usize) {
    update(|notices| notices.imported_missing_files = Some(missing));
}

pub fn record_database_displaced() {
    update(|notices| notices.database_displaced = true);
}

pub fn record_import_apply_failed() {
    update(|notices| notices.import_apply_failed = true);
}

/// Everything recorded since the last take, cleared.
pub fn take() -> StartupNotices {
    std::mem::take(
        &mut *pending()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test, because the store is process-wide. The pending-media sweep tests record into it
    // concurrently, so the abandoned count is held to a lower bound rather than an exact value.
    #[test]
    fn a_notice_is_taken_once_and_abandoned_counts_add_up() {
        record_pending_media_abandoned(1);
        record_pending_media_abandoned(2);
        record_import_apply_failed();

        let taken = take();
        assert!(taken.pending_media_abandoned.unwrap_or(0) >= 3);
        assert!(taken.import_apply_failed);

        assert!(!take().import_apply_failed, "taking clears what was taken");
    }
}
