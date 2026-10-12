//! The folders where the app keeps a file it could not put where it belonged, or one it set aside
//! rather than delete, so the user can see that they hold something and open them.
//!
//! The set-aside backups folder (`<app config>/set-aside-backups`) holds the database snapshots that
//! were there when the user started over with an empty database (see
//! `db_backup::set_aside_backups_for_empty_start`). Nothing empties it either.
//! The library trash (`<library>/.trash`) holds what Remove orphan files moved aside, for
//! [`ORPHAN_GRACE_PERIOD`](crate::services::library::cleanup::ORPHAN_GRACE_PERIOD). The recovered
//! downloads folder (`<app local data>/recovered-downloads`) holds a finished download that could
//! not be placed into the library, and nothing ever empties it. Both start with a dot or live in an
//! app directory, so a user who was told "move it back by hand" had no way to find either.
//!
//! The commands take a [`KeptFolder`], never a path, for the same reason `open_log_directory` takes
//! nothing. The folder is derived here, from the settings and from Tauri.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::constants::RECOVERED_DOWNLOADS_DIR;
use crate::services::library::cleanup::LIBRARY_TRASH_DIR;
use crate::{AppError, AppErrorCode, AppResult};

/// How many files a kept folder holds and how much space they take.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct FolderSummary {
    #[cfg_attr(test, ts(type = "number"))]
    pub files: usize,
    #[cfg_attr(test, ts(type = "number"))]
    pub bytes: u64,
}

/// The kept folders, for Diagnostics.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct KeptFilesSummary {
    /// `None` when no library is configured or its folder is not there.
    pub library_trash: Option<FolderSummary>,
    pub recovered_downloads: FolderSummary,
    pub set_aside_backups: FolderSummary,
}

/// Which kept folder to open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum KeptFolder {
    LibraryTrash,
    RecoveredDownloads,
    SetAsideBackups,
}

/// Counts the regular files under `dir` and their sizes. Links are not followed, so the count is
/// what the folder itself holds. A folder that is not there holds nothing.
pub fn folder_summary(dir: &Path) -> FolderSummary {
    let mut summary = FolderSummary::default();
    let mut pending = vec![dir.to_path_buf()];

    while let Some(current) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };

        for entry in entries.flatten() {
            let Ok(metadata) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };

            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                summary.files += 1;
                summary.bytes = summary.bytes.saturating_add(metadata.len());
            }
        }
    }

    summary
}

/// Where a finished download that could not be placed into the library is kept.
///
/// In the app's local data directory rather than its cache. The documentation tells users the cache
/// can be deleted at any time, and OS cleaners empty it, but this file may be the only copy left of
/// a video gone from YouTube. Local rather than roaming, since a download is far too large for a
/// roaming profile to sync. On Windows the local data and cache directories are the same folder, so
/// the files stay where they were and only the documentation changes there.
pub fn recovered_downloads_dir<R: Runtime>(app: &AppHandle<R>) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| {
            AppError::from_code(
                AppErrorCode::DataDirectoryResolveFailed,
                format!("failed to resolve the app's local data directory: {error}"),
            )
        })?
        .join(RECOVERED_DOWNLOADS_DIR);

    std::fs::create_dir_all(&dir).map_err(|error| {
        AppError::fs_error(
            AppErrorCode::CreateDirectoryFailed,
            "failed to create the recovered downloads folder",
            &dir,
            &error,
        )
    })?;

    Ok(dir)
}

/// Where the snapshots set aside by an empty start are kept, beside the database at `db_path`.
pub fn set_aside_backups_dir(db_path: &Path) -> Option<PathBuf> {
    db_path
        .parent()
        .map(|dir| dir.join(crate::services::db_backup::SET_ASIDE_BACKUPS_DIR))
}

/// The library trash under `library_dir`, when it is a real folder there.
pub fn library_trash_dir(library_dir: &Path) -> Option<PathBuf> {
    let trash = library_dir.join(LIBRARY_TRASH_DIR);

    std::fs::symlink_metadata(&trash)
        .is_ok_and(|metadata| metadata.is_dir())
        .then_some(trash)
}

/// Reveals `dir` in the file manager. A folder that holds nothing is reported rather than opened,
/// since the button that calls this is only shown when it holds something.
pub fn reveal_kept_folder(dir: Option<PathBuf>) -> AppResult<()> {
    let Some(dir) = dir.filter(|dir| folder_summary(dir).files > 0) else {
        return Err(AppError::from_code(
            AppErrorCode::KeptFolderEmpty,
            "that folder holds no files",
        ));
    };

    let canonical = dir.canonicalize().map_err(|error| {
        AppError::fs_error(
            AppErrorCode::FolderOpenFailed,
            "failed to resolve the folder",
            &dir,
            &error,
        )
    })?;

    crate::services::file_manager::reveal_canonical_path(&canonical, AppErrorCode::FolderOpenFailed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn unique_test_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-kept-{label}-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    #[test]
    fn a_folder_summary_counts_files_at_any_depth() {
        let dir = unique_test_dir("summary");
        fs::create_dir_all(dir.join("run").join("video")).unwrap();
        fs::write(dir.join("run").join("video").join("a.mp4"), b"12345").unwrap();
        fs::write(dir.join("b.mp4"), b"123").unwrap();

        assert_eq!(folder_summary(&dir), FolderSummary { files: 2, bytes: 8 });

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_folder_holds_nothing() {
        assert_eq!(
            folder_summary(&unique_test_dir("missing")),
            FolderSummary::default()
        );
    }

    #[test]
    fn the_library_trash_is_found_only_when_it_is_a_folder() {
        let library = unique_test_dir("trash");
        fs::create_dir_all(&library).unwrap();
        assert_eq!(library_trash_dir(&library), None);

        fs::create_dir_all(library.join(LIBRARY_TRASH_DIR)).unwrap();
        assert_eq!(
            library_trash_dir(&library),
            Some(library.join(LIBRARY_TRASH_DIR))
        );

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn an_empty_folder_is_reported_rather_than_opened() {
        let dir = unique_test_dir("empty");
        fs::create_dir_all(&dir).unwrap();

        let error = reveal_kept_folder(Some(dir.clone())).unwrap_err();
        assert_eq!(error.code, AppErrorCode::KeptFolderEmpty.as_str());

        let error = reveal_kept_folder(None).unwrap_err();
        assert_eq!(error.code, AppErrorCode::KeptFolderEmpty.as_str());

        let _ = fs::remove_dir_all(&dir);
    }
}
