use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// A process-unique suffix (`<pid>-<nanos>-<counter>`) for temporary file and directory names.
///
/// The process id separates this process's temp entries from another instance's; the
/// high-resolution timestamp keeps them readable/orderable; and the monotonic counter guarantees
/// uniqueness *within* the process regardless of timer resolution. The timestamp alone does not:
/// two calls in the same clock tick (a coarse OS timer, or two threads racing) would otherwise
/// produce the same string, so the counter is what actually makes concurrent same-process callers
/// collision-free. Shared by the download, thumbnail and atomic-file-replace paths, which all stage
/// work under uniquely named temp entries.
///
/// **Any test helper that builds a unique temporary path builds it from this too, whatever that
/// helper is called.** Those helpers were originally hand-rolled from pid + nanos, and the missing
/// counter was a real intermittent CI failure: two tests starting in the same tick got the same temp
/// directory and one deleted the other's files, which surfaced on macOS (coarser timer) as a failure
/// nowhere near its cause. The pattern was fixed in one helper and re-appeared by copy-paste in
/// sixteen more, so the fix is to delegate here rather than to reproduce the three components.
///
/// The rule is written that way on purpose. It used to name three helpers (`unique_test_dir`,
/// `unique_dir`, `unique_temp_db`), and a later sweep that believed it had converted every one of
/// them missed eight more (`temp_dir`, `temp_log`, `unique_temp_path`, `unique_library_dir` and
/// friends) simply because their names were not on that list. Three of those eight had drifted
/// further still and carried only the timestamp, without even the pid. Match on what the helper
/// *does*, never on what it is called. `ci.yml` now enforces this rather than trusting it.
pub fn unique_temp_suffix() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);

    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);

    format!("{}-{}-{}", std::process::id(), nanos, counter)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_temp_suffix_has_the_pid_dash_nanos_dash_counter_shape() {
        let suffix = unique_temp_suffix();
        let parts: Vec<&str> = suffix.split('-').collect();

        assert_eq!(parts.len(), 3, "suffix should be '<pid>-<nanos>-<counter>'");
        assert_eq!(parts[0], std::process::id().to_string());

        for part in [parts[1], parts[2]] {
            assert!(!part.is_empty());
            assert!(part.chars().all(|c| c.is_ascii_digit()));
        }
    }

    #[test]
    fn unique_temp_suffix_changes_between_calls() {
        // The monotonic counter advances on every call, so two calls never collide within a
        // process even if the nanosecond timestamp happened to repeat.
        assert_ne!(unique_temp_suffix(), unique_temp_suffix());
    }
}
