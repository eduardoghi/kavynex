use tauri::{AppHandle, Runtime};

use crate::services::{file_manager, logger};
use crate::utils::task::run_blocking;
use crate::AppResult;

// Frontend crash reports are free-form text from the webview. Cap and sanitize them so a
// runaway (or hostile) frontend cannot flood the log file or forge log lines through
// embedded newlines.
const MAX_SCOPE_CHARS: usize = 64;
const MAX_MESSAGE_CHARS: usize = 8 * 1024;

/// `pub(crate)` because `commands::webview_check` reports caller-controlled text from the renderer
/// too, and that report deserves the same treatment as a crash report rather than a second copy of
/// this rule that could drift from it.
pub(crate) fn sanitize_log_text(value: &str, max_chars: usize) -> String {
    value
        .trim()
        .chars()
        .take(max_chars)
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect()
}

/// How many frontend reports one window of [`REPORT_WINDOW`] writes. A component failing on every
/// render reports dozens a second, each a write to the log file and possibly a rotation, and the
/// first few are what explain it.
const MAX_REPORTS_PER_WINDOW: u32 = 20;
const REPORT_WINDOW: std::time::Duration = std::time::Duration::from_secs(10);

/// Counts the frontend reports of the current window, and the ones it dropped.
#[derive(Debug)]
struct ReportBudget {
    window_start: std::time::Instant,
    written: u32,
    dropped: u32,
}

/// What [`ReportBudget::admit`] decided for one report.
#[derive(Debug, PartialEq, Eq)]
enum Admission {
    /// Write it, after saying how many the previous window dropped, when it dropped any.
    Write { dropped_before: u32 },
    /// Drop it. `first` for the window's first drop, which the log notes at once, since the count
    /// only reaches it with a report after the window, and a burst that stops has none.
    Drop { first: bool },
}

impl ReportBudget {
    fn new(now: std::time::Instant) -> Self {
        Self {
            window_start: now,
            written: 0,
            dropped: 0,
        }
    }

    fn admit(&mut self, now: std::time::Instant) -> Admission {
        let mut dropped_before = 0;

        if now.duration_since(self.window_start) >= REPORT_WINDOW {
            dropped_before = self.dropped;
            *self = Self::new(now);
        }

        if self.written >= MAX_REPORTS_PER_WINDOW {
            self.dropped = self.dropped.saturating_add(1);
            return Admission::Drop {
                first: self.dropped == 1,
            };
        }

        self.written += 1;
        Admission::Write { dropped_before }
    }
}

fn report_budget() -> &'static std::sync::Mutex<ReportBudget> {
    static BUDGET: std::sync::OnceLock<std::sync::Mutex<ReportBudget>> = std::sync::OnceLock::new();
    BUDGET.get_or_init(|| std::sync::Mutex::new(ReportBudget::new(std::time::Instant::now())))
}

/// Persists an error reported by the frontend into the backend log file. Uncaught webview
/// errors (render crashes, unhandled rejections) otherwise only reach the devtools
/// console, which is gone by the time a bug report is written.
///
/// Async, so the write runs on a worker rather than the main thread a synchronous command runs on,
/// and bounded by [`ReportBudget`]. A frontend reporting in a loop froze the window with log writes.
#[tauri::command]
pub async fn log_frontend_error(scope: String, message: String) {
    let admission = report_budget()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .admit(std::time::Instant::now());

    let dropped_before = match admission {
        Admission::Write { dropped_before } => dropped_before,
        Admission::Drop { first: true } => {
            let _ = run_blocking(|| {
                logger::warn(
                    "frontend",
                    format!(
                        "frontend error reports are coming too fast; dropping the rest for up to                          {} seconds",
                        REPORT_WINDOW.as_secs()
                    ),
                );
                Ok(())
            })
            .await;

            return;
        }
        Admission::Drop { first: false } => return,
    };

    let _ = run_blocking(move || {
        if dropped_before > 0 {
            logger::warn(
                "frontend",
                format!(
                    "{dropped_before} frontend error report(s) were dropped for coming too fast"
                ),
            );
        }

        write_frontend_report(&scope, &message);
        Ok(())
    })
    .await;
}

fn write_frontend_report(scope: &str, message: &str) {
    let scope = sanitize_log_text(scope, MAX_SCOPE_CHARS);
    let message = sanitize_log_text(message, MAX_MESSAGE_CHARS);

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

/// Opens the app's log directory in the OS file manager, so the README's "attach the relevant lines
/// when reporting a bug" does not begin with the user finding a per-OS path by hand.
///
/// **It takes no arguments, and that is the security property rather than an omission.** Every other
/// path-revealing command in this app receives a path over IPC and has to defend it. The library
/// one confines it to the configured library, behind the settings cross-check in `library::guard`.
/// This one asks Tauri where the log directory is, so a compromised renderer has nothing to
/// redirect. Reusing `open_path_in_system` instead was the tempting shortcut and is the wrong one.
/// Its containment check compares `path` against `library_path`, so passing the log directory as
/// both would satisfy it trivially. The self-referential shape `docs/THREAT-MODEL.md` records as a
/// defect that guard exists to close, not a pattern to reuse.
///
/// The spawn and the directory resolution are blocking filesystem work, so they run off the async
/// runtime's worker threads like every other filesystem command.
#[tauri::command]
pub async fn open_log_directory<R: Runtime>(app: AppHandle<R>) -> AppResult<()> {
    run_blocking(move || file_manager::reveal_app_log_dir(&app)).await
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

        // A void command. Invoking it with the two string arguments must succeed across the IPC
        // boundary. This pins that the command is registered and that its `scope`/`message`
        // arguments deserialize. The reason to drive it through invoke rather than call the
        // function directly (which the sanitize tests below already do).
        invoke(
            &webview,
            "log_frontend_error",
            serde_json::json!({ "scope": "player", "message": "render crashed" }),
        )
        .unwrap();
    }

    #[test]
    fn a_burst_of_reports_is_cut_off_and_the_next_window_says_how_many_went() {
        let start = std::time::Instant::now();
        let mut budget = ReportBudget::new(start);

        for _ in 0..MAX_REPORTS_PER_WINDOW {
            assert_eq!(budget.admit(start), Admission::Write { dropped_before: 0 });
        }

        // The first drop says so at once, since a burst that stops never sends the report that
        // would carry the count.
        assert_eq!(budget.admit(start), Admission::Drop { first: true });
        assert_eq!(budget.admit(start), Admission::Drop { first: false });

        let later = start + REPORT_WINDOW;
        assert_eq!(budget.admit(later), Admission::Write { dropped_before: 2 });
        assert_eq!(budget.admit(later), Admission::Write { dropped_before: 0 });

        for _ in 2..MAX_REPORTS_PER_WINDOW {
            budget.admit(later);
        }
        assert_eq!(
            budget.admit(later),
            Admission::Drop { first: true },
            "each window notes its own first drop"
        );
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
