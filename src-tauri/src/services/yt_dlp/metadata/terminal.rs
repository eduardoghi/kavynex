//! Choosing which of yt-dlp's lines reach the in-app terminal and which one explains a failure.

pub(super) fn is_json_payload_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with('{') || trimmed.starts_with('[')
}

pub(super) fn should_keep_terminal_line(line: &str) -> bool {
    let trimmed = line.trim();

    if trimmed.is_empty() {
        return false;
    }

    if is_json_payload_line(trimmed) {
        return false;
    }

    true
}

/// Substrings yt-dlp emits when a video requires age verification. Shared by the friendly-hint
/// detection and the error-detail preference so both recognize the same signal from one list.
pub(super) const AGE_RESTRICTION_MARKERS: [&str; 4] = [
    "sign in to confirm your age",
    "this video is age-restricted",
    "age-restricted",
    "login_required",
];

pub(super) fn contains_age_restriction_marker(normalized_line: &str) -> bool {
    AGE_RESTRICTION_MARKERS
        .iter()
        .any(|marker| normalized_line.contains(marker))
}

pub(super) fn is_age_restriction_error_line(line: &str) -> bool {
    let normalized = line.trim().to_lowercase();

    contains_age_restriction_marker(&normalized)
        || normalized.contains("may be inappropriate for some users")
}

pub(super) fn build_friendly_terminal_hints(
    stdout_logs: &[String],
    stderr_logs: &[String],
) -> Vec<String> {
    let has_age_restriction = stdout_logs
        .iter()
        .chain(stderr_logs.iter())
        .any(|line| is_age_restriction_error_line(line));

    let mut hints = Vec::new();

    if has_age_restriction {
        hints.push("INFO: This YouTube video requires age verification.".to_string());
        hints.push(
            "INFO: Use cookies from a logged-in account that has already completed age verification."
                .to_string(),
        );
        hints.push(
            "INFO: In Authentication, choose a browser already logged into YouTube or provide a cookies.txt file from a verified account."
                .to_string(),
        );
    }

    hints
}

pub(super) fn is_traceback_noise(line: &str) -> bool {
    let trimmed = line.trim();
    let normalized = trimmed.to_lowercase();

    trimmed.starts_with("File \"")
        || normalized.starts_with("traceback")
        || normalized.starts_with("during handling of the above exception")
        || normalized.contains(" in raise_no_formats")
}

pub(super) fn is_preferred_error_detail(line: &str) -> bool {
    let normalized = line.trim().to_lowercase();

    contains_age_restriction_marker(&normalized) || normalized.starts_with("error:")
}

pub(super) fn select_best_error_detail(
    stdout_logs: &[String],
    stderr_logs: &[String],
    failed_message: &str,
) -> String {
    if let Some(line) = stderr_logs
        .iter()
        .rev()
        .find(|line| is_preferred_error_detail(line))
    {
        return line.clone();
    }

    if let Some(line) = stdout_logs
        .iter()
        .rev()
        .find(|line| is_preferred_error_detail(line))
    {
        return line.clone();
    }

    if let Some(line) = stderr_logs
        .iter()
        .rev()
        .find(|line| !line.trim().is_empty() && !is_traceback_noise(line))
    {
        return line.clone();
    }

    if let Some(line) = stdout_logs
        .iter()
        .rev()
        .find(|line| !line.trim().is_empty() && !is_traceback_noise(line))
    {
        return line.clone();
    }

    stderr_logs
        .iter()
        .rev()
        .find(|line| !line.trim().is_empty())
        .cloned()
        .or_else(|| {
            stdout_logs
                .iter()
                .rev()
                .find(|line| !line.trim().is_empty())
                .cloned()
        })
        .unwrap_or_else(|| failed_message.to_string())
}
