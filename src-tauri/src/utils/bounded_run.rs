//! Running an external program to completion under a time limit, the one way every yt-dlp and
//! FFmpeg run outside the download does it (the health checks, the metadata, comment and format
//! runs, the thumbnail and avatar runs, and the two local FFmpeg thumbnail generators).
//!
//! Each of those used to carry its own copy of the same loop (spawn, drain both pipes, wait with a
//! deadline, kill the tree, join the readers), and the copies drifted. The bound on draining the
//! pipes after the program exits reached two of five, so a grandchild holding a pipe open (Deno,
//! FFmpeg) turned a finished thumbnail run into a timeout and left a health check's reader thread
//! waiting for good. One copy did not kill a program it could no longer poll. Here every run gets
//! all of it:
//!
//! - the child setup of [`configure_child`] (no console, its own process group, no stdin, no
//!   AppImage library variables), and a [`TrackedChildGuard`] so the app-exit sweep reaches it;
//! - both pipes drained while it runs, so neither can fill and stall it;
//! - the deadline, and the caller's cancel flag for the async runs, each ending in a kill of the
//!   whole process tree, as does a wait that fails. An async run can also be given an idle limit
//!   ([`RunLimits`]), which ends it when it has printed nothing for that long;
//! - after it exits, at most [`PIPE_DRAIN_AFTER_EXIT`] for the readers to finish.
//!
//! What stays with the caller is what differs between them. The command and its arguments, where
//! it starts (`pin_working_dir`), the yt-dlp runtime it is shown, the semaphore it queues on, how
//! its output is read, and which errors the outcome becomes.
//!
//! The download is not one of these. It streams progress line by line and has a stall watchdog of
//! its own (`services::yt_dlp::download`).
//!
//! [`configure_child`]: crate::utils::process::configure_child
//! [`TrackedChildGuard`]: crate::services::process_registry::TrackedChildGuard

use std::future::Future;
use std::pin::Pin;
use std::process::{ExitStatus, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, ReadBuf};

use crate::services::process_registry::TrackedChildGuard;
use crate::utils::process::{
    configure_child, configure_child_async, kill_process_tree, kill_process_tree_blocking,
    wait_for_cancel,
};
use crate::utils::task::{join_within, PIPE_DRAIN_AFTER_EXIT};

/// How often a blocking run checks whether the program exited. Short enough that the deadline
/// fires promptly, long enough not to busy-spin the blocking-pool thread.
const BLOCKING_POLL: Duration = Duration::from_millis(50);

/// Why a run ended without the program exiting on its own.
#[derive(Debug)]
pub(crate) enum RunFailure {
    /// The program could not be started.
    Spawn(std::io::Error),
    /// Its exit could not be waited for. It was killed with everything it started.
    Wait(std::io::Error),
    /// It ran past the time limit and was killed with everything it started.
    TimedOut,
    /// It printed nothing for the idle limit and was killed with everything it started.
    Stalled,
    /// The caller's cancel flag was set, and it was killed with everything it started.
    Cancelled,
}

/// How long an async run may take.
///
/// `total` alone suits a run that is over in seconds. One whose length follows what it is asked
/// for (the comments of a video, a page at a time) has no total that fits both the short and the
/// long case. Sized for the long one it leaves a hung run unnoticed, and sized for the short one it
/// kills a run that is working. Such a run prints as it goes, so `idle` ends it when it stops
/// printing, and `total` stays as the ceiling for one that prints forever.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RunLimits {
    total: Duration,
    idle: Option<Duration>,
}

impl RunLimits {
    /// At most `total`, however much the run prints.
    pub(crate) fn total(total: Duration) -> Self {
        Self { total, idle: None }
    }

    /// Also ended once it has printed nothing, on either stream, for `idle`.
    pub(crate) fn idle_after(self, idle: Duration) -> Self {
        Self {
            idle: Some(idle),
            ..self
        }
    }
}

impl From<Duration> for RunLimits {
    fn from(total: Duration) -> Self {
        Self::total(total)
    }
}

/// When a run last printed something, counted from its start.
struct Activity {
    started: tokio::time::Instant,
    last_output_ms: AtomicU64,
}

