//! Process-wide registry of every external child (yt-dlp/ffmpeg) currently running.
//!
//! The per-download registry in [`crate::services::yt_dlp_registry`] only knows about the
//! main download child, whose pid is recorded after it spawns. The phases that run *before*
//! that child exists - metadata resolution and the pre-download thumbnail fetch - and the
//! standalone fetches that never go through a download run at all (format listing, comment
//! backup, channel-avatar download) spawn their own yt-dlp/ffmpeg trees that were previously
//! tracked by nothing. On app exit those were left to `kill_on_drop`, which only reaps the
//! direct child and not the ffmpeg grandchild yt-dlp spawns for a merge/`--convert-thumbnails`,
//! and whose drop is not even guaranteed to run during runtime teardown.
//!
//! This registry closes that gap: every spawn helper registers its child pid here for the
//! child's lifetime, and the app-exit handler tree-kills the whole set. It is backed by a
//! `std::sync::Mutex` (not tokio's) so the exit handler can drain it synchronously without
//! touching the async runtime, mirroring `yt_dlp_registry`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

fn tracked_processes() -> &'static Mutex<HashMap<u64, u32>> {
    static TRACKED: OnceLock<Mutex<HashMap<u64, u32>>> = OnceLock::new();
    TRACKED.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_registry() -> MutexGuard<'static, HashMap<u64, u32>> {
    // The critical sections here are tiny (a single insert/remove/collect) and never span an
    // `.await`, so a poisoned lock can only mean an unrelated panic; recover the guard rather
    // than turning that into a hard failure that would leak the child from the registry.
    tracked_processes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A unique token per registration so two children that happen to reuse an OS pid (pids are
/// recycled once a process exits) never collide in the map.
fn next_token() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// Unregisters a tracked child pid when dropped. Held for the lifetime of a spawned child so
/// the pid is visible to the exit handler while the child runs and is cleared the moment the
/// spawn helper returns (whether the child finished, timed out, or was cancelled).
pub struct TrackedChildGuard {
    token: u64,
}

impl TrackedChildGuard {
    /// Registers `pid` as a running external child and returns a guard that unregisters it on
    /// drop. A `None` pid (the child failed to report one) still yields a guard so call sites
    /// do not need to special-case it; nothing is tracked in that case.
    pub fn register(pid: Option<u32>) -> Self {
        let token = next_token();

        if let Some(pid) = pid {
            lock_registry().insert(token, pid);
        }

        Self { token }
    }
}

impl Drop for TrackedChildGuard {
    fn drop(&mut self) {
        lock_registry().remove(&self.token);
    }
}

/// The pids of every external child currently tracked.
pub fn tracked_pids() -> Vec<u32> {
    lock_registry().values().copied().collect()
}

/// Synchronously tree-kills every tracked external child. Intended for the app-exit path,
/// which must not touch the async runtime, so it uses the blocking process-tree kill. Safe to
/// call alongside [`crate::services::yt_dlp::cancel_all_active_downloads_blocking`]: a pid that
/// both target (the main download child) is simply killed twice, and killing an
/// already-exited pid is a no-op.
pub fn kill_all_tracked_blocking() {
    for pid in tracked_pids() {
        crate::utils::process::kill_process_tree_blocking(pid);
    }
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
    fn register_tracks_the_pid_until_the_guard_drops() {
        let _serial = serial_guard();

        {
            let _guard = TrackedChildGuard::register(Some(4321));
            assert!(tracked_pids().contains(&4321));
        }

        // Dropping the guard unregisters the pid.
        assert!(!tracked_pids().contains(&4321));
    }

    #[test]
    fn register_with_no_pid_tracks_nothing() {
        let _serial = serial_guard();

        let before = tracked_pids().len();
        let _guard = TrackedChildGuard::register(None);
        assert_eq!(tracked_pids().len(), before);
    }

    #[test]
    fn each_registration_is_independent_even_for_the_same_pid() {
        let _serial = serial_guard();

        let first = TrackedChildGuard::register(Some(999));
        let second = TrackedChildGuard::register(Some(999));

        // Two children sharing a pid are tracked under distinct tokens...
        assert_eq!(
            tracked_pids().iter().filter(|pid| **pid == 999).count(),
            2
        );

        // ...so dropping one still leaves the other tracked.
        drop(first);
        assert_eq!(
            tracked_pids().iter().filter(|pid| **pid == 999).count(),
            1
        );

        drop(second);
        assert!(!tracked_pids().contains(&999));
    }
}
