use tauri::{AppHandle, Emitter, Runtime};

use crate::constants::{
    EVENT_YT_DLP_CANCELLED, EVENT_YT_DLP_ERROR, EVENT_YT_DLP_FINISHED, EVENT_YT_DLP_LOG,
    EVENT_YT_DLP_TERMINAL,
};
use crate::models::yt_dlp::{
    DownloadFailedEvent, DownloadFinishedEvent, DownloadLogEvent, DownloadLogLevel,
    DownloadTerminalEvent, DownloadTerminalStatus,
};
use crate::services::yt_dlp::download::line_is_warning;
use crate::{AppError, AppErrorCode, AppResult};

pub fn infer_log_level(line: &str, stream: &str) -> DownloadLogLevel {
    if line_is_warning(line) {
        return DownloadLogLevel::Warn;
    }

    if stream == "stderr" {
        return DownloadLogLevel::Error;
    }

    DownloadLogLevel::Info
}

pub fn emit_download_log<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    line: impl Into<String>,
    stream: &str,
) -> AppResult<()> {
    let line = line.into();

    app.emit(
        EVENT_YT_DLP_LOG,
        DownloadLogEvent {
            run_id: run_id.to_string(),
            level: infer_log_level(&line, stream),
            line,
            stream: stream.to_string(),
        },
    )
    .map_err(|e| {
        AppError::from_code(
            AppErrorCode::YtDlpEventEmitFailed,
            format!("failed to emit yt-dlp log event: {e}"),
        )
    })
}

/// Fire-and-forget variant of [`emit_download_log`] for callers (such as the spawned
/// stdout/stderr reader tasks), that cannot propagate an emit failure.
pub fn emit_download_log_infallible<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    line: impl Into<String>,
    stream: &str,
) {
    let _ = emit_download_log(app, run_id, line, stream);
}

pub fn emit_terminal_event<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    status: DownloadTerminalStatus,
    message: Option<String>,
    file_path: Option<String>,
    suggested_title: Option<String>,
) {
    let _ = app.emit(
        EVENT_YT_DLP_TERMINAL,
        DownloadTerminalEvent {
            run_id: run_id.to_string(),
            status,
            message,
            file_path,
            suggested_title,
        },
    );
}

pub fn emit_download_error<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    message: impl Into<String>,
) {
    let message = message.into();

    let _ = app.emit(
        EVENT_YT_DLP_ERROR,
        DownloadFailedEvent {
            run_id: run_id.to_string(),
            message: message.clone(),
        },
    );

    emit_terminal_event(
        app,
        run_id,
        DownloadTerminalStatus::Failed,
        Some(message),
        None,
        None,
    );
}

pub fn emit_download_cancelled<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    message: impl Into<String>,
) {
    let message = message.into();

    let _ = app.emit(
        EVENT_YT_DLP_CANCELLED,
        DownloadFailedEvent {
            run_id: run_id.to_string(),
            message: message.clone(),
        },
    );

    emit_terminal_event(
        app,
        run_id,
        DownloadTerminalStatus::Cancelled,
        Some(message),
        None,
        None,
    );
}

pub fn emit_download_finished<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    file_path: String,
    suggested_title: String,
) {
    let _ = app.emit(
        EVENT_YT_DLP_FINISHED,
        DownloadFinishedEvent {
            run_id: run_id.to_string(),
            file_path: file_path.clone(),
            suggested_title: suggested_title.clone(),
        },
    );

    emit_terminal_event(
        app,
        run_id,
        DownloadTerminalStatus::Finished,
        None,
        Some(file_path),
        Some(suggested_title),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infer_log_level_treats_stderr_as_error_by_default() {
        let level = infer_log_level("something failed", "stderr");
        assert!(matches!(level, DownloadLogLevel::Error));
    }

    #[test]
    fn infer_log_level_treats_warning_in_stderr_as_warn() {
        let level = infer_log_level("WARNING: partial issue", "stderr");
        assert!(matches!(level, DownloadLogLevel::Warn));
    }

    #[test]
    fn infer_log_level_treats_warning_in_stdout_as_warn() {
        let level = infer_log_level("warning: low speed", "stdout");
        assert!(matches!(level, DownloadLogLevel::Warn));
    }

    #[test]
    fn infer_log_level_treats_regular_stdout_as_info() {
        let level = infer_log_level("download started", "stdout");
        assert!(matches!(level, DownloadLogLevel::Info));
    }
}
