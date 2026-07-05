use crate::services::logger;

// Frontend crash reports are free-form text from the webview; cap and sanitize them so a
// runaway (or hostile) frontend cannot flood the log file or forge log lines through
// embedded newlines.
const MAX_SCOPE_CHARS: usize = 64;
const MAX_MESSAGE_CHARS: usize = 8 * 1024;

fn sanitize_log_text(value: &str, max_chars: usize) -> String {
    value
        .trim()
        .chars()
        .take(max_chars)
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect()
}

/// Persists an error reported by the frontend into the backend log file. Uncaught webview
/// errors (render crashes, unhandled rejections) otherwise only reach the devtools
/// console, which is gone by the time a bug report is written.
#[tauri::command]
pub fn log_frontend_error(scope: String, message: String) {
    let scope = sanitize_log_text(&scope, MAX_SCOPE_CHARS);
    let message = sanitize_log_text(&message, MAX_MESSAGE_CHARS);

    let scope = if scope.is_empty() {
        "frontend".to_string()
    } else {
        format!("frontend:{scope}")
    };

    let message = if message.is_empty() {
        "frontend reported an error without a message".to_string()
    } else {
        message
    };

    logger::error(&scope, message);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_log_text_replaces_control_chars_and_trims() {
        let sanitized = sanitize_log_text("  line1\nline2\r\tend  ", 100);
        assert_eq!(sanitized, "line1 line2  end");
    }

    #[test]
    fn sanitize_log_text_caps_length() {
        let sanitized = sanitize_log_text(&"a".repeat(50), 10);
        assert_eq!(sanitized.chars().count(), 10);
    }
}
