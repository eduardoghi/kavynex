//! Serializes library file mutations against a library-directory migration.
//!
//! A library migration copies every managed subdirectory (video/audio/thumbnails/live_chat)
//! to the new location and then removes the old one (`library_migration::migrate_library_contents`).
//! Nothing else stopped a concurrent import/download/delete from writing a brand-new file into
//! the old directory in the window between the copy and the `remove_dir_all`; that file would be
//! silently deleted and never reach the new location, with the operation still reporting success.
//! It is the only path in the app that can lose user data silently and permanently.
//!
//! This gate closes that window. Every leaf filesystem function that writes into, or deletes
//! from, the library takes the shared (read) side for the duration of that single operation;
//! a migration takes the exclusive (write) side around its copy/remove phase. So a migration
//! waits for the in-flight mutations to finish and blocks new ones until it completes, and a
//! mutation started while a migration runs waits for it - the copy/remove phase can never
//! overlap a library write.
//!
//! The gate guards no data (`RwLock<()>`), only ordering, so a prior panic must never wedge
//! every future library operation: both helpers recover a poisoned lock rather than propagate
//! it, mirroring `library_migration::migrate_library_directory_sync`'s own poison handling.
//!
//! IMPORTANT: only leaf filesystem functions take the read guard, and only for the extent of a
//! single fs call. A guarded function must never call another guarded function while holding the
//! guard - a nested read acquisition can deadlock against a waiting writer (`std::sync::RwLock`
//! makes no reentrancy guarantee). Acquiring the guard once per file inside a loop (release
//! between iterations) is fine; nesting is not.

use std::sync::{OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};

fn library_operation_gate() -> &'static RwLock<()> {
    static GATE: OnceLock<RwLock<()>> = OnceLock::new();
    GATE.get_or_init(|| RwLock::new(()))
}

/// Acquires the shared (read) side of the library gate. Hold the returned guard for the extent
/// of a single library write or delete; drop it as soon as that fs work is done. See the module
/// docs for the no-nesting rule.
pub fn library_read_guard() -> RwLockReadGuard<'static, ()> {
    library_operation_gate()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Acquires the exclusive (write) side for a library migration's destructive copy/remove phase.
/// Blocks until every in-flight library mutation has released its read guard, and blocks new
/// ones until the returned guard is dropped.
pub fn library_write_guard() -> RwLockWriteGuard<'static, ()> {
    library_operation_gate()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn write_guard_excludes_a_concurrent_reader_until_released() {
        let write = library_write_guard();

        let (tx, rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            let _read = library_read_guard();
            let _ = tx.send(());
        });

        // While the write guard is held, the reader cannot acquire its guard, so nothing arrives.
        assert!(
            rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "a reader must not acquire the guard while a migration holds the write side"
        );

        drop(write);

        // Once the write side is released, the reader proceeds promptly.
        assert!(
            rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "the reader must acquire the guard once the write side is released"
        );

        handle.join().unwrap();
    }

    #[test]
    fn read_guard_recovers_from_a_poisoned_gate() {
        // Simulate a prior library operation that panicked while holding a guard.
        let poisoning = thread::spawn(|| {
            let _held = library_write_guard();
            panic!("simulated panic while holding the library gate");
        })
        .join();
        assert!(poisoning.is_err(), "the helper thread should have panicked");

        // The gate guards no data, so the poison must be recovered rather than wedge every
        // future library operation.
        let _read = library_read_guard();
        drop(_read);
        let _write = library_write_guard();
    }
}
