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
