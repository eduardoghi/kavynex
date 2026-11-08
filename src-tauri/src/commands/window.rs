//! Closing the main window after the user confirmed it, while work a close stops is running.
//!
//! The close itself is held in Rust (see `services::app_close`), so the renderer needs no window
//! permission. It only answers the question, and this command is the "close anyway" answer.

use tauri::{Runtime, Window};

use crate::{AppError, AppErrorCode, AppResult};

/// Closes the window without asking again. `destroy` rather than `close`, since `close` raises the
/// same close request the app is answering.
#[tauri::command]
pub fn close_app_anyway<R: Runtime>(window: Window<R>) -> AppResult<()> {
    window.destroy().map_err(|error| {
        AppError::from_code(
            AppErrorCode::AppError,
            format!("failed to close the window: {error}"),
        )
    })
}
