use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{AppError, AppErrorCode, AppResult};

// u64 counts are annotated `number` (serialized as JSON numbers, not the bigint ts-rs
// emits by default).
#[derive(Serialize, Deserialize, Clone, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct LibrarySummaryInfo {
    #[ts(type = "number")]
    pub total_bytes: u64,
    pub formatted_size: String,
    #[ts(type = "number")]
    pub video_files: u64,
    #[ts(type = "number")]
    pub audio_files: u64,
    #[ts(type = "number")]
    pub thumbnail_files: u64,
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];

    if bytes == 0 {
        return "0 B".to_string();
    }

    let mut value = bytes as f64;
    let mut unit_index = 0usize;

    while value >= 1024.0 && unit_index < UNITS.len() - 1 {
        value /= 1024.0;
        unit_index += 1;
    }

    if unit_index == 0 {
        format!("{} {}", bytes, UNITS[unit_index])
    } else {
        format!("{value:.2} {}", UNITS[unit_index])
    }
}

fn calculate_directory_size(path: &Path) -> AppResult<u64> {
    let metadata = fs::metadata(path).map_err(|e| {
        AppError::from_code(
            AppErrorCode::ReadDirEntryFailed,
            format!("failed to read directory metadata: {e}"),
        )
    })?;

    if metadata.is_file() {
        return Ok(metadata.len());
    }

    let mut total_bytes = 0u64;

    for entry in fs::read_dir(path).map_err(|e| {
        AppError::from_code(
            AppErrorCode::ReadDirEntryFailed,
            format!("failed to read directory entries: {e}"),
        )
    })? {
        let entry = entry.map_err(|e| {
            AppError::from_code(
                AppErrorCode::ReadDirEntryFailed,
                format!("failed to read directory entry: {e}"),
            )
        })?;

        let entry_path = entry.path();
        let entry_metadata = entry.metadata().map_err(|e| {
            AppError::from_code(
                AppErrorCode::ReadDirEntryFailed,
                format!("failed to read entry metadata: {e}"),
            )
        })?;

        if entry_metadata.is_dir() {
            total_bytes = total_bytes.saturating_add(calculate_directory_size(&entry_path)?);
        } else if entry_metadata.is_file() {
            total_bytes = total_bytes.saturating_add(entry_metadata.len());
        }
    }

    Ok(total_bytes)
}

fn count_files_in_directory(path: &Path) -> AppResult<u64> {
    if !path.exists() {
        return Ok(0);
    }

    let metadata = fs::metadata(path).map_err(|e| {
        AppError::from_code(
            AppErrorCode::ReadDirEntryFailed,
            format!("failed to read directory metadata: {e}"),
        )
    })?;

    if metadata.is_file() {
        return Ok(1);
    }

    let mut total_files = 0u64;

    for entry in fs::read_dir(path).map_err(|e| {
        AppError::from_code(
            AppErrorCode::ReadDirEntryFailed,
            format!("failed to read directory entries: {e}"),
        )
    })? {
        let entry = entry.map_err(|e| {
            AppError::from_code(
                AppErrorCode::ReadDirEntryFailed,
                format!("failed to read directory entry: {e}"),
            )
        })?;

        let entry_path = entry.path();
        let entry_metadata = entry.metadata().map_err(|e| {
            AppError::from_code(
                AppErrorCode::ReadDirEntryFailed,
                format!("failed to read entry metadata: {e}"),
            )
        })?;

        if entry_metadata.is_dir() {
            total_files = total_files.saturating_add(count_files_in_directory(&entry_path)?);
        } else if entry_metadata.is_file() {
            total_files = total_files.saturating_add(1);
        }
    }

    Ok(total_files)
}

pub fn summarize_library(library_dir: &Path) -> AppResult<LibrarySummaryInfo> {
    let total_bytes = calculate_directory_size(library_dir)?;
    let video_files = count_files_in_directory(&library_dir.join("video"))?;
    let audio_files = count_files_in_directory(&library_dir.join("audio"))?;
    let thumbnail_files = count_files_in_directory(&library_dir.join("thumbnails"))?;

    Ok(LibrarySummaryInfo {
        total_bytes,
        formatted_size: format_bytes(total_bytes),
        video_files,
        audio_files,
        thumbnail_files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        std::env::temp_dir().join(format!(
            "kavynex-library-summary-test-{}-{}",
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn format_bytes_formats_values_consistently() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(10), "10 B");
        assert_eq!(format_bytes(1024), "1.00 KB");
        assert_eq!(format_bytes(1024 * 1024), "1.00 MB");
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

        let summary = summarize_library(&root).unwrap();

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

        let summary = summarize_library(&root).unwrap();

        assert_eq!(summary.video_files, 0);
        assert_eq!(summary.audio_files, 0);
        assert_eq!(summary.thumbnail_files, 0);
        assert_eq!(summary.total_bytes, 0);

        let _ = fs::remove_dir_all(root);
    }
}
