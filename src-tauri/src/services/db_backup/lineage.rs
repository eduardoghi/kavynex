//! Which database a backup belongs to.
//!
//! A database file created from nothing (a first run, a reinstall, a start over after the file went
//! missing) gets a lineage id, kept beside it in `kavynex.db.lineage`. The external mirror writes the
//! same id next to its copies. A copy in the mirror folder without that id, while the database has
//! one, was made from a database that came before this one, and the mirror sets it aside instead of
//! rotating it out (see `external::mirror_database_to_external_dir`).
//!
//! A database that predates this file never gets an id, so its mirror keeps working as it always
//! did. Only a database created after it can tell its own copies from older ones, and that is the
//! case the check is for. Reinstalling and pointing the new install at the folder that holds the
//! only copy of the old library.

use std::path::{Path, PathBuf};

use super::sibling;
use crate::services::logger;

pub(super) fn lineage_marker_path(db_path: &Path) -> PathBuf {
    sibling(db_path, ".lineage")
}

/// Gives the database at `db_path`, just created from nothing, a new lineage id. Best effort. A
/// database left without one is mirrored the way one from before lineage ids is.
pub fn record_new_lineage(db_path: &Path) {
    let id = crate::utils::naming::unique_temp_suffix();

    if let Err(error) = crate::services::filesystem::write_file_durably(
        &lineage_marker_path(db_path),
        id.as_bytes(),
    ) {
        logger::warn(
            "db_backup",
            format!("could not record the new database's lineage: {error}"),
        );
    }
}

/// The lineage id of the database at `db_path`, or `None` for one created before ids existed.
pub(super) fn database_lineage(db_path: &Path) -> Option<String> {
    read_id(&lineage_marker_path(db_path))
}

/// Reads an id file, trimmed. Missing, unreadable and blank all read as no id.
pub(super) fn read_id(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|id| !id.is_empty())
}

/// Whether copies labelled `copies_lineage` were made from a database other than the one labelled
/// `database_lineage`. Only a database that has an id can tell, so one without it never calls a copy
/// foreign.
pub(super) fn copies_are_from_another_database(
    database_lineage: Option<&str>,
    copies_lineage: Option<&str>,
) -> bool {
    match database_lineage {
        Some(database) => copies_lineage != Some(database),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_database_with_an_id_calls_copies_foreign() {
        assert!(!copies_are_from_another_database(None, None));
        assert!(!copies_are_from_another_database(None, Some("old")));
        assert!(!copies_are_from_another_database(Some("new"), Some("new")));
        assert!(copies_are_from_another_database(Some("new"), Some("old")));
        assert!(
            copies_are_from_another_database(Some("new"), None),
            "copies with no id were made by an install older than this database"
        );
    }
}
