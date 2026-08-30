use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager, Runtime};

use crate::constants::{
    MANAGED_LIBRARY_DIRS, TEMP_DIR_THUMBS, TEMP_DIR_THUMB_DISPLAY, TEMP_DIR_YT_DLP,
    TEMP_DIR_YT_DLP_THUMB,
};
use crate::services::thumbnail::display::{
    display_cache_max_bytes, plan_display_cache_eviction, CachedDerivative,
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

/// Trims the display-thumbnail cache to its size budget, dropping the oldest derivatives first.
///
/// Kept apart from [`cleanup_dir_children`] because the two answer different questions. That one
/// asks "is this entry stale?", which is the right question for the three scratch directories. An
/// old entry there is state from an operation that already finished. This cache holds *derived*
/// data. Each entry is regenerable, but only by spawning FFmpeg, and reading a cached one is a
/// `stat` that renews nothing. Asking the age question of it therefore discarded the entries the
/// grid draws daily as readily as the ones nothing had touched since they were written, emptying the
/// whole cache every seven days and paying it all back as a burst of FFmpeg runs on the next scroll.
///
/// So the question here is "does the cache fit?", and when it does, nothing is removed at all.
/// [`plan_display_cache_eviction`] holds the decision itself (pure, and under the mutation gate);
/// this is the `read_dir` around it.
fn cleanup_display_cache(dir: &Path, max_bytes: u64) -> AppResult<CleanupSummary> {
    let mut summary = CleanupSummary::default();

    if !dir.exists() {
        return Ok(summary);
    }

    if !dir.is_dir() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidTempDirectory,
            "display thumbnail cache target is not a directory",
        ));
    }

    let mut entries = Vec::new();

    for entry in fs::read_dir(dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::TempDirectoryReadFailed,
            format!("failed to read the display thumbnail cache directory: {e}"),
        )
    })? {
        let entry = entry.map_err(|e| {
            AppError::from_code(
                AppErrorCode::TempDirectoryEntryReadFailed,
                format!("failed to read a display thumbnail cache entry: {e}"),
            )
        })?;

        summary.scanned_entries += 1;

        let path = entry.path();

        // An entry whose metadata cannot be read is left in place and left out of the total, so an
        // unreadable file can neither be evicted nor push a readable one out. Same direction as
        // every other uncertain case in this tree. Refusing to act costs a sweep, acting on a wrong
        // answer costs a file.
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };

        if !metadata.is_file() {
            continue;
        }

        let Ok(modified_at) = metadata.modified() else {
            continue;
        };

        entries.push(CachedDerivative {
            path,
            size_bytes: metadata.len(),
            modified_at,
        });
    }

    for path in plan_display_cache_eviction(entries, max_bytes) {
        match fs::remove_file(&path) {
            Ok(()) => summary.removed_entries += 1,
            Err(_) => summary.failed_removals += 1,
        }
    }

    Ok(summary)
}

pub fn cleanup_stale_temp_files_sync<R: Runtime>(app: &AppHandle<R>) -> AppResult<CleanupSummary> {
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
    // Bounded by total size rather than by age, unlike the three above. See cleanup_display_cache
    // for why the age question is the wrong one to ask of a derivative cache.
    let thumb_display_dir = cache_dir.join(TEMP_DIR_THUMB_DISPLAY);

    let mut summary = CleanupSummary::default();
    summary.merge(cleanup_dir_children(&thumbs_temp_dir, max_age)?);
    summary.merge(cleanup_dir_children(&yt_dlp_temp_dir, max_age)?);
    summary.merge(cleanup_dir_children(&yt_dlp_thumb_temp_dir, max_age)?);
    summary.merge(cleanup_display_cache(
        &thumb_display_dir,
        display_cache_max_bytes(),
    )?);

    Ok(summary)
}