impl Activity {
    fn starting_now() -> Arc<Self> {
        Arc::new(Self {
            started: tokio::time::Instant::now(),
            last_output_ms: AtomicU64::new(0),
        })
    }

    fn stamp(&self) {
        let elapsed = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.last_output_ms.store(elapsed, Ordering::Relaxed);
    }

    /// How long ago the last output was, or the start when there has been none.
    fn quiet_for(&self) -> Duration {
        let last_output = Duration::from_millis(self.last_output_ms.load(Ordering::Relaxed));
        self.started.elapsed().saturating_sub(last_output)
    }
}

/// Completes once the run has been quiet for `idle`. Never, without an idle limit.
async fn quiet_for_too_long(activity: &Activity, idle: Option<Duration>) {
    let Some(idle) = idle else {
        return std::future::pending().await;
    };

    loop {
        let quiet = activity.quiet_for();

        if quiet >= idle {
            return;
        }

        tokio::time::sleep(idle - quiet).await;
    }
}

/// One of a run's pipes, handed to its reader. Reads like the pipe, and every read that returns
/// bytes counts as the run showing it is still working ([`RunLimits::idle_after`]).
pub(crate) struct Watched<R> {
    pipe: R,
    activity: Arc<Activity>,
}

impl<R: AsyncRead + Unpin> AsyncRead for Watched<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let filled_before = buffer.filled().len();
        let polled = Pin::new(&mut self.pipe).poll_read(cx, buffer);

        if matches!(polled, Poll::Ready(Ok(()))) && buffer.filled().len() > filled_before {
            self.activity.stamp();
        }

        polled
    }
}

/// What a blocking run keeps of the program's output.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Capture {
    /// Nothing. The program writes to closed pipes.
    Discard,
    /// Up to this many bytes of each stream. The rest is read and dropped, so the program never
    /// blocks on a full pipe.
    Bytes(usize),
}

/// Runs `command` on the calling thread until it exits, for at most `timeout`. For the blocking
/// call sites (the health checks, the local FFmpeg thumbnails), which already run on the blocking
/// pool.
///
/// The output is whatever the readers held once the program exited, or empty for a stream still
/// held open after [`PIPE_DRAIN_AFTER_EXIT`].
pub(crate) fn run_bounded_blocking(
    mut command: std::process::Command,
    timeout: Duration,
    capture: Capture,
) -> Result<Output, RunFailure> {
    let max_bytes = match capture {
        Capture::Discard => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
            0
        }
        Capture::Bytes(max_bytes) => {
            command.stdout(Stdio::piped()).stderr(Stdio::piped());
            max_bytes
        }
    };
    configure_child(&mut command);

    let mut child = command.spawn().map_err(RunFailure::Spawn)?;
    let _tracked = TrackedChildGuard::register(Some(child.id()));

    let stdout = drain_on_thread(child.stdout.take(), max_bytes);
    let stderr = drain_on_thread(child.stderr.take(), max_bytes);
    let deadline = Instant::now() + timeout;

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                kill_process_tree_blocking(child.id());
                let _ = child.wait();
                return Err(RunFailure::TimedOut);
            }
            Ok(None) => std::thread::sleep(BLOCKING_POLL),
            Err(error) => {
                // Not known to have exited, so it is killed like a timeout rather than left running
                // with its readers blocked on pipes that never close.
                kill_process_tree_blocking(child.id());
                let _ = child.wait();
                return Err(RunFailure::Wait(error));
            }
        }
    };

    let drained_by = Instant::now() + PIPE_DRAIN_AFTER_EXIT;

    Ok(Output {
        status,
        stdout: stdout.collect(drained_by),
        stderr: stderr.collect(drained_by),
    })
}

/// A pipe being drained on a thread of its own, into a buffer this side can read before it ends.
struct Drain(Option<DrainingPipe>);

struct DrainingPipe {
    buffer: Arc<Mutex<Vec<u8>>>,
    done: mpsc::Receiver<()>,
}

