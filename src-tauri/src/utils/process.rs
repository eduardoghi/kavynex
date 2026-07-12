//! Helpers for spawning and inspecting child processes.
//!
//! The app is built with the `windows` subsystem (no console of its own), so spawning a
//! console child (`yt-dlp`, `ffmpeg`, `where.exe`, `taskkill`, ...) makes Windows allocate
//! and briefly show a console window. Passing `CREATE_NO_WINDOW` suppresses it. Both
//! `hide_console*` helpers are no-ops on non-Windows platforms.

use std::process::Stdio;

use crate::{AppError, AppErrorCode};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How often [`wait_for_cancel`] re-checks the cancel flag. Short enough that a user cancel
/// aborts a bounded wait promptly, long enough not to busy-spin.
const CANCEL_POLL_INTERVAL_MS: u64 = 200;

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

/// Puts an async child into its own process group (Unix) so the whole tree it spawns
/// (e.g. `yt-dlp` launching `ffmpeg` for a merge or thumbnail conversion) can be signalled
/// at once by sending the signal to the negative process-group id. No-op on non-Unix, where
/// process-tree termination is done with `taskkill /T` instead (see [`kill_process_tree`]).
#[cfg(unix)]
pub fn configure_process_group(command: &mut tokio::process::Command) {
    command.process_group(0);
}

#[cfg(not(unix))]
pub fn configure_process_group(_command: &mut tokio::process::Command) {}

/// Kills a spawned child *and* every descendant it created, asynchronously. `yt-dlp` routinely
/// spawns an `ffmpeg` child (merges, `--convert-thumbnails`), and killing only the direct
/// child (`Child::kill`/`kill_on_drop`) leaves that grandchild running. On Windows this uses
/// `taskkill /T` to walk the tree; on Unix it signals the whole process group set up by
/// [`configure_process_group`] via the negative pid.
#[cfg(target_os = "windows")]
pub async fn kill_process_tree(pid: u32) {
    let mut command = tokio::process::Command::new("taskkill");
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console_async(&mut command);

    if let Ok(mut child) = command.spawn() {
        let _ = child.wait().await;
    }
}

#[cfg(unix)]
pub async fn kill_process_tree(pid: u32) {
    let process_group = format!("-{pid}");

    if let Ok(mut child) = tokio::process::Command::new("kill")
        .args(["-9", process_group.as_str()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        let _ = child.wait().await;
    }
}

#[cfg(not(any(target_os = "windows", unix)))]
pub async fn kill_process_tree(pid: u32) {
    if let Ok(mut child) = tokio::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        let _ = child.wait().await;
    }
}

/// Synchronous counterpart to [`kill_process_tree`], for the app-exit path which must not
/// touch the async runtime.
#[cfg(target_os = "windows")]
pub fn kill_process_tree_blocking(pid: u32) {
    let mut command = std::process::Command::new("taskkill");
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console(&mut command);

    let _ = command.status();
}

#[cfg(unix)]
pub fn kill_process_tree_blocking(pid: u32) {
    let process_group = format!("-{pid}");

    let _ = std::process::Command::new("kill")
        .args(["-9", process_group.as_str()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(any(target_os = "windows", unix)))]
pub fn kill_process_tree_blocking(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Resolves as soon as `cancel` is observed set. When `cancel` is `None` it never resolves,
/// so a `tokio::select!` against it is driven entirely by the other branch. Used to make the
/// bounded metadata/thumbnail waits abort promptly on a user cancel instead of running to
/// their timeout, killing the whole process tree at the call site.
pub async fn wait_for_cancel(cancel: Option<&std::sync::atomic::AtomicBool>) {
    match cancel {
        None => std::future::pending::<()>().await,
        Some(flag) => {
            while !flag.load(std::sync::atomic::Ordering::SeqCst) {
                tokio::time::sleep(std::time::Duration::from_millis(CANCEL_POLL_INTERVAL_MS)).await;
            }
        }
    }
}

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
