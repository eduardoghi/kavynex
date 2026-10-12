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

/// The empty folder [`default_child_working_dir`] answers with once startup has made it.
static PRIVATE_CHILD_WORKING_DIR: std::sync::OnceLock<std::path::PathBuf> =
    std::sync::OnceLock::new();

/// The cache subfolder made at startup for [`default_child_working_dir`].
pub const CHILD_WORKING_DIR_NAME: &str = "child-cwd";

/// Makes `cache_dir/child-cwd` and has [`default_child_working_dir`] answer with it from then on.
/// Called once from setup. A folder that cannot be made leaves the fallback in place.
pub fn init_private_child_working_dir(cache_dir: &std::path::Path) {
    let dir = cache_dir.join(CHILD_WORKING_DIR_NAME);

    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = PRIVATE_CHILD_WORKING_DIR.set(dir);
    }
}

/// Where a child starts when the caller has no directory of its own for the run (the version
/// health checks, the metadata, format and comment yt-dlp runs).
///
/// An empty folder in the app's cache, made at startup. The process temp directory was used before
/// it, and is where any program unpacks what it runs, so on Windows a `ffprobe.exe` or `deno.exe`
/// left there was found by yt-dlp's lookups by bare name, which search the working directory first.
/// The temp directory stays as the fallback for a run before setup (tests, the smoke checks).
pub fn default_child_working_dir() -> std::path::PathBuf {
    PRIVATE_CHILD_WORKING_DIR
        .get()
        .cloned()
        .unwrap_or_else(std::env::temp_dir)
}

/// Keeps a Windows child from finding programs in its working directory when it looks one up by
/// bare name. Honored by `CreateProcess` without a path, `cmd.exe` and Python's `shutil.which`, which
/// is how yt-dlp probes for `ffmpeg`, `ffprobe` and `deno`. Pinning the working directory decides
/// which folder that is. This takes it out of the search.
#[cfg(windows)]
const NO_CWD_IN_EXE_SEARCH: (&str, &str) = ("NoDefaultCurrentDirectoryInExePath", "1");

/// Variables an AppImage's launcher sets for the app's own bundled libraries and runtimes. A child
/// inheriting them is a system yt-dlp or FFmpeg loading the bundle's copies, built against other
/// versions, which fails with symbol errors that name nothing the user installed.
const APPIMAGE_ONLY_ENV: [&str; 8] = [
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "PYTHONHOME",
    "PYTHONPATH",
    "GIO_MODULE_DIR",
    "GDK_PIXBUF_MODULE_FILE",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
];

/// The variables to remove from a child's environment. Only inside an AppImage, which is what
/// sets `APPIMAGE`. Anywhere else these belong to the user and are passed through untouched.
fn env_to_clear(is_appimage: bool) -> &'static [&'static str] {
    if is_appimage {
        &APPIMAGE_ONLY_ENV
    } else {
        &[]
    }
}

fn running_inside_appimage() -> bool {
    std::env::var_os("APPIMAGE").is_some()
}

/// Keeps yt-dlp from loading plugins. `--ignore-config` drops the user's configuration files but not
/// the plugin folders (in the user's config directory and beside the binary), and a plugin is Python
/// that runs inside the process holding the browser cookies. The app uses none. Harmless to the
/// other children, and to a yt-dlp too old to know the variable.
const NO_YT_DLP_PLUGINS: (&str, &str) = ("YTDLP_NO_PLUGINS", "1");

/// What every yt-dlp and FFmpeg child gets before it is spawned, in one place so no spawn site can
/// leave one out. No console window, its own process group (so the tree kill reaches FFmpeg under
/// yt-dlp), no stdin, and none of an AppImage's library variables. Where it starts is still chosen
/// per site ([`pin_working_dir`]), because each has its own directory for the run.
pub fn configure_child(command: &mut std::process::Command) {
    command.stdin(std::process::Stdio::null());
    hide_console(command);
    configure_process_group_blocking(command);
    command.env(NO_YT_DLP_PLUGINS.0, NO_YT_DLP_PLUGINS.1);
    #[cfg(windows)]
    command.env(NO_CWD_IN_EXE_SEARCH.0, NO_CWD_IN_EXE_SEARCH.1);

    for name in env_to_clear(running_inside_appimage()) {
        command.env_remove(name);
    }
}

