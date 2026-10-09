//! The folders the renderer may name where a command persists, creates or probes one.
//!
//! In the app's own flows a folder reaches those commands in one of two ways. The user picked it in
//! the folder dialog the backend opened (`commands::dialog`), or it is the library folder already
//! stored in the settings. Anything else is a value the renderer made up. Accepting it is what let a
//! compromised renderer point the library at `\\host\share` and have imports copy the user's files
//! there, move the whole library onto it, or mirror the database to it every day, while the mere
//! act of resolving the path authenticated to the host over SMB.
//!
//! So each of those commands checks the value against this record, exactly as a string and before
//! anything touches the filesystem, and refuses one that was neither picked nor stored. What gets
//! recorded is only what the backend itself handed out. The picker's answer, the spelling
//! `ensure_directory_exists` and `resolve_existing_directory` return for a folder already allowed
//! (the frontend persists that spelling), and the folder a migration ended in. The record lasts for
//! the process. A restart forgets it, and the stored settings carry the folder that matters across.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use crate::{AppError, AppErrorCode, AppResult};

fn chosen() -> &'static Mutex<HashSet<String>> {
    static CHOSEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CHOSEN.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Adds a folder the backend handed out. A blank value records nothing.
pub fn record(path: &str) {
    let path = path.trim();

    if path.is_empty() {
        return;
    }

    chosen()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(path.to_string());
}

fn is_recorded(path: &str) -> bool {
    chosen()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains(path.trim())
}

/// Refuses `path` unless the backend handed it out or it is one of the `stored` folders.
///
/// A string comparison and nothing else, which is the point. A UNC path the renderer made up is
/// refused here without being resolved, so the refusal itself costs no SMB handshake.
pub fn ensure_chosen(path: &str, stored: &[Option<&str>]) -> AppResult<()> {
    let path = path.trim();

    let is_stored = stored
        .iter()
        .flatten()
        .any(|stored| !stored.trim().is_empty() && stored.trim() == path);

    if is_stored || is_recorded(path) {
        return Ok(());
    }

    Err(AppError::from_code(
        AppErrorCode::InvalidInput,
        "the folder was not chosen in the folder picker",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_the_backend_handed_out_is_accepted() {
        let path = format!("/picked/{}", crate::utils::naming::unique_temp_suffix());
        record(&format!("  {path}  "));

        assert!(ensure_chosen(&path, &[]).is_ok());
    }

    #[test]
    fn the_stored_folder_is_accepted_without_being_picked() {
        let stored = format!("/stored/{}", crate::utils::naming::unique_temp_suffix());

        assert!(ensure_chosen(&stored, &[None, Some(stored.as_str())]).is_ok());
    }

    #[test]
    fn a_folder_the_renderer_made_up_is_refused() {
        let error = ensure_chosen(r"\\attacker\share\library", &[Some("/stored/library")])
            .expect_err("never picked and not stored");

        assert_eq!(error.code, AppErrorCode::InvalidInput.as_str());
    }

    #[test]
    fn an_empty_stored_value_does_not_admit_an_empty_path() {
        // An unconfigured setting is stored as "", and that must not read as "this folder is
        // stored" for a blank request.
        assert!(ensure_chosen("", &[Some("")]).is_err());
    }

    #[test]
    fn recording_a_blank_value_admits_nothing() {
        record("   ");

        assert!(ensure_chosen("", &[]).is_err());
    }
}
