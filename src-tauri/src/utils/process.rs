//! Helpers for spawning and inspecting child processes.
//!
//! The app is built with the `windows` subsystem (no console of its own), so spawning a
//! console child (`yt-dlp`, `ffmpeg`, `where.exe`, `taskkill`, ...) makes Windows allocate
//! and briefly show a console window. Passing `CREATE_NO_WINDOW` suppresses it. Both
//! `hide_console*` helpers are no-ops on non-Windows platforms.

// Only the platforms that still kill through a spawned child (`taskkill` on Windows, `kill` on the
// fallback) need these. Unix signals the group through the syscall and has no killer child to wait
// on, so on that target the imports and the bounded wait below would be dead code.
#[cfg(not(unix))]
use std::process::Stdio;
#[cfg(not(unix))]
use std::time::{Duration, Instant};

use crate::{AppError, AppErrorCode};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How often [`wait_for_cancel`] re-checks the cancel flag. Short enough that a user cancel
/// aborts a bounded wait promptly, long enough not to busy-spin.
const CANCEL_POLL_INTERVAL_MS: u64 = 200;

/// How long the process-tree kill waits for the killer itself (`taskkill`, or `kill` on the
/// fallback target) before giving up. The killer is normally near-instant, but it can wedge (an
/// AV/EDR hook, a target stuck in an uninterruptible wait), and both call sites must never block
/// on it. The download-cancel path runs inside the async wait loop, and the app-exit sweep runs
/// synchronously on the event-loop thread, where a hung killer would stop the app from closing at
/// all.
#[cfg(not(unix))]
const KILL_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

/// How often the blocking bounded wait polls the killer child. Short enough that the deadline
/// fires promptly, long enough not to busy-spin the calling thread.
#[cfg(not(unix))]
const KILL_WAIT_POLL: Duration = Duration::from_millis(50);

/// Waits for a spawned killer child to exit, but gives up after [`KILL_WAIT_TIMEOUT`]. Returning
/// early leaves the killer running detached, which is acceptable. The signal it carries has
/// already been delivered to the target tree, and the caller must not block on the killer's own
/// bookkeeping.
#[cfg(not(unix))]
fn wait_child_bounded_blocking(mut child: std::process::Child) {
    let deadline = Instant::now() + KILL_WAIT_TIMEOUT;

    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => {
                if Instant::now() >= deadline {
                    return;
                }
                std::thread::sleep(KILL_WAIT_POLL);
            }
        }
    }
}

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

/// Synchronous counterpart to [`configure_process_group`], for a blocking [`std::process::Command`]
/// (the external-tool health checks). Puts the child in its own process group so
/// [`kill_process_tree_blocking`] (which signals the negative process-group id on Unix), reaches
/// the whole tree, including a `.sh`/`.cmd` shim's own children. No-op on non-Unix, where
/// `taskkill /T` walks the tree by pid instead.
#[cfg(unix)]
pub fn configure_process_group_blocking(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
pub fn configure_process_group_blocking(_command: &mut std::process::Command) {}

/// Pins where an async child starts, so it never inherits the app's own working directory.
///
/// Every yt-dlp and FFmpeg spawn gets one of these. The binary itself is resolved through PATH
/// alone (`services::binaries`), which closes the working-directory hijack for the *executable*.
/// What it does not close is the child's own library search. On Windows the directory a process
/// starts in is on the DLL search path of that process, after its own directory and the system
/// ones, and yt-dlp's PyInstaller bootloader and FFmpeg both probe for optional libraries that a
/// given machine may not have. A probe that misses everywhere else falls through to the working
/// directory. Nothing chooses that directory for the app. A shortcut hands it whatever the shell
/// had, and a portable copy run from a Downloads folder starts there, which is the one directory
/// on the machine that a downloaded file can be waiting in.
///
/// The directory pinned is one the app owns for the run when there is one (the run's temp
/// directory, the cache folder the output goes to) and [`default_child_working_dir`] otherwise.
/// Every path the app passes to a child is absolute, so the change is invisible to its work.
pub fn pin_working_dir_async(command: &mut tokio::process::Command, dir: &std::path::Path) {
    command.current_dir(dir);
}

/// Synchronous counterpart to [`pin_working_dir_async`], for a blocking [`std::process::Command`].
pub fn pin_working_dir(command: &mut std::process::Command, dir: &std::path::Path) {
    command.current_dir(dir);
}

/// Where a child starts when the caller has no directory of its own for the run (the version
/// health checks, the metadata-only yt-dlp runs). The process temp directory is per user, always
/// exists, and is not a place a launcher chooses, which is all the pin above needs from it.
pub fn default_child_working_dir() -> std::path::PathBuf {
    std::env::temp_dir()
}

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

    match command.spawn() {
        Ok(mut child) => {
            // Bound the wait on the killer itself so a hung taskkill cannot stall the caller.
            let _ = tokio::time::timeout(KILL_WAIT_TIMEOUT, child.wait()).await;
        }
        // Not swallowed. A cancel that could not reach the tree leaves yt-dlp/ffmpeg running while
        // the UI reports the run as stopped, and the log is the only place that would say so.
        Err(error) => crate::services::logger::warn(
            "process",
            format!("failed to start taskkill for process tree {pid}: {error}"),
        ),
    }
}