/// [`configure_child`] for an async [`tokio::process::Command`], which is also killed when its
/// handle is dropped, so an early return never leaves the direct child running.
pub fn configure_child_async(command: &mut tokio::process::Command) {
    command.stdin(std::process::Stdio::null());
    command.kill_on_drop(true);
    hide_console_async(command);
    configure_process_group(command);
    command.env(NO_YT_DLP_PLUGINS.0, NO_YT_DLP_PLUGINS.1);
    #[cfg(windows)]
    command.env(NO_CWD_IN_EXE_SEARCH.0, NO_CWD_IN_EXE_SEARCH.1);

    for name in env_to_clear(running_inside_appimage()) {
        command.env_remove(name);
    }
}

/// Puts the process `pid` in a job that Windows kills when the app's process ends, however it ends.
///
/// The exit handler kills every tracked child, but some exits never reach it. The updater installs
/// on Windows by calling `std::process::exit`, and a crash or a kill from the task manager skips it
/// too. A child in this job dies with the app all the same, and so do the processes it starts
/// afterwards (FFmpeg under yt-dlp), which inherit the job.
///
/// Best effort, and false when it did not happen (the process is gone, or the job could not be
/// made). Nothing else depends on it.
#[cfg(windows)]
pub fn attach_to_kill_on_close_job(pid: u32) -> bool {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    #[repr(C)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    struct ExtendedLimitInformation {
        basic_limit_information: BasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(
            job: *mut c_void,
            information_class: i32,
            information: *const c_void,
            length: u32,
        ) -> i32;
        fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> *mut c_void;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const PROCESS_TERMINATE: u32 = 0x0001;
    const PROCESS_SET_QUOTA: u32 = 0x0100;

    // The handle lives as long as the app's process, and the OS closing it at exit is what kills
    // the job's processes. Stored as an address because a raw pointer is not `Sync`. Zero means the
    // job could not be made, and nothing is attached.
    static JOB: OnceLock<usize> = OnceLock::new();

    let job = *JOB.get_or_init(|| {
        // SAFETY: both arguments may be null (default security, unnamed job). The limit structure
        // is fully initialized, matches JOBOBJECT_EXTENDED_LIMIT_INFORMATION's layout, and outlives
        // the call. A job that cannot be configured is closed and not used.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());

            if job.is_null() {
                return 0;
            }

            let mut limits: ExtendedLimitInformation = std::mem::zeroed();
            limits.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            let configured = SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                (&limits as *const ExtendedLimitInformation).cast(),
                std::mem::size_of::<ExtendedLimitInformation>() as u32,
            );

            if configured == 0 {
                CloseHandle(job);
                return 0;
            }

            job as usize
        }
    });

    if job == 0 {
        return false;
    }

    // SAFETY: `pid` names a child this process spawned and still holds, so it has not been reused.
    // The process handle is checked for null and always closed. The job handle is the live one
    // created above.
    unsafe {
        let process = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, pid);

        if process.is_null() {
            return false;
        }

        let assigned = AssignProcessToJobObject(job as *mut c_void, process);
        CloseHandle(process);

        assigned != 0
    }
}

/// Other platforms have no kill-on-close job. The exit sweep is what reaches a child there.
#[cfg(not(windows))]
pub fn attach_to_kill_on_close_job(_pid: u32) -> bool {
    false
}

/// `taskkill.exe` in the system directory, by its full path.
///
/// `Command::new("taskkill")` searches the directory the app was started from before the system
/// directories, so a `taskkill.exe` placed next to the installed app would be what every cancel and
/// every timeout ran. The same reason `services::file_manager` builds explorer's path from
/// `%SystemRoot%`.
#[cfg(target_os = "windows")]
fn taskkill_path() -> std::path::PathBuf {
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| String::from(r"C:\Windows"));
    std::path::Path::new(&system_root)
        .join("System32")
        .join("taskkill.exe")
}

