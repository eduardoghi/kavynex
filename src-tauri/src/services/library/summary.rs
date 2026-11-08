use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::constants::{LIBRARY_DIR_AUDIO, LIBRARY_DIR_THUMBNAILS, LIBRARY_DIR_VIDEO};
use crate::services::filesystem::dir_entry_is_symlink;
use crate::utils::format::format_bytes;
use crate::{AppError, AppErrorCode, AppResult};

// u64 counts are annotated `number` (serialized as JSON numbers, not the bigint ts-rs
// emits by default).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct LibrarySummaryInfo {
    #[cfg_attr(test, ts(type = "number"))]
    pub total_bytes: u64,
    pub formatted_size: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub video_files: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub audio_files: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub thumbnail_files: u64,
    /// How many of [`thumbnail_files`](Self::thumbnail_files) are a channel's avatar or banner and
    /// no media's thumbnail. They share `thumbnails/` with the media thumbnails, and Diagnostics
    /// compares only the latter with the media rows.
    #[cfg_attr(test, ts(type = "number"))]
    pub channel_image_files: u64,
}

/// Calls `visit` with the path and size of every regular file under `path` (or `path` itself, when
/// it is a file), in one walk.
///
/// Fallible where [`crate::services::filesystem::walk_regular_files`] is best effort, because a
/// summary that silently skipped an unreadable folder would report a smaller library than there is.
/// What is removed while the walk runs (a download's or an import's `.tmp` files, a download's run
/// folder) is skipped rather than failing it.
fn visit_regular_files(path: &Path, visit: &mut impl FnMut(&Path, u64)) -> AppResult<()> {
    let metadata = fs::metadata(path).map_err(|e| {
        AppError::fs_error(
            AppErrorCode::ReadDirEntryFailed,
            "failed to read directory metadata",
            path,
            &e,
        )
    })?;

    if metadata.is_file() {
        visit(path, metadata.len());
        return Ok(());
    }

    for entry in fs::read_dir(path).map_err(|e| {
        AppError::fs_error(
            AppErrorCode::ReadDirEntryFailed,
            "failed to read directory entries",
            path,
            &e,
        )
    })? {
        let entry = entry.map_err(|e| {
            AppError::fs_error(
                AppErrorCode::ReadDirEntryFailed,
                "failed to read directory entry",
                path,
                &e,
            )
        })?;

        // Skip symlinks without following them. A symlinked directory pointing at an ancestor
        // would recurse forever (a DoS reachable through get_library_summary). The library never
        // creates symlinks of its own.
        if dir_entry_is_symlink(&entry) {
            continue;
        }

        let entry_path = entry.path();
        let entry_metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            // Listed and then renamed or removed before it could be read. Gone is not an error.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                return Err(AppError::fs_error(
                    AppErrorCode::ReadDirEntryFailed,
                    "failed to read entry metadata",
                    &entry_path,
                    &e,
                ))
            }
        };

        if entry_metadata.is_dir() {
            match visit_regular_files(&entry_path, visit) {
                Ok(()) => {}
                // A folder removed after it was listed. See above.
                Err(_) if !entry_path.exists() => continue,
                Err(error) => return Err(error),
            }
        } else if entry_metadata.is_file() {
            visit(&entry_path, entry_metadata.len());
        }
    }

    Ok(())
}

/// `channel_only_images` is what the database names as a channel's avatar or banner and no media's
/// thumbnail. Each one that is a file in the library counts toward `channel_image_files`.
pub fn summarize_library(
    library_dir: &Path,
    channel_only_images: &[String],
) -> AppResult<LibrarySummaryInfo> {
    // One walk for the size and the three counts, which used to be four walks over the same files.
    let mut total_bytes = 0u64;
    let (mut video_files, mut audio_files, mut thumbnail_files) = (0u64, 0u64, 0u64);

    visit_regular_files(library_dir, &mut |file, bytes| {
        total_bytes = total_bytes.saturating_add(bytes);

        let top_folder = file
            .strip_prefix(library_dir)
            .ok()
            .and_then(|relative| relative.components().next())
            .and_then(|component| component.as_os_str().to_str());

        match top_folder {
            Some(LIBRARY_DIR_VIDEO) => video_files += 1,
            Some(LIBRARY_DIR_AUDIO) => audio_files += 1,
            Some(LIBRARY_DIR_THUMBNAILS) => thumbnail_files += 1,
            _ => {}
        }
    })?;
    let channel_image_files = channel_only_images
        .iter()
        .filter(|relative| {
            crate::utils::path::absolute_path_from_relative(
                library_dir,
                relative,
                crate::utils::path::ManagedSubtree::Thumbnails,
            )
            .is_ok_and(|path| path.is_file())
        })
        .count() as u64;

    Ok(LibrarySummaryInfo {
        total_bytes,
        formatted_size: format_bytes(total_bytes),
        video_files,
        audio_files,
        thumbnail_files,
        channel_image_files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn unique_test_dir() -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-library-summary-test-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    #[test]
    fn summarize_library_counts_the_channel_images_that_are_there() {
        let root = unique_test_dir();
        let thumbs_dir = root.join("thumbnails");
        fs::create_dir_all(&thumbs_dir).unwrap();
        fs::write(thumbs_dir.join("avatar.jpg"), b"1").unwrap();
        fs::write(thumbs_dir.join("media.jpg"), b"1").unwrap();

        let summary = summarize_library(
            &root,
            &[
                "thumbnails/avatar.jpg".to_string(),
                // Named by a channel and gone from the disk, so not counted.
                "thumbnails/missing.jpg".to_string(),
            ],
        )
        .unwrap();

        assert_eq!(summary.thumbnail_files, 2);
        assert_eq!(summary.channel_image_files, 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn summarize_library_counts_files_and_size() {
        let root = unique_test_dir();
        let video_dir = root.join("video");
        let audio_dir = root.join("audio");
        let thumbs_dir = root.join("thumbnails");

        fs::create_dir_all(&video_dir).unwrap();
        fs::create_dir_all(&audio_dir).unwrap();
        fs::create_dir_all(&thumbs_dir).unwrap();

        fs::write(video_dir.join("a.mp4"), b"1234").unwrap();
        fs::write(audio_dir.join("a.mp3"), b"12").unwrap();
        fs::write(thumbs_dir.join("a.jpg"), b"123").unwrap();

        let summary = summarize_library(&root, &[]).unwrap();

        assert_eq!(summary.video_files, 1);
        assert_eq!(summary.audio_files, 1);
        assert_eq!(summary.thumbnail_files, 1);
        assert_eq!(summary.total_bytes, 9);
        assert_eq!(summary.formatted_size, "9 B");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn summarize_library_treats_missing_subdirectories_as_zero() {
        let root = unique_test_dir();
        fs::create_dir_all(&root).unwrap();

        let summary = summarize_library(&root, &[]).unwrap();

        assert_eq!(summary.video_files, 0);
        assert_eq!(summary.audio_files, 0);
        assert_eq!(summary.thumbnail_files, 0);
        assert_eq!(summary.total_bytes, 0);

        let _ = fs::remove_dir_all(root);
    }
}
