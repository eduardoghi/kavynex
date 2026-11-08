//! The folders the renderer may name where a command persists, creates or probes one.
//!
//! Each of those commands accepts only a folder the backend handed out (the folder dialog's answer,
//! the spelling `ensure_directory_exists` and `resolve_existing_directory` return for a folder
//! already allowed, the folder a migration ended in) or the library folder the settings store. The
//! check is an exact string comparison made before anything touches the filesystem. The record
//! lasts for the process, and the stored settings carry the folder that matters across a restart.
//! What it stops is in "Only a folder the user picked" in `docs/THREAT-MODEL.md`.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;

use crate::{AppError, AppErrorCode, AppResult};

/// What a picked folder is for. The dialog's title comes from it, so the user is told what the
/// folder will be used as, and a folder picked for one purpose is not accepted for the other. A
/// folder picked as the backup mirror would otherwise be accepted as the library, or as where the
/// library is moved, and the reverse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum FolderPurpose {
    /// The library folder, chosen first or as a migration destination.
    Library,
    /// The folder the database is mirrored to once a day.
    ExternalBackup,
}

impl FolderPurpose {
    /// The folder dialog's title for this purpose.
    pub fn dialog_title(self) -> &'static str {
        match self {
            Self::Library => "Choose the library folder",
            Self::ExternalBackup => "Choose the folder for the database backup",
        }
    }
}

fn chosen() -> &'static Mutex<HashSet<(FolderPurpose, String)>> {
    static CHOSEN: OnceLock<Mutex<HashSet<(FolderPurpose, String)>>> = OnceLock::new();
    CHOSEN.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Adds a folder the backend handed out for `purpose`. A blank value records nothing.
pub fn record(purpose: FolderPurpose, path: &str) {
    let path = path.trim();

    if path.is_empty() {
        return;
    }

    chosen()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert((purpose, path.to_string()));
}

fn is_recorded(purpose: FolderPurpose, path: &str) -> bool {
    chosen()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains(&(purpose, path.trim().to_string()))
}

/// Refuses `path` unless the backend handed it out for `purpose` or it is one of the `stored`
/// folders.
///
/// A string comparison and nothing else, which is the point. A UNC path the renderer made up is
/// refused here without being resolved, so the refusal itself costs no SMB handshake.
pub fn ensure_chosen(purpose: FolderPurpose, path: &str, stored: &[Option<&str>]) -> AppResult<()> {
    let path = path.trim();

    let is_stored = stored
        .iter()
        .flatten()
        .any(|stored| !stored.trim().is_empty() && stored.trim() == path);

    if is_stored || is_recorded(purpose, path) {
        return Ok(());
    }

    Err(AppError::from_code(
        AppErrorCode::InvalidInput,
        "the folder was not chosen in the folder picker for this purpose",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_the_backend_handed_out_is_accepted() {
        let path = format!("/picked/{}", crate::utils::naming::unique_temp_suffix());
        record(FolderPurpose::Library, &format!("  {path}  "));

        assert!(ensure_chosen(FolderPurpose::Library, &path, &[]).is_ok());
    }

    #[test]
    fn the_stored_folder_is_accepted_without_being_picked() {
        let stored = format!("/stored/{}", crate::utils::naming::unique_temp_suffix());

        assert!(ensure_chosen(
            FolderPurpose::ExternalBackup,
            &stored,
            &[None, Some(stored.as_str())]
        )
        .is_ok());
    }

    #[test]
    fn a_folder_the_renderer_made_up_is_refused() {
        let error = ensure_chosen(
            FolderPurpose::Library,
            r"\\attacker\share\library",
            &[Some("/stored/library")],
        )
        .expect_err("never picked and not stored");

        assert_eq!(error.code, AppErrorCode::InvalidInput.as_str());
    }

    #[test]
    fn an_empty_stored_value_does_not_admit_an_empty_path() {
        // An unconfigured setting is stored as "", and that must not read as "this folder is
        // stored" for a blank request.
        assert!(ensure_chosen(FolderPurpose::Library, "", &[Some("")]).is_err());
    }

    #[test]
    fn recording_a_blank_value_admits_nothing() {
        record(FolderPurpose::Library, "   ");

        assert!(ensure_chosen(FolderPurpose::Library, "", &[]).is_err());
    }

    #[test]
    fn a_folder_picked_for_one_purpose_is_refused_for_the_other() {
        let path = format!("/backup/{}", crate::utils::naming::unique_temp_suffix());
        record(FolderPurpose::ExternalBackup, &path);

        assert!(ensure_chosen(FolderPurpose::ExternalBackup, &path, &[]).is_ok());
        assert!(ensure_chosen(FolderPurpose::Library, &path, &[]).is_err());
    }
}
