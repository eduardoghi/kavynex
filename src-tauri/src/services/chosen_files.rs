//! The files the renderer may name where a command reads a file the user chose, or writes to a
//! destination the user chose.
//!
//! The same rule `chosen_folders` holds for folders. In the app's own flows each of those paths came
//! out of a dialog the backend opened (`commands::dialog`), or is a preview the backend itself wrote
//! and handed back. Anything else is a value the renderer made up, and accepting it let a
//! compromised renderer import any image, video or cookies file on disk into the library (where the
//! asset protocol serves it), load any `.db` file as the database, or have an export overwrite a
//! `.db` file it never saw a dialog for.
//!
//! A pick is recorded with its kind. A file picked to be read cannot be used as an export
//! destination, and a save destination cannot be read as a source, so one dialog answers one
//! question. The check is a string comparison done before anything touches the filesystem. The
//! record lasts for the process.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use crate::{AppError, AppErrorCode, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChosenFile {
    /// Picked in the open dialog, or a preview the backend wrote. May be read.
    Source,
    /// Picked in the save dialog. May be written.
    Destination,
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
        ChosenFile::Source => "the file was not chosen in the file picker",
        ChosenFile::Destination => "the destination was not chosen in the save dialog",
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
        record(ChosenFile::Source, &format!("  {path}  "));

        assert!(ensure_chosen(ChosenFile::Source, &path).is_ok());
    }

    #[test]
    fn a_file_the_renderer_made_up_is_refused() {
        let error =
            ensure_chosen(ChosenFile::Source, r"C:\Users\me\secret.png").expect_err("never picked");

        assert_eq!(error.code, AppErrorCode::InvalidInput.as_str());
    }

    #[test]
    fn a_pick_answers_only_the_question_it_was_asked_for() {
        let source = unique("source");
        let destination = unique("destination");
        record(ChosenFile::Source, &source);
        record(ChosenFile::Destination, &destination);

        assert!(ensure_chosen(ChosenFile::Destination, &source).is_err());
        assert!(ensure_chosen(ChosenFile::Source, &destination).is_err());
    }

    #[test]
    fn an_absent_optional_path_needs_no_pick() {
        assert!(ensure_chosen_if_present(ChosenFile::Source, None).is_ok());
        assert!(ensure_chosen_if_present(ChosenFile::Source, Some("  ")).is_ok());
        assert!(ensure_chosen_if_present(ChosenFile::Source, Some("/never/picked.txt")).is_err());
    }

    #[test]
    fn recording_a_blank_value_admits_nothing() {
        record(ChosenFile::Source, "   ");

        assert!(ensure_chosen(ChosenFile::Source, "").is_err());
    }
}
