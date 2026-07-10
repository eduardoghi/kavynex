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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::UNIX_EPOCH;

    fn unique_test_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        std::env::temp_dir().join(format!(
            "kavynex-cleanup-test-{}-{}-{}",
            prefix,
            std::process::id(),
            nanos
        ))
    }

    fn set_modified(path: &Path, time: SystemTime) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(time).unwrap();
    }

    fn make_old_file(path: &Path, max_age: Duration) {
        fs::write(path, b"stale").unwrap();
        set_modified(path, SystemTime::now() - max_age - Duration::from_secs(60));
    }

    fn make_recent_file(path: &Path) {
        fs::write(path, b"fresh").unwrap();
        set_modified(path, SystemTime::now());
    }

    #[test]
    fn is_older_than_threshold_true_for_a_time_beyond_the_max_age() {
        let max_age = Duration::from_secs(60);
        let modified_at = SystemTime::now() - max_age - Duration::from_secs(1);

        assert!(is_older_than_threshold(modified_at, max_age));
    }

    #[test]
    fn is_older_than_threshold_false_for_a_recent_time() {
        let max_age = Duration::from_secs(60);
        let modified_at = SystemTime::now();

        assert!(!is_older_than_threshold(modified_at, max_age));
    }

    #[test]
    fn remove_path_if_old_removes_an_old_file() {
        let dir = unique_test_dir("remove-old-file");
        fs::create_dir_all(&dir).unwrap();
        let max_age = Duration::from_secs(60);
        let target = dir.join("stale.tmp");
        make_old_file(&target, max_age);

        let (removed, failed) = remove_path_if_old(&target, max_age);

        assert!(removed);
        assert!(!failed);
        assert!(!target.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_path_if_old_preserves_a_recent_file() {
        let dir = unique_test_dir("preserve-recent-file");
        fs::create_dir_all(&dir).unwrap();
        let max_age = Duration::from_secs(60);
        let target = dir.join("fresh.tmp");
        make_recent_file(&target);

        let (removed, failed) = remove_path_if_old(&target, max_age);

        assert!(!removed);
        assert!(!failed);
        assert!(target.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_path_if_old_is_a_noop_for_a_missing_path() {
        let dir = unique_test_dir("missing-path");
        let target = dir.join("does-not-exist.tmp");

        let (removed, failed) = remove_path_if_old(&target, Duration::from_secs(60));

        assert!(!removed);
        assert!(!failed);
    }

    #[test]
    fn cleanup_dir_children_returns_empty_summary_for_nonexistent_dir() {
        let dir = unique_test_dir("nonexistent");

        let summary = cleanup_dir_children(&dir, Duration::from_secs(60)).unwrap();

        assert_eq!(summary.scanned_entries, 0);
        assert_eq!(summary.removed_entries, 0);
        assert_eq!(summary.failed_removals, 0);
    }

    #[test]
    fn cleanup_dir_children_returns_empty_summary_for_empty_dir() {
        let dir = unique_test_dir("empty");
        fs::create_dir_all(&dir).unwrap();

        let summary = cleanup_dir_children(&dir, Duration::from_secs(60)).unwrap();

        assert_eq!(summary.scanned_entries, 0);
        assert_eq!(summary.removed_entries, 0);
        assert_eq!(summary.failed_removals, 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cleanup_dir_children_removes_old_entries_and_keeps_recent_ones() {
        let dir = unique_test_dir("mixed");
        fs::create_dir_all(&dir).unwrap();
        let max_age = Duration::from_secs(60);

        let old = dir.join("old.tmp");
        let recent = dir.join("recent.tmp");
        make_old_file(&old, max_age);
        make_recent_file(&recent);

        let summary = cleanup_dir_children(&dir, max_age).unwrap();

        assert_eq!(summary.scanned_entries, 2);
        assert_eq!(summary.removed_entries, 1);
        assert_eq!(summary.failed_removals, 0);
        assert!(!old.exists());
        assert!(recent.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(unix)]
    fn cleanup_dir_children_continues_past_an_inaccessible_entry() {
        use std::os::unix::fs::symlink;

        let dir = unique_test_dir("dangling-symlink");
        fs::create_dir_all(&dir).unwrap();
        let max_age = Duration::from_secs(60);

        // A symlink whose target does not exist: `fs::metadata` (which follows symlinks)
        // fails on it, so `entry_modified_time` returns None. This must not abort the sweep
        // of the remaining entries.
        symlink(dir.join("does-not-exist"), dir.join("dangling")).unwrap();

        let old = dir.join("old.tmp");
        let recent = dir.join("recent.tmp");
        make_old_file(&old, max_age);
        make_recent_file(&recent);

        let summary = cleanup_dir_children(&dir, max_age).unwrap();

        assert_eq!(summary.scanned_entries, 3);
        assert_eq!(summary.removed_entries, 1);
        assert_eq!(summary.failed_removals, 0);
        assert!(!old.exists());
        assert!(recent.exists());

        let _ = fs::remove_dir_all(&dir);
    }
}