/// True for a filename produced by the atomic-write helpers as scratch and left behind if the
/// process died mid-operation, covering the copy temp (`.<name>.tmp-<suffix>`, `filesystem.rs`), the
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

        // A replace-backup whose live destination is missing is not reclaimable scratch. It can
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
/// `library::integrity` as orphans until now, but nothing removed them.
///
/// Runs under the library read guard like every other function that unlinks inside the library
/// (`library::media::delete_media_file_sync`, `thumbnail::persist::delete_thumbnail_file_sync`,
/// `library::cleanup::delete_live_chat_file_at`), so it cannot remove a file out of a tree a
/// migration is in the middle of copying. The exposure was small (the sweep runs once, early, and
/// only reaches week-old scratch names), but it was the one library unlink outside the gate, and a
/// rule with an exception is two rules. Nothing below acquires a second guard, which the gate's
/// debug-only nesting check would refuse.
pub fn cleanup_library_leftovers_sync(library_dir: &Path) -> AppResult<CleanupSummary> {
    let mut summary = CleanupSummary::default();

    if !library_dir.exists() {
        return Ok(summary);
    }

    let _library_guard = crate::services::library::lock::library_read_guard();

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

    fn unique_test_dir(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-cleanup-test-{prefix}-{}",
            crate::utils::naming::unique_temp_suffix()
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
    fn the_display_cache_is_left_alone_while_it_fits_however_old_it_is() {
        // The regression this replaced the age sweep to prevent. Both files are far past the age
        // gate the three scratch directories use, and the cache is well under its budget, so nothing
        // may be removed, under the old rule both would have gone and both would have been
        // re-encoded by FFmpeg on the next scroll.
        let dir = unique_test_dir("display-fits");
        fs::create_dir_all(&dir).unwrap();

        let ancient = dir.join("a.jpg");
        let also_ancient = dir.join("b.jpg");
        make_old_file(
            &ancient,
            Duration::from_secs(TEMP_ENTRY_MAX_AGE_HOURS * 60 * 60),
        );
        make_old_file(
            &also_ancient,
            Duration::from_secs(TEMP_ENTRY_MAX_AGE_HOURS * 60 * 60),
        );

        let summary = cleanup_display_cache(&dir, display_cache_max_bytes()).unwrap();

        assert_eq!(summary.scanned_entries, 2);
        assert_eq!(
            summary.removed_entries, 0,
            "a cache that fits is not touched"
        );
        assert!(ancient.exists());
        assert!(also_ancient.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_display_cache_is_trimmed_to_its_budget_oldest_first() {
        // Over budget, so it is trimmed rather than emptied. The newest entry survives because the
        // older ones already covered the overage.
        let dir = unique_test_dir("display-trim");
        fs::create_dir_all(&dir).unwrap();

        let oldest = dir.join("oldest.jpg");
        let newest = dir.join("newest.jpg");
        fs::write(&oldest, vec![0u8; 80]).unwrap();
        fs::write(&newest, vec![0u8; 80]).unwrap();
        set_modified(&oldest, SystemTime::now() - Duration::from_secs(600));
        set_modified(&newest, SystemTime::now());

        // 160 bytes against a 100-byte budget. 60 have to go, which the oldest entry covers alone.
        let summary = cleanup_display_cache(&dir, 100).unwrap();

        assert_eq!(summary.removed_entries, 1);
        assert_eq!(summary.failed_removals, 0);
        assert!(!oldest.exists(), "the oldest derivative is the one dropped");
        assert!(newest.exists(), "the newest derivative must survive");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_display_cache_sweep_is_a_noop_for_a_missing_directory() {
        // The first launch after an install, and every launch on a machine without FFmpeg. The
        // directory is only created when a derivative is first written.
        let dir = unique_test_dir("display-missing");

        let summary = cleanup_display_cache(&dir, display_cache_max_bytes()).unwrap();

        assert_eq!(summary.scanned_entries, 0);
        assert_eq!(summary.removed_entries, 0);
        assert_eq!(summary.failed_removals, 0);
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

        // No live `video.mp4` next to it. The backup may be the only surviving copy.
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
    fn cleanup_library_leftovers_waits_for_a_migration_to_release_the_library() {
        // The sweep unlinks inside the library, so it has to queue behind a migration's write
        // guard like every other library unlink does. Same shape as the lock module's own test.
        // Hold the write side, start the sweep on another thread, and assert it reports nothing
        // until the write side is released.
        let root = unique_test_dir("leftovers-guard");
        let video_dir = root.join("video");
        fs::create_dir_all(&video_dir).unwrap();
        let stale = video_dir.join(".tmp-old");
        make_old_file(
            &stale,
            Duration::from_secs(TEMP_ENTRY_MAX_AGE_HOURS * 60 * 60),
        );

        let write = crate::services::library::lock::library_write_guard();

        let (tx, rx) = std::sync::mpsc::channel();
        let sweep_root = root.clone();
        let handle = std::thread::spawn(move || {
            let summary = cleanup_library_leftovers_sync(&sweep_root).unwrap();
            let _ = tx.send(summary.removed_entries);
        });

        assert!(
            rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "the sweep must not run while a migration holds the write side"
        );
        assert!(
            stale.exists(),
            "nothing may be unlinked while the write side is held"
        );

        drop(write);

        let removed = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the sweep must run once the write side is released");
        assert_eq!(removed, 1);
        assert!(!stale.exists());

        handle.join().unwrap();
        let _ = fs::remove_dir_all(&root);
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

        // A symlink whose target does not exist. `fs::metadata` (which follows symlinks)
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