/// Kills a spawned child *and* every descendant it created, asynchronously. `yt-dlp` routinely
/// spawns an `ffmpeg` child (merges, `--convert-thumbnails`), and killing only the direct
/// child (`Child::kill`/`kill_on_drop`) leaves that grandchild running. On Windows this uses
/// `taskkill /T` to walk the tree; on Unix it signals the whole process group set up by
/// [`configure_process_group`] via the negative pid.
#[cfg(target_os = "windows")]
pub async fn kill_process_tree(pid: u32) {
    let mut command = tokio::process::Command::new(taskkill_path());
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
/// Spawning `/usr/bin/kill -9 -<pid>` would make the one operation whose job is to stop an
/// orphaned yt-dlp/ffmpeg depend on resolving an executable through the process's `PATH`, with a
/// failed spawn swallowed. On a minimal PATH (an AppImage in a sandbox, a GUI launch that
/// inherited launchd's default) the cancel would look successful in the UI while the tree kept
/// running. The syscall has no such dependency, returns synchronously, and reports the one
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
    let mut command = std::process::Command::new(taskkill_path());
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

/// How many of a failed process's last output lines an error keeps.
const PROCESS_ERROR_MAX_LINES: usize = 8;

/// The most characters of output an error keeps, counted from the end.
const PROCESS_ERROR_MAX_CHARS: usize = 1_500;

/// The tail of a process's output that goes into an error, each line passed through `redact`.
///
/// The cause is at the end. Kept whole, ffmpeg's banner and stream dump, or a yt-dlp trace, put
/// kilobytes into a message that is logged and can reach the error modal, along with every path
/// the process printed. Returns `None` when nothing but blank lines is left.
pub(crate) fn process_output_tail(text: &str, redact: impl Fn(&str) -> String) -> Option<String> {
    let lines: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(redact)
        .collect();

    if lines.is_empty() {
        return None;
    }

    let tail = lines[lines.len().saturating_sub(PROCESS_ERROR_MAX_LINES)..].join("\n");
    let char_count = tail.chars().count();

    if char_count <= PROCESS_ERROR_MAX_CHARS {
        return Some(tail);
    }

    let kept: String = tail
        .chars()
        .skip(char_count - PROCESS_ERROR_MAX_CHARS)
        .collect();
    Some(format!("...{kept}"))
}

/// Builds an [`AppError`] from a failed child process's output, preferring stderr, then
/// stdout, then falling back to `default_message` when both streams are empty.
///
/// Only the tail of the output is kept, and `redact` runs on each kept line (see
/// [`process_output_tail`]), so a caller whose process prints a path it should not leak (the
/// user's input file, a cookies file) hides it here.
pub fn read_process_error(
    output: &std::process::Output,
    default_code: AppErrorCode,
    default_message: &str,
    redact: impl Fn(&str) -> String,
) -> AppError {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);

    let tail =
        process_output_tail(&stderr, &redact).or_else(|| process_output_tail(&stdout, &redact));

    match tail {
        Some(tail) => AppError::from_code(default_code, format!("{default_message}: {tail}")),
        None => AppError::from_code(default_code, default_message),
    }
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

    #[test]
    fn once_made_the_private_folder_is_where_children_start() {
        let cache = std::env::temp_dir().join(format!(
            "kavynex-child-cwd-test-{}",
            crate::utils::naming::unique_temp_suffix()
        ));

        init_private_child_working_dir(&cache);

        // Set once per process, so another test may have won the race. Either way the answer is a
        // folder that exists and is not the shared temp directory.
        let dir = default_child_working_dir();
        assert!(dir.is_dir());
        assert!(dir.ends_with(CHILD_WORKING_DIR_NAME));
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_child_does_not_search_its_working_directory_for_programs() {
        let mut command = std::process::Command::new("yt-dlp");
        configure_child(&mut command);

        assert!(command.get_envs().any(|(name, value)| {
            name == NO_CWD_IN_EXE_SEARCH.0 && value == Some(std::ffi::OsStr::new("1"))
        }));
    }

    #[test]
    fn a_child_is_told_not_to_load_yt_dlp_plugins() {
        let mut command = std::process::Command::new("yt-dlp");
        configure_child(&mut command);
        let mut async_command = tokio::process::Command::new("yt-dlp");
        configure_child_async(&mut async_command);

        for envs in [
            command.get_envs().collect::<Vec<_>>(),
            async_command.as_std().get_envs().collect::<Vec<_>>(),
        ] {
            assert!(envs.iter().any(|(name, value)| {
                *name == NO_YT_DLP_PLUGINS.0 && *value == Some(std::ffi::OsStr::new("1"))
            }));
        }
    }

    #[cfg(windows)]
    #[test]
    fn taskkill_is_run_from_the_system_directory() {
        let path = taskkill_path();

        assert!(path.is_absolute());
        assert!(path.ends_with(r"System32\taskkill.exe"));
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
            str::to_string,
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
            str::to_string,
        );

        assert_eq!(error.code, AppErrorCode::FfmpegFailed.as_str());
        assert!(error.message.contains("stdout message"));
    }

    #[test]
    fn a_process_error_keeps_only_the_last_lines_of_a_long_output() {
        let banner: String = (0..40)
            .map(|index| format!("banner line {index}\n"))
            .collect();
        let output = Output {
            status: exit_status(1),
            stdout: Vec::new(),
            stderr: format!("{banner}\nError opening input file\n").into_bytes(),
        };

        let error = read_process_error(
            &output,
            AppErrorCode::FfmpegFailed,
            "ffmpeg failed",
            str::to_string,
        );

        assert!(error.message.ends_with("Error opening input file"));
        assert!(error.message.contains("banner line 39"));
        assert!(!error.message.contains("banner line 32"));
        assert_eq!(error.message.lines().count(), PROCESS_ERROR_MAX_LINES);
    }

    #[test]
    fn a_process_error_caps_a_single_huge_line_from_the_end() {
        let line = format!("{}the cause", "x".repeat(10_000));

        let tail = process_output_tail(&line, str::to_string).unwrap();

        assert!(tail.starts_with("..."));
        assert!(tail.ends_with("the cause"));
        assert_eq!(tail.chars().count(), PROCESS_ERROR_MAX_CHARS + 3);
        // Exactly at the cap is kept whole.
        let at_cap = "y".repeat(PROCESS_ERROR_MAX_CHARS);
        assert_eq!(
            process_output_tail(&at_cap, str::to_string).unwrap(),
            at_cap
        );
    }

    #[test]
    fn a_process_error_redacts_every_kept_line() {
        let output = Output {
            status: exit_status(1),
            stdout: Vec::new(),
            stderr:
                b"Input #0, from 'C:/Users/me/secret.mp4':\nC:/Users/me/secret.mp4: Invalid data"
                    .to_vec(),
        };

        let error = read_process_error(
            &output,
            AppErrorCode::FfmpegFailed,
            "ffmpeg failed",
            |line| line.replace("C:/Users/me/secret.mp4", "<redacted>"),
        );

        assert!(!error.message.contains("secret"));
        assert_eq!(error.message.matches("<redacted>").count(), 2);
    }

    #[test]
    fn a_blank_stderr_falls_through_to_stdout() {
        let output = Output {
            status: exit_status(1),
            stdout: b"from stdout".to_vec(),
            stderr: b"  \n\n  ".to_vec(),
        };

        let error = read_process_error(
            &output,
            AppErrorCode::FfmpegFailed,
            "failed",
            str::to_string,
        );

        assert_eq!(error.message, "failed: from stdout");
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
            str::to_string,
        );

        assert_eq!(error.code, AppErrorCode::FfmpegFailed.as_str());
        assert_eq!(error.message, "ffmpeg failed to generate thumbnail");
    }

    #[test]
    fn an_appimage_clears_its_library_variables_from_a_child() {
        assert!(env_to_clear(true).contains(&"LD_LIBRARY_PATH"));
        assert!(env_to_clear(true).contains(&"PYTHONPATH"));
    }

    #[test]
    fn outside_an_appimage_a_child_keeps_the_users_environment() {
        assert!(env_to_clear(false).is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn a_running_child_can_be_put_in_the_kill_on_close_job() {
        let mut child = std::process::Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("ping is part of Windows");

        let attached = attach_to_kill_on_close_job(child.id());

        let _ = child.kill();
        let _ = child.wait();

        assert!(attached);
    }

    #[cfg(windows)]
    #[test]
    fn a_process_that_is_gone_is_not_attached() {
        // Pid 0 is the system idle process, which can never be opened for these rights.
        assert!(!attach_to_kill_on_close_job(0));
    }
}
