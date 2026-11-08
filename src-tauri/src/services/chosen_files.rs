//! The files the renderer may name where a command reads a file the user chose, or writes to a
//! destination the user chose.
//!
//! The same rule `chosen_folders` holds for folders. A path is accepted only if it came out of a
//! dialog the backend opened (`commands::dialog`) or is a preview the backend itself wrote, and only
//! for the use it was picked for, checked as a string before anything touches the filesystem. The
//! record lasts for the process. What it stops, and which command needs which use, is in "Only a
//! file the user picked" in `docs/THREAT-MODEL.md`.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;

use crate::{AppError, AppErrorCode, AppResult};

/// What the renderer opens the file picker for (`commands::dialog::open_file_dialog`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum FilePurpose {
    /// A video or audio file to import.
    Media,
    /// An image for a media's thumbnail or a channel's avatar.
    Image,
    /// A cookies file for yt-dlp.
    Cookies,
    /// A database to import.
    Database,
}

/// A file the backend handed out, and the one use it was handed out for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChosenFile {
    /// Picked in the open dialog for this purpose. May be read for it.
    Picked(FilePurpose),
    /// Picked in the save dialog, which only the database export opens. May be written.
    DatabaseExport,
}

impl ChosenFile {
    pub const MEDIA: Self = Self::Picked(FilePurpose::Media);
    /// Also a preview the backend wrote, which the renderer hands back as a thumbnail.
    pub const IMAGE: Self = Self::Picked(FilePurpose::Image);
    pub const COOKIES: Self = Self::Picked(FilePurpose::Cookies);
    pub const DATABASE: Self = Self::Picked(FilePurpose::Database);
}

fn chosen() -> &'static Mutex<HashSet<(ChosenFile, String)>> {
    static CHOSEN: OnceLock<Mutex<HashSet<(ChosenFile, String)>>> = OnceLock::new();
    CHOSEN.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Adds a file the backend handed out. A blank value records nothing.
pub fn record(kind: ChosenFile, path: &str) {
    let path = path.trim();

    if path.is_empty() {
        return;
    }

    chosen()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert((kind, path.to_string()));
}

/// Refuses `path` unless the backend handed it out as `kind`.
pub fn ensure_chosen(kind: ChosenFile, path: &str) -> AppResult<()> {
    let path = path.trim();

    let is_recorded = !path.is_empty()
        && chosen()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains(&(kind, path.to_string()));

    if is_recorded {
        return Ok(());
    }

    let message = match kind {
        ChosenFile::Picked(_) => "the file was not chosen in the file picker for this",
        ChosenFile::DatabaseExport => "the destination was not chosen in the save dialog",
    };

    Err(AppError::from_code(AppErrorCode::InvalidInput, message))
}

/// `ensure_chosen` for an optional parameter. Absent or blank means none was given, which is
/// always allowed.
pub fn ensure_chosen_if_present(kind: ChosenFile, path: Option<&str>) -> AppResult<()> {
    match path.map(str::trim) {
        Some(path) if !path.is_empty() => ensure_chosen(kind, path),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique(prefix: &str) -> String {
        format!("/{prefix}/{}", crate::utils::naming::unique_temp_suffix())
    }

    #[test]
    fn a_file_the_backend_handed_out_is_accepted() {
        let path = unique("picked");
        record(ChosenFile::MEDIA, &format!("  {path}  "));

        assert!(ensure_chosen(ChosenFile::MEDIA, &path).is_ok());
    }

    #[test]
    fn a_file_the_renderer_made_up_is_refused() {
        let error =
            ensure_chosen(ChosenFile::MEDIA, r"C:\Users\me\secret.png").expect_err("never picked");

        assert_eq!(error.code, AppErrorCode::InvalidInput.as_str());
    }

    #[test]
    fn a_pick_answers_only_the_question_it_was_asked_for() {
        let source = unique("source");
        let destination = unique("destination");
        record(ChosenFile::MEDIA, &source);
        record(ChosenFile::DatabaseExport, &destination);

        assert!(ensure_chosen(ChosenFile::DatabaseExport, &source).is_err());
        assert!(ensure_chosen(ChosenFile::MEDIA, &destination).is_err());
    }

    #[test]
    fn a_file_picked_for_one_use_is_refused_for_another() {
        // An image picked as a thumbnail, imported as media in Move mode, would be removed from
        // where the user keeps it.
        let image = unique("cover");
        record(ChosenFile::IMAGE, &image);

        assert!(ensure_chosen(ChosenFile::IMAGE, &image).is_ok());
        for other in [ChosenFile::MEDIA, ChosenFile::COOKIES, ChosenFile::DATABASE] {
            assert!(ensure_chosen(other, &image).is_err(), "{other:?}");
        }
    }

    #[test]
    fn an_absent_optional_path_needs_no_pick() {
        assert!(ensure_chosen_if_present(ChosenFile::MEDIA, None).is_ok());
        assert!(ensure_chosen_if_present(ChosenFile::MEDIA, Some("  ")).is_ok());
        assert!(ensure_chosen_if_present(ChosenFile::MEDIA, Some("/never/picked.txt")).is_err());
    }

    #[test]
    fn recording_a_blank_value_admits_nothing() {
        record(ChosenFile::MEDIA, "   ");

        assert!(ensure_chosen(ChosenFile::MEDIA, "").is_err());
    }
}
