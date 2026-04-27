use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager};

use crate::constants::{TEMP_DIR_THUMBS, TEMP_DIR_YT_DLP, TEMP_DIR_YT_DLP_THUMB};
use crate::{AppError, AppErrorCode, AppResult};

const TEMP_ENTRY_MAX_AGE_HOURS: u64 = 24 * 7;

#[derive(Debug, Default, Clone)]
pub struct CleanupSummary {
    pub scanned_entries: usize,
    pub removed_entries: usize,
    pub failed_removals: usize,
}

impl CleanupSummary {
    fn merge(&mut self, other: CleanupSummary) {
        self.scanned_entries += other.scanned_entries;
        self.removed_entries += other.removed_entries;
        self.failed_removals += other.failed_removals;
    }
}

fn entry_modified_time(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).ok()?.modified().ok()
}

fn is_older_than_threshold(modified_at: SystemTime, max_age: Duration) -> bool {
    match SystemTime::now().duration_since(modified_at) {
        Ok(age) => age > max_age,
        Err(_) => false,
    }
}

fn remove_path_if_old(path: &Path, max_age: Duration) -> (bool, bool) {
    let Some(modified_at) = entry_modified_time(path) else {
        return (false, false);
    };

    if !is_older_than_threshold(modified_at, max_age) {
        return (false, false);
    }

    let result = if path.is_dir() {
        fs::remove_dir_all(path)
    } else if path.is_file() {
        fs::remove_file(path)
    } else {
        return (false, false);
    };

    match result {
        Ok(_) => (true, false),
        Err(_) => (false, true),
    }
}

fn cleanup_dir_children(dir: &Path, max_age: Duration) -> AppResult<CleanupSummary> {
    let mut summary = CleanupSummary::default();

    if !dir.exists() {
        return Ok(summary);
    }

    if !dir.is_dir() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidTempDirectory,
            "temporary cleanup target is not a directory",
        ));
    }

    for entry in fs::read_dir(dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::TempDirectoryReadFailed,
            format!("failed to read temporary directory: {e}"),
        )
    })? {
        let entry = entry.map_err(|e| {
            AppError::from_code(
                AppErrorCode::TempDirectoryEntryReadFailed,
                format!("failed to read temporary directory entry: {e}"),
            )
        })?;

        summary.scanned_entries += 1;

        let (removed, failed) = remove_path_if_old(&entry.path(), max_age);

        if removed {
            summary.removed_entries += 1;
        }

        if failed {
            summary.failed_removals += 1;
        }
    }

    Ok(summary)
}

pub fn cleanup_stale_temp_files_sync(app: &AppHandle) -> AppResult<CleanupSummary> {
    let cache_dir = app.path().app_cache_dir().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CacheDirectoryResolveFailed,
            format!("failed to resolve cache directory: {e}"),
        )
    })?;

    fs::create_dir_all(&cache_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CacheDirectoryCreateFailed,
            format!("failed to create cache directory: {e}"),
        )
    })?;

    let max_age = Duration::from_secs(TEMP_ENTRY_MAX_AGE_HOURS * 60 * 60);

    let thumbs_temp_dir = cache_dir.join(TEMP_DIR_THUMBS);
    let yt_dlp_temp_dir = cache_dir.join(TEMP_DIR_YT_DLP);
    let yt_dlp_thumb_temp_dir = cache_dir.join(TEMP_DIR_YT_DLP_THUMB);

    let mut summary = CleanupSummary::default();
    summary.merge(cleanup_dir_children(&thumbs_temp_dir, max_age)?);
    summary.merge(cleanup_dir_children(&yt_dlp_temp_dir, max_age)?);
    summary.merge(cleanup_dir_children(&yt_dlp_thumb_temp_dir, max_age)?);

    Ok(summary)
}
