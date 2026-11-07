//! The library's `.trash` folder as a whole. How much it holds, and emptying it on request.
//!
//! What goes in is decided elsewhere. The orphan removal and an unregistered creation move their files
//! there (`library::cleanup`), and so does deleting a media or a channel unless Settings says to delete
//! at once. The startup sweep purges a run folder once it is older than the grace period
//! (`services::temp_cleanup`). This is the user's way to free that space sooner.

use std::path::Path;

use serde::Serialize;

use crate::services::library::cleanup::LIBRARY_TRASH_DIR;
use crate::services::library::paths::resolve_existing_library_dir;
use crate::services::logger;
use crate::AppResult;

/// How much the library trash holds, or how much emptying it freed.
#[derive(Debug, Clone, Default, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct LibraryTrashSummary {
    #[cfg_attr(test, ts(type = "number"))]
    pub files: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub bytes: u64,
    /// [`bytes`](Self::bytes) for display, with the formatter the other sizes in Settings use.
    pub formatted_size: String,
}

impl LibraryTrashSummary {
    fn add(&mut self, other: &LibraryTrashSummary) {
        self.files = self.files.saturating_add(other.files);
        self.bytes = self.bytes.saturating_add(other.bytes);
    }

    fn formatted(mut self) -> Self {
        self.formatted_size = crate::utils::format::format_bytes(self.bytes);
        self
    }
}

/// The files under `path` (or `path` itself, when it is a file) and their total size. A link is
/// counted as neither and never followed, so a link placed in the trash cannot make it report, or
/// empty, anything outside it.
fn summarize(path: &Path) -> LibraryTrashSummary {
    let mut summary = LibraryTrashSummary::default();
    let mut pending = vec![path.to_path_buf()];

    while let Some(current) = pending.pop() {
        let Ok(metadata) = std::fs::symlink_metadata(&current) else {
            continue;
        };

        if metadata.is_file() {
            summary.files += 1;
            summary.bytes = summary.bytes.saturating_add(metadata.len());
        } else if metadata.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&current) {
                pending.extend(entries.flatten().map(|entry| entry.path()));
            }
        }
    }

    summary
}

/// How much the trash of the library at `library_path` holds.
pub fn library_trash_summary_sync(library_path: &str) -> AppResult<LibraryTrashSummary> {
    let library_dir = resolve_existing_library_dir(library_path)?;

    Ok(summarize(&library_dir.join(LIBRARY_TRASH_DIR)).formatted())
}

/// Deletes everything in the trash of the library at `library_path`, for good, and returns what that
/// freed. An entry that cannot be removed (a file another program holds) is logged and left, and the
/// next summary still counts it.
///
/// Holds the library read guard, so a library move cannot run while the trash is being emptied. A
/// link in the trash is removed as a link, never followed.
pub fn empty_library_trash_sync(library_path: &str) -> AppResult<LibraryTrashSummary> {
    let library_dir = resolve_existing_library_dir(library_path)?;
    let trash_dir = library_dir.join(LIBRARY_TRASH_DIR);
    let _library_guard = crate::services::library::lock::library_read_guard();

    let mut freed = LibraryTrashSummary::default();

    let Ok(entries) = std::fs::read_dir(&trash_dir) else {
        return Ok(freed.formatted());
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let held = summarize(&path);

        let removed = match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => std::fs::remove_dir_all(&path),
            _ => std::fs::remove_file(&path),
        };

        match removed {
            Ok(()) => freed.add(&held),
            Err(error) => logger::warn(
                "library_cleanup",
                format!(
                    "a trash entry could not be removed and stays until the next attempt: {error}"
                ),
            ),
        }
    }

    logger::info(
        "library_cleanup",
        format!(
            "emptied the library trash: {} file(s), {} bytes",
            freed.files, freed.bytes
        ),
    );

    Ok(freed.formatted())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kavynex-trash-test-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(dir.join(LIBRARY_TRASH_DIR).join("run-1").join("video")).unwrap();
        dir
    }

    #[test]
    fn the_summary_counts_every_file_in_the_trash() {
        let dir = library();
        let run = dir.join(LIBRARY_TRASH_DIR).join("run-1");
        std::fs::write(run.join("video").join("media_a.mp4"), b"12345").unwrap();
        std::fs::write(run.join("thumb_a.jpg"), b"123").unwrap();

        let summary = library_trash_summary_sync(&dir.to_string_lossy()).unwrap();

        assert_eq!(summary.files, 2);
        assert_eq!(summary.bytes, 8);
        assert!(!summary.formatted_size.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn emptying_the_trash_removes_it_all_and_reports_what_it_freed() {
        let dir = library();
        let run = dir.join(LIBRARY_TRASH_DIR).join("run-1");
        std::fs::write(run.join("video").join("media_a.mp4"), b"12345").unwrap();
        std::fs::write(dir.join(LIBRARY_TRASH_DIR).join("stray.txt"), b"12").unwrap();
        std::fs::create_dir_all(dir.join("video")).unwrap();
        std::fs::write(dir.join("video").join("media_b.mp4"), b"kept").unwrap();

        let freed = empty_library_trash_sync(&dir.to_string_lossy()).unwrap();

        assert_eq!(freed.files, 2);
        assert_eq!(freed.bytes, 7);
        assert_eq!(
            library_trash_summary_sync(&dir.to_string_lossy())
                .unwrap()
                .files,
            0
        );
        assert!(
            dir.join("video").join("media_b.mp4").is_file(),
            "nothing outside the trash is touched"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_library_with_no_trash_reports_and_frees_nothing() {
        let dir = std::env::temp_dir().join(format!(
            "kavynex-trash-none-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        assert_eq!(
            library_trash_summary_sync(&dir.to_string_lossy())
                .unwrap()
                .files,
            0
        );
        assert_eq!(
            empty_library_trash_sync(&dir.to_string_lossy())
                .unwrap()
                .files,
            0
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
