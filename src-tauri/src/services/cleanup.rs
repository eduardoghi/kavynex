use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager};

use crate::constants::{
    MANAGED_LIBRARY_DIRS, TEMP_DIR_THUMBS, TEMP_DIR_YT_DLP, TEMP_DIR_YT_DLP_THUMB,
};
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

/// True for a filename produced by the atomic-write helpers as scratch and left behind if the
/// process died mid-operation: the copy temp (`.<name>.tmp-<suffix>`, `filesystem.rs`), the
/// replace backup (`.<name>.backup-<suffix>`, `filesystem.rs`), the migration staging name
/// (`<stem>.migrated-<suffix>[.<ext>]`, `filesystem.rs`), and the live-chat gzip temp
/// (`<name>.gztmp`, `live_chat_storage.rs`). None of these infixes/suffixes ever appears in a
/// committed library file (`media_<hash>`, `thumb_<hash>`, `*.live_chat.json.gz`), so matching
/// them cannot touch a real media/thumbnail/live-chat file.
fn is_atomic_write_leftover(file_name: &str) -> bool {
    file_name.contains(".tmp-")
        || file_name.contains(".backup-")
        || file_name.contains(".migrated-")
        || file_name.ends_with(".gztmp")
}

/// True for a replace-backup leftover (`.<name>.backup-<suffix>`, `filesystem.rs::
/// replace_file_safely`). Split out because a backup is the ONLY leftover kind that can hold the
/// sole copy of a live file (see [`replace_backup_target_present`]); the `.tmp-`/`.migrated-`/
/// `.gztmp` kinds are always redundant scratch and safe to reclaim once old.
fn is_replace_backup_leftover(file_name: &str) -> bool {
    file_name.contains(".backup-")
}

/// Whether the live destination a replace-backup was made from still exists next to it.
///
/// `replace_file_safely` renames an existing destination to `.<name>.backup-<suffix>` before
/// writing the replacement, then removes the backup on success. If it crashes (or a double-fault
/// leaves the replacement un-restored), the backup can be the only surviving copy of that file
/// while the live destination is missing. Reconstructs the live name (`.video.mp4.backup-1-2`
/// -> `video.mp4`) and reports whether it is present, so the sweep can keep a backup whose live
/// file is gone instead of deleting the last copy.
fn replace_backup_target_present(backup_path: &Path) -> bool {
    let Some(file_name) = backup_path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };

    let Some(without_dot) = file_name.strip_prefix('.') else {
        return false;
    };

    let Some((live_name, _)) = without_dot.rsplit_once(".backup-") else {
        return false;
    };

    if live_name.is_empty() {
        return false;
    }

    backup_path.with_file_name(live_name).exists()
}

/// Removes atomic-write leftovers from a single managed library subdirectory. Unlike
/// `cleanup_dir_children` (which removes *any* stale entry and is only ever pointed at a
/// disposable cache dir), this only ever removes files whose name matches
/// `is_atomic_write_leftover`, so it is safe to run against the library, which also holds the
/// user's real media. The age gate still applies, so a leftover from an operation currently in
/// flight (its temp file is recent) is never removed out from under it.
fn cleanup_leftovers_in_dir(dir: &Path, max_age: Duration) -> AppResult<CleanupSummary> {
    let mut summary = CleanupSummary::default();

    if !dir.exists() {
        return Ok(summary);
    }

    if !dir.is_dir() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidTempDirectory,
            "library leftover cleanup target is not a directory",
        ));
    }

    for entry in fs::read_dir(dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::TempDirectoryReadFailed,
            format!("failed to read library directory: {e}"),
        )
    })? {
        let entry = entry.map_err(|e| {
            AppError::from_code(
                AppErrorCode::TempDirectoryEntryReadFailed,
                format!("failed to read library directory entry: {e}"),
            )
        })?;

        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        let matches_leftover = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(is_atomic_write_leftover)
            .unwrap_or(false);

        if !matches_leftover {
            continue;
        }

        // A replace-backup whose live destination is missing is not reclaimable scratch: it can
        // be the sole surviving copy of that file after a failed replace/restore (see
        // filesystem.rs::replace_file_safely). Keep it so the file can still be recovered by
        // hand, rather than turning a transient replace failure into permanent data loss a week
        // later. A backup whose live file is present is genuinely redundant and still reclaimed.
        let name_is_replace_backup = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(is_replace_backup_leftover)
            .unwrap_or(false);

        if name_is_replace_backup && !replace_backup_target_present(&path) {
            continue;
        }

        summary.scanned_entries += 1;

        let (removed, failed) = remove_path_if_old(&path, max_age);

        if removed {
            summary.removed_entries += 1;
        }

        if failed {
            summary.failed_removals += 1;
        }
    }

    Ok(summary)
}