/// Signals the whole process group `pid` leads, via the `kill(2)` syscall rather than the `kill`
/// binary.
///
/// This used to spawn `/usr/bin/kill -9 -<pid>`, which meant the one operation whose job is to
/// stop an orphaned yt-dlp/ffmpeg depended on resolving an executable through the process's
/// `PATH`, and a failed spawn was swallowed. On a minimal PATH (an AppImage in a sandbox, a GUI
/// launch that inherited launchd's default) the cancel looked successful in the UI while the tree
/// kept running. The syscall has no such dependency, returns synchronously, and reports the one
/// outcome worth knowing about.
///
/// `ESRCH` is not reported. The group is already gone, which is the state the caller wanted.
#[cfg(unix)]
fn kill_process_group(pid: u32) {
    // The negated pid addresses the process group `configure_process_group` put the child in, so
    // the ffmpeg grandchild yt-dlp spawns for a merge goes with it.
    let group = -(pid as libc::pid_t);

    // SAFETY: kill(2) takes a pid and a signal number and has no memory-safety preconditions. A
    // stale pid at worst signals nothing (ESRCH) or, in theory, a recycled group, which the spawn
    // of a separate `kill` process was equally exposed to.
    let result = unsafe { libc::kill(group, libc::SIGKILL) };

    if result != 0 {
        let error = std::io::Error::last_os_error();

        if error.raw_os_error() != Some(libc::ESRCH) {
            crate::services::logger::warn(
                "process",
                format!("failed to kill process group {pid}: {error}"),
            );
        }
    }
}

#[cfg(unix)]
pub async fn kill_process_tree(pid: u32) {
    kill_process_group(pid);
}

#[cfg(not(any(target_os = "windows", unix)))]
pub async fn kill_process_tree(pid: u32) {
    if let Ok(mut child) = tokio::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        // Bound the wait on the killer itself so a hung kill cannot stall the caller.
        let _ = tokio::time::timeout(KILL_WAIT_TIMEOUT, child.wait()).await;
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

    // Spawn and wait with a bound rather than `status()`. The app-exit sweep calls this on the
    // event-loop thread, where a hung taskkill would block shutdown indefinitely.
    match command.spawn() {
        Ok(child) => wait_child_bounded_blocking(child),
        Err(error) => crate::services::logger::warn(
            "process",
            format!("failed to start taskkill for process tree {pid}: {error}"),
        ),
    }
}

/// Synchronous counterpart for the app-exit path. The syscall is already synchronous and cannot
/// hang, so unlike the Windows variant there is no killer child to bound a wait on.
#[cfg(unix)]
pub fn kill_process_tree_blocking(pid: u32) {
    kill_process_group(pid);
}

#[cfg(not(any(target_os = "windows", unix)))]
pub fn kill_process_tree_blocking(pid: u32) {
    if let Ok(child) = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        wait_child_bounded_blocking(child);
    }
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

    /// Spawns a long sleeper in its own process group, the way every real yt-dlp/ffmpeg child is
    /// spawned, so the group kill has a real target. Returns the child handle to assert on.
    #[cfg(unix)]
    fn spawn_sleeper_in_own_group() -> std::process::Child {
        let mut command = std::process::Command::new("sleep");
        command
            .arg("30")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        configure_process_group_blocking(&mut command);
        command.spawn().expect("spawn a sleeper")
    }

    #[cfg(unix)]
    fn was_killed_by_sigkill(status: std::process::ExitStatus) -> bool {
        use std::os::unix::process::ExitStatusExt;
        status.signal() == Some(libc::SIGKILL)
    }

    #[test]
    fn a_pinned_working_directory_is_where_the_child_starts() {
        // A real child printing its own working directory, because the property is about what
        // the OS hands the process, not about a field on the builder. Canonicalized on both sides,
        // since Windows prints the drive-letter form and macOS resolves /var to /private/var.
        let dir = std::env::temp_dir().join(format!(
            "kavynex-cwd-test-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&dir).expect("create the pinned directory");

        #[cfg(windows)]
        let mut command = {
            let mut command = std::process::Command::new("cmd");
            command.args(["/C", "cd"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = std::process::Command::new("pwd");

        pin_working_dir(&mut command, &dir);

        let output = command.output().expect("run the child");
        let printed = String::from_utf8_lossy(&output.stdout).trim().to_string();

        assert_eq!(
            std::fs::canonicalize(&printed).expect("the printed directory exists"),
            std::fs::canonicalize(&dir).expect("the pinned directory exists")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_default_child_working_directory_exists() {
        // `current_dir` on a missing directory fails the spawn, so the fallback has to be a
        // directory that is there on every machine without the app creating it.
        assert!(default_child_working_dir().is_dir());
    }

    // Spawns a real child. The whole point of the syscall version is that it no longer depends on a
    // `kill` binary being on PATH, so the assertion is on the child's exit status, not on a spawn.
    #[cfg(unix)]
    #[test]
    fn kill_process_tree_blocking_terminates_the_group_with_sigkill() {
        let mut child = spawn_sleeper_in_own_group();

        kill_process_tree_blocking(child.id());

        let status = child.wait().expect("wait for the killed sleeper");
        assert!(
            was_killed_by_sigkill(status),
            "the sleeper should have died from SIGKILL, got {status:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_process_tree_terminates_the_group_with_sigkill() {
        let mut child = spawn_sleeper_in_own_group();

        kill_process_tree(child.id()).await;

        let status = child.wait().expect("wait for the killed sleeper");
        assert!(
            was_killed_by_sigkill(status),
            "the sleeper should have died from SIGKILL, got {status:?}"
        );
    }

    // A group that is already gone is the outcome the caller wanted, so it is neither an error nor
    // a panic. Killing the same group twice is what the app-exit sweep does for the main download
    // child (once via the download registry, once via the process registry).
    #[cfg(unix)]
    #[test]
    fn killing_an_already_exited_group_is_a_no_op() {
        let mut child = spawn_sleeper_in_own_group();
        let pid = child.id();

        kill_process_tree_blocking(pid);
        let _ = child.wait();

        kill_process_tree_blocking(pid);
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
