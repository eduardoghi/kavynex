use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use crate::{AppError, AppErrorCode, AppResult};

/// Tracks one in-flight download. The `cancel_flag` is polled cooperatively by the
/// download loop (per-run cancellation), while `pid` records the spawned yt-dlp child so
/// its whole process tree can be killed when the app exits, before the async runtime is
/// torn down.
struct DownloadHandle {
    cancel_flag: Arc<AtomicBool>,
    pid: Option<u32>,
}

/// Backed by a `std::sync::Mutex` (not tokio's) so the registry can be inspected
/// synchronously from the app-exit handler, which must not depend on the async runtime.
/// Critical sections are short and never span an `.await`.
fn active_downloads() -> &'static Mutex<HashMap<String, DownloadHandle>> {
    static ACTIVE_DOWNLOADS: OnceLock<Mutex<HashMap<String, DownloadHandle>>> = OnceLock::new();
    ACTIVE_DOWNLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_registry() -> MutexGuard<'static, HashMap<String, DownloadHandle>> {
    // A panic while holding the lock would only happen in these tiny critical sections;
    // recover the guard rather than propagating poisoning as a hard failure.
    active_downloads()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn register_download_run(run_id: &str) -> AppResult<Arc<AtomicBool>> {
    let mut guard = lock_registry();

    if guard.contains_key(run_id) {
        return Err(AppError::from_code(
            AppErrorCode::YtDlpRunAlreadyActive,
            "run_id is already active",
        ));
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    guard.insert(
        run_id.to_string(),
        DownloadHandle {
            cancel_flag: Arc::clone(&cancel_flag),
            pid: None,
        },
    );

    Ok(cancel_flag)
}

/// Records the process id of the spawned yt-dlp child so it can be killed on app exit.
pub fn set_download_pid(run_id: &str, pid: u32) {
    let mut guard = lock_registry();

    if let Some(handle) = guard.get_mut(run_id) {
        handle.pid = Some(pid);
    }
}

pub fn unregister_download_run(run_id: &str) {
    let mut guard = lock_registry();
    guard.remove(run_id);
}

/// Marks every active download as cancelled and returns the process ids of those whose
/// child has already been spawned. Used by the app-exit handler to terminate in-flight
/// downloads.
pub fn signal_cancel_all_and_collect_pids() -> Vec<u32> {
    let guard = lock_registry();

    guard
        .values()
        .filter_map(|handle| {
            handle.cancel_flag.store(true, Ordering::SeqCst);
            handle.pid
        })
        .collect()
}

pub fn cancel_media_download(run_id: &str) -> AppResult<()> {
    let normalized_run_id = run_id.trim();

    if normalized_run_id.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidRunId,
            "run_id is empty",
        ));
    }

    let guard = lock_registry();

    let handle = guard.get(normalized_run_id).ok_or_else(|| {
        AppError::from_code(
            AppErrorCode::InvalidRunId,
            format!("run_id '{}' is not active", normalized_run_id),
        )
    })?;

    handle.cancel_flag.store(true, Ordering::SeqCst);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The registry is process-global state, so serialize the tests that mutate it to keep
    // them deterministic under Rust's parallel test runner.
    static TEST_GUARD: Mutex<()> = Mutex::new(());

    fn serial_guard() -> MutexGuard<'static, ()> {
        TEST_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn register_download_run_creates_cancel_flag() {
        let _serial = serial_guard();
        let run_id = "test-run-1";

        let flag = register_download_run(run_id).unwrap();

        assert!(!flag.load(Ordering::SeqCst));

        unregister_download_run(run_id);
    }

    #[test]
    fn register_download_run_rejects_duplicate_run_id() {
        let _serial = serial_guard();
        let run_id = "test-run-2";

        let _ = register_download_run(run_id).unwrap();
        let duplicate = register_download_run(run_id);

        assert!(duplicate.is_err());

        unregister_download_run(run_id);
    }

    #[test]
    fn cancel_media_download_marks_existing_flag() {
        let _serial = serial_guard();
        let run_id = "test-run-3";

        let flag = register_download_run(run_id).unwrap();
        cancel_media_download(run_id).unwrap();

        assert!(flag.load(Ordering::SeqCst));

        unregister_download_run(run_id);
    }

    #[test]
    fn cancel_media_download_rejects_unknown_run_id() {
        let _serial = serial_guard();
        let result = cancel_media_download("unknown-run");
        assert!(result.is_err());
    }

    #[test]
    fn cancel_media_download_rejects_empty_run_id() {
        let _serial = serial_guard();
        let result = cancel_media_download("   ");
        assert!(result.is_err());
    }

    #[test]
    fn set_download_pid_records_pid_for_active_run() {
        let _serial = serial_guard();
        let run_id = "test-run-pid";

        let flag = register_download_run(run_id).unwrap();
        set_download_pid(run_id, 4321);

        let pids = signal_cancel_all_and_collect_pids();

        assert!(pids.contains(&4321));
        assert!(flag.load(Ordering::SeqCst));

        unregister_download_run(run_id);
    }

    #[test]
    fn signal_cancel_all_skips_runs_without_a_pid() {
        let _serial = serial_guard();
        let run_id = "test-run-no-pid";

        let flag = register_download_run(run_id).unwrap();

        let pids = signal_cancel_all_and_collect_pids();

        // The run is cancelled but contributes no pid since its child never spawned.
        assert!(flag.load(Ordering::SeqCst));
        assert!(!pids.contains(&0));

        unregister_download_run(run_id);
    }
}
