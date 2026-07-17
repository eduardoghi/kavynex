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
    use crate::commands::test_ipc::invoke;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    fn test_webview() -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![log_frontend_error])
            .build(mock_context(noop_assets()))
            .unwrap();

        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap()
    }

    #[test]
    fn log_frontend_error_command_accepts_scope_and_message_over_ipc() {
        let webview = test_webview();

        // A void command: invoking it with the two string arguments must succeed across the IPC
        // boundary. This pins that the command is registered and that its `scope`/`message`
        // arguments deserialize - the reason to drive it through invoke rather than call the
        // function directly (which the sanitize tests below already do).
        invoke(
            &webview,
            "log_frontend_error",
            serde_json::json!({ "scope": "player", "message": "render crashed" }),
        )
        .unwrap();
    }

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
