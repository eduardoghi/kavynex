//! What closing the window would stop, so the app can ask first.
//!
//! Closing ends every yt-dlp run, a media still being added, the library verification and a library
//! move (`lib.rs`'s `ExitRequested`), and none of them resumes. A download that took an hour is
//! started over. `lib.rs` holds a close while any of them runs and tells the renderer what, through
//! [`crate::constants::EVENT_CLOSE_REQUESTED_WHILE_BUSY`], and `commands::window::close_app_anyway`
//! closes once the user says so.

use serde::Serialize;

/// Which kinds of work a close would stop right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct WorkInProgress {
    /// A yt-dlp run, a download or the short lookups (formats, comments) that run the same way.
    pub downloading: bool,
    /// A media creation, a local import's copy among them.
    pub adding_media: bool,
    pub verifying_library: bool,
    pub moving_library: bool,
}

impl WorkInProgress {
    fn is_any(&self) -> bool {
        self.downloading || self.adding_media || self.verifying_library || self.moving_library
    }
}

/// What a close would stop, or `None` when nothing is running and the window may close as it is.
pub(crate) fn work_closing_would_stop() -> Option<WorkInProgress> {
    let work = WorkInProgress {
        downloading: crate::services::yt_dlp::registry::has_active_runs(),
        adding_media: crate::services::media_creation::try_exclude_creations().is_none(),
        verifying_library: crate::services::library::verification::is_verification_running(),
        moving_library: crate::services::library::migration::is_migration_running(),
    };

    work.is_any().then_some(work)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_kind_of_work_counts() {
        let idle = WorkInProgress {
            downloading: false,
            adding_media: false,
            verifying_library: false,
            moving_library: false,
        };

        assert!(!idle.is_any());
        assert!(WorkInProgress {
            downloading: true,
            ..idle
        }
        .is_any());
        assert!(WorkInProgress {
            adding_media: true,
            ..idle
        }
        .is_any());
        assert!(WorkInProgress {
            verifying_library: true,
            ..idle
        }
        .is_any());
        assert!(WorkInProgress {
            moving_library: true,
            ..idle
        }
        .is_any());
    }
}