fn drain_on_thread(stream: Option<impl std::io::Read + Send + 'static>, max_bytes: usize) -> Drain {
    let Some(stream) = stream else {
        return Drain(None);
    };

    let buffer = Arc::new(Mutex::new(Vec::new()));
    let filling = Arc::clone(&buffer);
    let (finished, done) = mpsc::channel();

    std::thread::spawn(move || {
        crate::utils::io::read_drain_capped_into(stream, max_bytes, &filling);
        let _ = finished.send(());
    });

    Drain(Some(DrainingPipe { buffer, done }))
}

impl Drain {
    /// What the reader held by `deadline`. The whole output when the pipe closed by then, and what
    /// had arrived when it had not. A program that exited while a child it started holds the pipe
    /// (`yt-dlp --version` printing its line, say) still has that line read, where waiting for the
    /// end alone dropped it. A reader still waiting is left to end with its pipe.
    fn collect(self, deadline: Instant) -> Vec<u8> {
        let Some(DrainingPipe { buffer, done }) = self.0 else {
            return Vec::new();
        };

        let _ = done.recv_timeout(deadline.saturating_duration_since(Instant::now()));

        let held = std::mem::take(
            &mut *buffer
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );

        held
    }
}

/// What an async run's readers held once the program exited.
pub(crate) struct AsyncOutput<O, E> {
    pub status: ExitStatus,
    pub stdout: O,
    pub stderr: E,
    /// The stdout reader had not finished within [`PIPE_DRAIN_AFTER_EXIT`] of the exit, because a
    /// program the run started still held the pipe (or the reader panicked). `stdout` is what it
    /// had read by then, which is often all of it.
    pub stdout_cut_short: bool,
}

/// Runs `command` until it exits, within `limits` (a `Duration` is a total with no idle limit), or
/// until `cancel` is set. For the async call sites (the yt-dlp metadata and thumbnail runs).
///
/// Each pipe is read by the reader the caller passes, on a task of its own, so a run that needs
/// its stdout as JSON and its stderr as filtered lines reads them that way. The reader fills a
/// value it shares with the run rather than returning one, so what it had read is kept when a
/// program the run started holds the pipe past the exit. Returned only at the end, that output was
/// lost with the reader, and a finished run whose JSON had arrived failed as if it had none.
///
/// The readers get the pipes as [`Watched`], which is how an idle limit sees output. It counts
/// what a reader takes off the pipe, so a reader that stops reading makes the run read as idle.
pub(crate) async fn run_bounded_async<O, E, ReadOut, ReadErr>(
    mut command: tokio::process::Command,
    limits: impl Into<RunLimits>,
    cancel: Option<&AtomicBool>,
    read_stdout: impl FnOnce(Watched<tokio::process::ChildStdout>, Arc<Mutex<O>>) -> ReadOut,
    read_stderr: impl FnOnce(Watched<tokio::process::ChildStderr>, Arc<Mutex<E>>) -> ReadErr,
) -> Result<AsyncOutput<O, E>, RunFailure>
where
    ReadOut: Future<Output = ()> + Send + 'static,
    ReadErr: Future<Output = ()> + Send + 'static,
    O: Default + Send + 'static,
    E: Default + Send + 'static,
{
    let limits = limits.into();

    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    configure_child_async(&mut command);

    let mut child = command.spawn().map_err(RunFailure::Spawn)?;
    let pid = child.id();
    let _tracked = TrackedChildGuard::register(pid);
    let activity = Activity::starting_now();

    let stdout_read = Arc::new(Mutex::new(O::default()));
    let stderr_read = Arc::new(Mutex::new(E::default()));
    let stdout_task = child.stdout.take().map(|pipe| {
        let watched = Watched {
            pipe,
            activity: Arc::clone(&activity),
        };
        tauri::async_runtime::spawn(read_stdout(watched, Arc::clone(&stdout_read)))
    });
    let stderr_task = child.stderr.take().map(|pipe| {
        let watched = Watched {
            pipe,
            activity: Arc::clone(&activity),
        };
        tauri::async_runtime::spawn(read_stderr(watched, Arc::clone(&stderr_read)))
    });

    // The child is borrowed by the wait rather than moved into it, so it is still alive when a
    // timeout or a cancel kills its tree. Dropped first (and `kill_on_drop` ended it), a tree kill
    // by the pid of a process already gone does not find the FFmpeg it started on Windows.
    let outcome = tokio::select! {
        waited = tokio::time::timeout(limits.total, child.wait()) => match waited {
            Ok(Ok(status)) => Ok(status),
            Ok(Err(error)) => Err(RunFailure::Wait(error)),
            Err(_) => Err(RunFailure::TimedOut),
        },
        () = quiet_for_too_long(&activity, limits.idle) => Err(RunFailure::Stalled),
        () = wait_for_cancel(cancel) => Err(RunFailure::Cancelled),
    };

    let status = match outcome {
        Ok(status) => status,
        Err(failure) => {
            if let Some(pid) = pid {
                kill_process_tree(pid).await;
            }
            let _ = child.kill().await;

            if let Some(task) = stdout_task {
                task.abort();
            }
            if let Some(task) = stderr_task {
                task.abort();
            }

            return Err(failure);
        }
    };

    let stdout_finished = reader_finished(stdout_task).await;
    reader_finished(stderr_task).await;

    Ok(AsyncOutput {
        status,
        stdout: take_read(&stdout_read),
        stderr: take_read(&stderr_read),
        stdout_cut_short: !stdout_finished,
    })
}

