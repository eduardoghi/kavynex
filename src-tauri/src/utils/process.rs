//! Helpers for spawning and inspecting child processes.
//!
//! The app is built with the `windows` subsystem (no console of its own), so spawning a
//! console child (`yt-dlp`, `ffmpeg`, `where.exe`, `taskkill`, ...) makes Windows allocate
//! and briefly show a console window. Passing `CREATE_NO_WINDOW` suppresses it. Both
//! `hide_console*` helpers are no-ops on non-Windows platforms.

use crate::{AppError, AppErrorCode};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Suppresses the console window for a synchronous [`std::process::Command`].
#[cfg(windows)]
pub fn hide_console(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_console(_command: &mut std::process::Command) {}

/// Suppresses the console window for an async [`tokio::process::Command`].
#[cfg(windows)]
pub fn hide_console_async(command: &mut tokio::process::Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_console_async(_command: &mut tokio::process::Command) {}

/// Builds an [`AppError`] from a failed child process's output, preferring stderr, then
/// stdout, then falling back to `default_message` when both streams are empty.
pub fn read_process_error(
    output: &std::process::Output,
    default_code: AppErrorCode,
    default_message: &str,
) -> AppError {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();

    if !stderr.is_empty() {
        return AppError::from_code(default_code, format!("{default_message}: {stderr}"));
    }

    if !stdout.is_empty() {
        return AppError::from_code(default_code, format!("{default_message}: {stdout}"));
    }

    AppError::from_code(default_code, default_message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Output;

    #[cfg(unix)]
    fn exit_status(code: i32) -> std::process::ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(code)
    }

    #[cfg(windows)]
    fn exit_status(code: u32) -> std::process::ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(code)
    }

    #[test]
    fn read_process_error_prefers_stderr() {
        let output = Output {
            status: exit_status(1),
            stdout: b"stdout message".to_vec(),
            stderr: b"stderr message".to_vec(),
        };

        let error = read_process_error(
            &output,
            AppErrorCode::FfmpegFailed,
            "ffmpeg failed to generate thumbnail",
        );

        assert_eq!(error.code, AppErrorCode::FfmpegFailed.as_str());
        assert!(error.message.contains("stderr message"));
    }

    #[test]
    fn read_process_error_falls_back_to_stdout() {
        let output = Output {
            status: exit_status(1),
            stdout: b"stdout message".to_vec(),
            stderr: Vec::new(),
        };

        let error = read_process_error(
            &output,
            AppErrorCode::FfmpegFailed,
            "ffmpeg failed to generate thumbnail",
        );

        assert_eq!(error.code, AppErrorCode::FfmpegFailed.as_str());
        assert!(error.message.contains("stdout message"));
    }

    #[test]
    fn read_process_error_falls_back_to_default_message() {
        let output = Output {
            status: exit_status(1),
            stdout: Vec::new(),
            stderr: Vec::new(),
        };

        let error = read_process_error(
            &output,
            AppErrorCode::FfmpegFailed,
            "ffmpeg failed to generate thumbnail",
        );

        assert_eq!(error.code, AppErrorCode::FfmpegFailed.as_str());
        assert_eq!(error.message, "ffmpeg failed to generate thumbnail");
    }
}
