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
//! between iterations) is fine; nesting is not. In debug and test builds this rule is enforced by
//! a per-thread depth check that panics at the offending acquisition (see `library_read_guard`),
//! not left to code review alone.

use std::sync::{OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};

fn library_operation_gate() -> &'static RwLock<()> {
    static GATE: OnceLock<RwLock<()>> = OnceLock::new();
    GATE.get_or_init(|| RwLock::new(()))
}

/// RAII guard returned by [`library_read_guard`]. Holding it is what serializes a single library
/// write or delete against a migration; drop it as soon as that fs work is done. Behaves like the
/// `RwLockReadGuard` it wraps; in debug and test builds it additionally maintains the per-thread
/// read-guard depth that backs the no-nesting check (see [`library_read_guard`]).
pub struct LibraryReadGuard {
    _inner: RwLockReadGuard<'static, ()>,
}

// How many library read guards the current thread holds. The no-nesting rule means this never
// exceeds 1: the acquire path debug-asserts it was 0 before incrementing, and the guard's Drop
// decrements it. Debug/test builds only - a release build carries no counter and no Drop work.
#[cfg(debug_assertions)]
thread_local! {
    static READ_DEPTH: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

impl Drop for LibraryReadGuard {
    fn drop(&mut self) {
        #[cfg(debug_assertions)]
        READ_DEPTH.with(|depth| depth.set(depth.get() - 1));
    }
}

/// Acquires the shared (read) side of the library gate. Hold the returned guard for the extent
/// of a single library write or delete; drop it as soon as that fs work is done.
///
/// The module's no-nesting rule (a guarded leaf function must never acquire a second read guard
/// while holding one) is otherwise convention-only, and violating it can deadlock against a
/// waiting migration - `std::sync::RwLock` is write-preferring and makes no reentrancy guarantee,
/// so the second read blocks behind the queued writer that the first read is blocking. The
/// debug-only depth check below turns that into a loud, located panic at the offending
/// acquisition instead of a later hang with no pointer to the cause. It compiles to nothing in a
/// release build.
pub fn library_read_guard() -> LibraryReadGuard {
    #[cfg(debug_assertions)]
    READ_DEPTH.with(|depth| {
        debug_assert_eq!(
            depth.get(),
            0,
            "nested library read guard: a guarded function acquired a second read guard while \
             holding one, which can deadlock against a waiting migration (see the library_lock \
             module docs)"
        );
        depth.set(depth.get() + 1);
    });

    let inner = library_operation_gate()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    LibraryReadGuard { _inner: inner }
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
    fn a_waiting_writer_does_not_deadlock_the_guarded_leaf_functions() {
        // The module's rule - a guarded function must never call another one while holding the
        // guard - is what keeps this gate from wedging the app, and it is enforced only by
        // convention. std::sync::RwLock makes no reentrancy guarantee and is write-preferring on
        // most platforms: a second read acquired while a writer waits can block forever, and the
        // symptom (every library operation hangs) points nowhere near the nested call that caused
        // it. This pins the shape the real call sites rely on - a loop taking the guard once per
        // file, released between iterations, while a migration is trying to get in.
        let (started, rx) = mpsc::channel();
        let (release, wait_to_release) = mpsc::channel::<()>();

        let held = library_read_guard();

        // A migration asks for the exclusive side and blocks: the reader above holds it.
        let writer = thread::spawn(move || {
            let _ = started.send(());
            let _write = library_write_guard();
            let _ = wait_to_release.recv_timeout(Duration::from_secs(5));
        });

        rx.recv_timeout(Duration::from_secs(5)).unwrap();
        thread::sleep(Duration::from_millis(50));
        drop(held);

        // With the writer queued, a sequence of independent per-file acquisitions must still each
        // complete rather than deadlock. They may wait for the migration - that is the point of
        // the gate - so this only requires that the whole sequence finishes.
        let sequential = thread::spawn(|| {
            for _ in 0..3 {
                let _guard = library_read_guard();
            }
        });

        let _ = release.send(());
        writer.join().unwrap();

        sequential.join().unwrap();
    }

    // Debug-only: the depth check is compiled out of a release build, so under `cargo test
    // --release` a second same-thread read would simply succeed (no waiting writer here) and no
    // panic would occur. The whole test is gated to the builds where the assertion is live.
    #[cfg(debug_assertions)]
    #[test]
    #[should_panic(expected = "nested library read guard")]
    fn a_nested_read_guard_panics_in_debug_builds() {
        let _first = library_read_guard();
        // Acquiring a second read guard on the same thread while the first is still held is exactly
        // the nesting the module forbids. The debug depth check must catch it right here rather
        // than let a real deadlock form against a waiting migration.
        let _second = library_read_guard();
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