/// Waits at most [`PIPE_DRAIN_AFTER_EXIT`] for a reader, and whether it reached the end of its
/// pipe. One still waiting is stopped, and what it read stays in its shared value.
async fn reader_finished(task: Option<tauri::async_runtime::JoinHandle<()>>) -> bool {
    match task {
        Some(task) => matches!(join_within(task, PIPE_DRAIN_AFTER_EXIT).await, Some(Ok(()))),
        None => true,
    }
}

/// What a reader put in its shared value.
fn take_read<T: Default>(read: &Mutex<T>) -> T {
    std::mem::take(&mut *read.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A program that prints a line and exits at once.
    fn quick_command() -> std::process::Command {
        if cfg!(windows) {
            let mut command = std::process::Command::new("cmd");
            command.args(["/C", "echo hello"]);
            command
        } else {
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "echo hello"]);
            command
        }
    }

    /// A program that outlives any timeout these tests use.
    fn slow_args() -> (&'static str, Vec<&'static str>) {
        if cfg!(windows) {
            ("ping", vec!["-n", "30", "127.0.0.1"])
        } else {
            ("sleep", vec!["30"])
        }
    }

    /// A program that exits at once after starting one that inherits its output and keeps it open,
    /// the way Deno or FFmpeg under yt-dlp can.
    fn leaves_its_output_held() -> (&'static str, Vec<&'static str>) {
        if cfg!(windows) {
            (
                "cmd",
                vec!["/C", "start /b ping -n 20 127.0.0.1 > NUL & echo done"],
            )
        } else {
            ("sh", vec!["-c", "sleep 20 & echo done"])
        }
    }

    #[test]
    fn a_blocking_run_returns_what_the_program_printed() {
        let output = run_bounded_blocking(
            quick_command(),
            Duration::from_secs(20),
            Capture::Bytes(1024),
        )
        .unwrap();

        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("hello"));
    }

    #[test]
    fn a_blocking_run_that_discards_its_output_keeps_none() {
        let output =
            run_bounded_blocking(quick_command(), Duration::from_secs(20), Capture::Discard)
                .unwrap();

        assert!(output.status.success());
        assert!(output.stdout.is_empty());
    }

    #[test]
    fn a_blocking_run_past_its_time_is_killed_and_says_so() {
        let (binary, args) = slow_args();
        let mut command = std::process::Command::new(binary);
        command.args(args);
        let started = Instant::now();

        let failure = run_bounded_blocking(command, Duration::from_secs(1), Capture::Bytes(1024))
            .unwrap_err();

        assert!(matches!(failure, RunFailure::TimedOut));
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn a_blocking_run_of_a_missing_program_fails_to_start() {
        let command = std::process::Command::new("kavynex-no-such-binary");

        let failure =
            run_bounded_blocking(command, Duration::from_secs(5), Capture::Discard).unwrap_err();

        assert!(matches!(failure, RunFailure::Spawn(_)));
    }

    #[test]
    fn a_blocking_run_whose_output_a_child_still_holds_still_returns() {
        // The program is done. Waiting for the pipe to close would wait for the child it started.
        let (binary, args) = leaves_its_output_held();
        let mut command = std::process::Command::new(binary);
        command.args(args);
        let started = Instant::now();

        let output =
            run_bounded_blocking(command, Duration::from_secs(60), Capture::Bytes(1024)).unwrap();

        assert!(output.status.success());
        assert!(started.elapsed() < PIPE_DRAIN_AFTER_EXIT + Duration::from_secs(5));
    }

    #[tokio::test]
    async fn an_async_run_whose_output_a_child_still_holds_succeeds_rather_than_timing_out() {
        // The thumbnail run waited for its readers inside its timeout, so this finished run read as
        // timed out after a minute.
        let (binary, args) = leaves_its_output_held();
        let mut command = tokio::process::Command::new(binary);
        command.args(args);
        let started = Instant::now();

        let output = run_bounded_async(
            command,
            Duration::from_secs(60),
            None,
            |mut stdout, read: Arc<Mutex<Vec<u8>>>| async move {
                let mut chunk = [0u8; 256];

                while let Ok(count @ 1..) =
                    tokio::io::AsyncReadExt::read(&mut stdout, &mut chunk).await
                {
                    read.lock().unwrap().extend_from_slice(&chunk[..count]);
                }
            },
            |_stderr, _read: Arc<Mutex<()>>| async {},
        )
        .await
        .unwrap();

        assert!(output.status.success());
        assert!(started.elapsed() < PIPE_DRAIN_AFTER_EXIT + Duration::from_secs(5));
        // What it printed before exiting is kept. Lost with the reader, a finished metadata run
        // whose JSON had arrived failed as if it had printed nothing.
        assert!(String::from_utf8_lossy(&output.stdout).contains("done"));
    }

    #[tokio::test]
    async fn an_async_run_is_killed_when_cancelled() {
        let (binary, args) = slow_args();
        let mut command = tokio::process::Command::new(binary);
        command.args(args);
        let cancel = AtomicBool::new(true);

        let failure = run_bounded_async(
            command,
            Duration::from_secs(30),
            Some(&cancel),
            |_stdout, _read: Arc<Mutex<()>>| async {},
            |_stderr, _read: Arc<Mutex<()>>| async {},
        )
        .await
        .err()
        .expect("a set cancel flag ends the run");

        assert!(matches!(failure, RunFailure::Cancelled));
    }

    /// A program that prints nothing and outlives any limit these tests use.
    fn silent_args() -> (&'static str, Vec<&'static str>) {
        if cfg!(windows) {
            ("cmd", vec!["/C", "ping -n 30 127.0.0.1 > NUL"])
        } else {
            ("sleep", vec!["30"])
        }
    }

    /// A program that prints a line a second for about six seconds and then exits cleanly.
    fn ticking_args() -> (&'static str, Vec<&'static str>) {
        if cfg!(windows) {
            ("ping", vec!["-n", "7", "127.0.0.1"])
        } else {
            (
                "sh",
                vec!["-c", "for i in 1 2 3 4 5 6; do echo tick; sleep 1; done"],
            )
        }
    }

    /// Reads a pipe to its end, keeping nothing.
    async fn drain(mut pipe: impl AsyncRead + Unpin) {
        let mut chunk = [0u8; 256];

        while let Ok(1..) = tokio::io::AsyncReadExt::read(&mut pipe, &mut chunk).await {}
    }

    #[tokio::test]
    async fn an_async_run_that_prints_nothing_is_stopped_as_stalled_long_before_its_total() {
        let (binary, args) = silent_args();
        let mut command = tokio::process::Command::new(binary);
        command.args(args);
        let started = Instant::now();

        let failure = run_bounded_async(
            command,
            RunLimits::total(Duration::from_secs(60)).idle_after(Duration::from_secs(1)),
            None,
            |stdout, _read: Arc<Mutex<()>>| drain(stdout),
            |stderr, _read: Arc<Mutex<()>>| drain(stderr),
        )
        .await
        .err()
        .expect("a run that prints nothing ends at its idle limit");

        assert!(matches!(failure, RunFailure::Stalled));
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[tokio::test]
    async fn an_async_run_that_keeps_printing_runs_past_its_idle_limit() {
        // Twice the idle limit in all, and never that long between two lines. Counted from the
        // start, the limit would end it halfway.
        let (binary, args) = ticking_args();
        let mut command = tokio::process::Command::new(binary);
        command.args(args);
        let started = Instant::now();

        let output = run_bounded_async(
            command,
            RunLimits::total(Duration::from_secs(60)).idle_after(Duration::from_secs(3)),
            None,
            |stdout, _read: Arc<Mutex<()>>| drain(stdout),
            |stderr, _read: Arc<Mutex<()>>| drain(stderr),
        )
        .await
        .unwrap();

        assert!(output.status.success());
        assert!(
            started.elapsed() > Duration::from_secs(4),
            "the run has to outlast the idle limit for this to say anything"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_run_with_no_idle_limit_is_never_quiet_for_too_long() {
        let activity = Activity::starting_now();

        let waited = tokio::time::timeout(
            Duration::from_secs(24 * 60 * 60),
            quiet_for_too_long(&activity, None),
        )
        .await;

        assert!(waited.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn the_idle_limit_counts_from_the_last_output() {
        let activity = Activity::starting_now();
        let idle = Duration::from_secs(10);

        // Output every six seconds for a minute never leaves ten seconds of quiet.
        let printing = async {
            for _ in 0..10 {
                tokio::time::sleep(Duration::from_secs(6)).await;
                activity.stamp();
            }
        };

        tokio::select! {
            () = quiet_for_too_long(&activity, Some(idle)) => {
                panic!("a run that keeps printing is not idle")
            }
            () = printing => {}
        }

        // Then nothing more, and the limit is reached ten seconds after the last output.
        let last_output = tokio::time::Instant::now();
        quiet_for_too_long(&activity, Some(idle)).await;

        assert!(last_output.elapsed() >= idle);
        assert!(last_output.elapsed() < idle + Duration::from_secs(1));
    }

    #[tokio::test(start_paused = true)]
    async fn a_run_that_never_prints_is_idle_from_its_start() {
        let activity = Activity::starting_now();
        let idle = Duration::from_secs(10);
        let started = tokio::time::Instant::now();

        quiet_for_too_long(&activity, Some(idle)).await;

        assert!(started.elapsed() >= idle);
        assert!(started.elapsed() < idle + Duration::from_secs(1));
    }

    #[tokio::test(start_paused = true)]
    async fn bytes_read_through_a_watched_pipe_count_as_output_and_its_end_does_not() {
        let activity = Activity::starting_now();
        let mut watched = Watched {
            pipe: &b"line\n"[..],
            activity: Arc::clone(&activity),
        };
        let mut buffer = [0u8; 16];

        tokio::time::sleep(Duration::from_secs(5)).await;
        assert!(activity.quiet_for() >= Duration::from_secs(5));

        let read = tokio::io::AsyncReadExt::read(&mut watched, &mut buffer)
            .await
            .unwrap();
        assert_eq!(read, 5);
        assert_eq!(activity.quiet_for(), Duration::ZERO);

        tokio::time::sleep(Duration::from_secs(3)).await;
        let read = tokio::io::AsyncReadExt::read(&mut watched, &mut buffer)
            .await
            .unwrap();
        assert_eq!(read, 0);
        assert!(activity.quiet_for() >= Duration::from_secs(3));
    }

    /// Hands over one line, then holds the pipe open well past the drain deadline, as a child
    /// that inherited it does.
    struct LineThenHeld(bool);

    impl std::io::Read for LineThenHeld {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if self.0 {
                std::thread::sleep(Duration::from_secs(2));
                return Ok(0);
            }

            self.0 = true;
            let line = b"2026.10.01
";
            buffer[..line.len()].copy_from_slice(line);
            Ok(line.len())
        }
    }

    #[test]
    fn a_pipe_still_held_at_the_deadline_keeps_what_it_had_read() {
        let drain = drain_on_thread(Some(LineThenHeld(false)), 1024);

        let started = Instant::now();
        let output = drain.collect(Instant::now() + Duration::from_millis(200));

        assert_eq!(
            output,
            b"2026.10.01
"
        );
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the deadline, not the pipe, ends the wait"
        );
    }
}