/// Sweeps the library's managed subdirectories (video/audio/thumbnails/live_chat) for
/// atomic-write leftovers a crashed copy/replace/migrate left behind. The startup cache sweep
/// (`cleanup_stale_temp_files_sync`) never reaches these, because they live inside the library
/// tree next to the real files rather than in the disposable cache directories. Reported by
/// `library_integrity` as orphans until now, but nothing removed them.
pub fn cleanup_library_leftovers_sync(library_dir: &Path) -> AppResult<CleanupSummary> {
    let mut summary = CleanupSummary::default();

    if !library_dir.exists() {
        return Ok(summary);
    }

    let max_age = Duration::from_secs(TEMP_ENTRY_MAX_AGE_HOURS * 60 * 60);

    for dir_name in MANAGED_LIBRARY_DIRS {
        summary.merge(cleanup_leftovers_in_dir(
            &library_dir.join(dir_name),
            max_age,
        )?);
    }

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
    fn is_atomic_write_leftover_matches_only_scratch_names() {
        for name in [
            ".media_abc.mp4.tmp-123-456",
            ".thumb_abc.jpg.backup-123-456",
            "clip.migrated-123-456.mp4",
            "clip.migrated-123-456",
            "video.live_chat.json.gz.gztmp",
        ] {
            assert!(is_atomic_write_leftover(name), "{name} should match");
        }

        for name in [
            "media_abcdef.mp4",
            "thumb_abcdef.jpg",
            "video.live_chat.json.gz",
            "notes.txt",
        ] {
            assert!(!is_atomic_write_leftover(name), "{name} should not match");
        }
    }

    #[test]
    fn replace_backup_target_present_reflects_the_live_file() {
        let dir = unique_test_dir("backup-target");
        fs::create_dir_all(&dir).unwrap();

        let backup = dir.join(".video.mp4.backup-1-2");
        fs::write(&backup, b"original bytes").unwrap();

        // No live `video.mp4` next to it: the backup may be the only surviving copy.
        assert!(!replace_backup_target_present(&backup));

        // Once the live file exists, the backup is genuinely redundant.
        fs::write(dir.join("video.mp4"), b"live bytes").unwrap();
        assert!(replace_backup_target_present(&backup));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cleanup_library_leftovers_removes_only_stale_scratch_files() {
        let library = unique_test_dir("library-leftovers");
        let video_dir = library.join("video");
        let thumbs_dir = library.join("thumbnails");
        fs::create_dir_all(&video_dir).unwrap();
        fs::create_dir_all(&thumbs_dir).unwrap();

        let max_age = Duration::from_secs(TEMP_ENTRY_MAX_AGE_HOURS * 60 * 60);

        // A real media file (old) must never be removed, even though it is past the age gate.
        let real_media = video_dir.join("media_abcdef.mp4");
        make_old_file(&real_media, max_age);

        // A stale copy-temp and a stale replace-backup whose live file is present are redundant
        // scratch and must be removed. The live thumbnail makes the backup genuinely redundant.
        let live_thumb = thumbs_dir.join("thumb_abcdef.jpg");
        make_old_file(&live_thumb, max_age);
        let stale_temp = video_dir.join(".media_abcdef.mp4.tmp-1-2");
        let stale_backup = thumbs_dir.join(".thumb_abcdef.jpg.backup-1-2");
        make_old_file(&stale_temp, max_age);
        make_old_file(&stale_backup, max_age);

        // A leftover from an operation still in flight (recent) must be preserved.
        let recent_temp = video_dir.join(".media_ghijkl.mp4.tmp-3-4");
        make_recent_file(&recent_temp);

        let summary = cleanup_library_leftovers_sync(&library).unwrap();

        assert_eq!(summary.removed_entries, 2);
        assert_eq!(summary.failed_removals, 0);
        assert!(real_media.exists(), "a real media file must be kept");
        assert!(live_thumb.exists(), "a real thumbnail must be kept");
        assert!(!stale_temp.exists());
        assert!(!stale_backup.exists());
        assert!(recent_temp.exists(), "an in-flight leftover must be kept");

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn cleanup_library_leftovers_keeps_a_backup_whose_live_file_is_missing() {
        // A double-fault in replace_file_safely can leave the original bytes only in the
        // `.backup-` file while the live destination is gone. The sweep must not delete such a
        // backup, or a transient replace failure becomes permanent data loss a week later.
        let library = unique_test_dir("library-backup-missing");
        let live_chat_dir = library.join("live_chat");
        fs::create_dir_all(&live_chat_dir).unwrap();

        let max_age = Duration::from_secs(TEMP_ENTRY_MAX_AGE_HOURS * 60 * 60);

        // A stale backup with NO live `clip.live_chat.json.gz` next to it (the only surviving copy).
        let orphaned_backup = live_chat_dir.join(".clip.live_chat.json.gz.backup-1-2");
        make_old_file(&orphaned_backup, max_age);

        let summary = cleanup_library_leftovers_sync(&library).unwrap();

        assert_eq!(
            summary.removed_entries, 0,
            "the sole-copy backup must be kept"
        );
        assert!(
            orphaned_backup.exists(),
            "a backup whose live file is missing must not be deleted"
        );

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn cleanup_library_leftovers_is_a_noop_for_a_missing_library() {
        let library = unique_test_dir("missing-library");

        let summary = cleanup_library_leftovers_sync(&library).unwrap();

        assert_eq!(summary.scanned_entries, 0);
        assert_eq!(summary.removed_entries, 0);
        assert_eq!(summary.failed_removals, 0);
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
