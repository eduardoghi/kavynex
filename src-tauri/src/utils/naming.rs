use std::time::{SystemTime, UNIX_EPOCH};

/// A process-unique suffix (`<pid>-<nanos>`) for temporary file and directory names.
///
/// Combining the process id with a high-resolution timestamp keeps two concurrent operations
/// (even within the same process) from colliding on a temp name, without needing a random
/// source. Shared by the download, thumbnail and atomic-file-replace paths, which all stage
/// work under uniquely named temp entries.
pub fn unique_temp_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);

    format!("{}-{}", std::process::id(), nanos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_temp_suffix_has_the_pid_dash_nanos_shape() {
        let suffix = unique_temp_suffix();
        let (pid, nanos) = suffix
            .split_once('-')
            .expect("suffix should be '<pid>-<nanos>'");

        assert_eq!(pid, std::process::id().to_string());
        assert!(nanos.chars().all(|c| c.is_ascii_digit()));
        assert!(!nanos.is_empty());
    }

    #[test]
    fn unique_temp_suffix_changes_between_calls() {
        // The nanosecond timestamp advances, so two calls never collide within a process.
        assert_ne!(unique_temp_suffix(), unique_temp_suffix());
    }
}
