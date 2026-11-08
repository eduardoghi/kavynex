//! Running yt-dlp for one JSON document, bounded in time, in output and in how many run at once.

use super::*;

// Bounds how many standalone yt-dlp JSON runs (metadata, format listing, comments) execute at once.
// Each buffers up to MAX_YT_DLP_JSON_BYTES of stdout and spawns its own yt-dlp/ffmpeg process tree,
// so without a cap a compromised or buggy frontend firing these in a tight loop could exhaust memory
// and process handles. The main download path does not go through here (it has its own spawn and is
// bounded by the per-run registry), so gating this shared choke point does not throttle real
// downloads, only the metadata-style probes. Generous enough that normal interactive use (loading
// formats for a video, fetching its comments) never queues.
pub(super) const MAX_CONCURRENT_STANDALONE_RUNS: usize = 4;
// Ceiling on how many standalone runs may be in flight (running or queued) at once. The concurrency
// cap above bounds only how many spawn together. This bounds the queue behind it so a burst of IPC
// calls cannot pile up an unbounded backlog (see BoundedSemaphore). Set well above real interactive
// use. Loading formats and comments for a video never approaches it.
pub(super) const MAX_STANDALONE_RUNS_IN_FLIGHT: usize = 32;

// A single process-wide gate. There is one app, and unlike the pool it holds no state a test needs to
// inject.
pub(super) static STANDALONE_RUN_SEMAPHORE: BoundedSemaphore = BoundedSemaphore::new(
    MAX_CONCURRENT_STANDALONE_RUNS,
    MAX_STANDALONE_RUNS_IN_FLIGHT,
);
// Cap on how much yt-dlp stdout is buffered. `--dump-single-json` (with `--write-comments`)
// emits the whole payload as one line, so an extreme video could otherwise allocate GBs.
// Generous. Even very large comment sets fit well under this.
pub(super) const MAX_YT_DLP_JSON_BYTES: u64 = 128 * 1024 * 1024; // 128 MiB

/// The stderr lines a yt-dlp run keeps, the most recent 100. A metadata, comment or format run
/// hands them to the frontend as `terminal_logs`, and `-v` is always passed, so a chatty failure can
/// emit thousands. The download builds its failure message from its own.
pub(crate) type StderrTail = crate::utils::io::RecentLines<100>;

/// What the stdout of a JSON run held. The JSON line, the log lines kept for the terminal, and
/// whether the output ran past its cap.
#[derive(Debug, Default)]
pub(super) struct JsonStdout {
    payload: String,
    logs: Vec<String>,
    overflowed: bool,
}

/// Reads yt-dlp stdout, keeping the JSON payload line and the useful log lines, but never
/// buffering more than `max_bytes`. Returns `(json_payload, log_lines, overflowed)`, where
/// `overflowed` means the output exceeded the cap (and the payload may be truncated).
#[cfg(test)]
pub(super) async fn read_capped_json_stdout<R>(
    reader: R,
    max_bytes: u64,
) -> (String, Vec<String>, bool)
where
    R: AsyncRead + Unpin,
{
    let read = Mutex::new(JsonStdout::default());
    read_capped_json_stdout_into(reader, max_bytes, &read).await;
    let JsonStdout {
        payload,
        logs,
        overflowed,
    } = read.into_inner().unwrap();

    (payload, logs, overflowed)
}

/// Reads a JSON run's stdout into `read` a line at a time, so the JSON is there when a program
/// yt-dlp started holds the pipe past its exit and the run stops waiting (see
/// `utils::bounded_run`).
pub(super) async fn read_capped_json_stdout_into<R>(
    reader: R,
    max_bytes: u64,
    read: &Mutex<JsonStdout>,
) where
    R: AsyncRead + Unpin,
{
    // `+ 1` so a stream that reaches exactly `max_bytes + 1` bytes reveals the real output exceeded
    // the cap.
    let mut reader = BufReader::new(reader.take(max_bytes + 1));
    let mut line_buf: Vec<u8> = Vec::new();

    while let Some(mut line) = read_lossy_line(&mut reader, &mut line_buf).await {
        // Trimmed in place, since this line can be the whole metadata JSON.
        line.truncate(line.trim_end().len());

        if line.trim().is_empty() {
            continue;
        }

        let mut read = read.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        if is_json_payload_line(&line) {
            read.payload = line;
        } else if should_keep_terminal_line(&line) {
            read.logs.push(line);
        }
    }

    // The `Take` limit hits 0 exactly when the stream delivered all `max_bytes + 1` allowed bytes,
    // i.e. the real output exceeded `max_bytes`. This is an exact signal, unlike summing decoded
    // line lengths, which drifts from the raw byte count on CRLF line endings or on invalid UTF-8
    // replaced by the (multi-byte) U+FFFD.
    read.lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .overflowed = reader.get_ref().limit() == 0;
}

/// What every yt-dlp run whose output is one JSON document starts with. `--ignore-config` keeps a
/// configuration file the user has for their own yt-dlp from changing what is asked, and
/// `--no-warnings` keeps the output to what is parsed (the download, whose output is read, keeps
/// its warnings, see `yt_dlp::download::command`). Each caller adds its own flags, then `--` and
/// the URL last.
pub(crate) fn base_json_args() -> Vec<String> {
    ["--ignore-config", "--dump-single-json", "--no-warnings"]
        .map(String::from)
        .to_vec()
}

/// Reads yt-dlp's stderr as log lines, keeping only the ones worth showing and only the most
/// recent of them ([`StderrTail`]).
pub(super) async fn read_filtered_stderr_lines(
    stderr: tokio::process::ChildStderr,
    log_lines: Arc<Mutex<StderrTail>>,
) {
    let mut reader = BufReader::new(stderr);
    let mut line_buf: Vec<u8> = Vec::new();

    // stderr carries short log lines only (the JSON payload comes on stdout), so cap each line
    // tightly. Without it a single unterminated line could balloon far past the ring buffer's
    // intended bound (see MAX_PROGRESS_LINE_BYTES).
    while let Some(line_value) =
        read_lossy_line_capped(&mut reader, &mut line_buf, MAX_PROGRESS_LINE_BYTES).await
    {
        let line = line_value.trim_end().to_string();

        if should_keep_terminal_line(&line) {
            log_lines
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(line);
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(in crate::services::yt_dlp) async fn run_yt_dlp_and_capture_json(
    yt_dlp: &str,
    args: &[String],
    timeout_secs: u64,
    timeout_code: AppErrorCode,
    exec_code: AppErrorCode,
    failed_code: AppErrorCode,
    timeout_message: &str,
    exec_message: &str,
    failed_message: &str,
    cancel: Option<Arc<AtomicBool>>,
) -> AppResult<(String, Vec<String>, Vec<String>)> {
    // Bound concurrent standalone runs (see STANDALONE_RUN_SEMAPHORE). Held for the whole function
    // (spawn through wait), so at most MAX_CONCURRENT_STANDALONE_RUNS run at once. Excess callers
    // queue here rather than each spawning a process and buffering up to 128 MiB, and a queue
    // deeper than the in-flight ceiling is refused up front rather than enqueued without limit.
    // A cancel reaches a run still queued here too, as it does a download waiting for its slot,
    // rather than only once a permit frees and the run starts.
    let _permit = tokio::select! {
        // Checked first, so a run cancelled before it got a slot never starts.
        biased;

        () = crate::utils::process::wait_for_cancel(cancel.as_deref()) => {
            return Err(AppError::from_code(
                AppErrorCode::YtDlpDownloadCancelled,
                "yt-dlp download cancelled",
            ));
        }
        permit = STANDALONE_RUN_SEMAPHORE.acquire(AppErrorCode::TooManyConcurrentYtDlpRuns) => permit?,
    };

    let mut command = Command::new(yt_dlp);
    command.args(args);
    crate::services::binaries::expose_js_runtime_to_child(&mut command);
    // A metadata-only run writes nothing the app keeps, so it has no directory of its own to
    // start in. The default keeps it out of wherever the app was launched from (see
    // utils::process::pin_working_dir_async).
    crate::utils::process::pin_working_dir_async(
        &mut command,
        &crate::utils::process::default_child_working_dir(),
    );

    // Tracked for the app-exit sweep, killed as a tree on the timeout or a cancel, and its readers
    // given at most PIPE_DRAIN_AFTER_EXIT once yt-dlp exits (see utils::bounded_run). The cancel
    // only ever comes from the download flow. Other callers pass None.
    let run = crate::utils::bounded_run::run_bounded_async(
        command,
        Duration::from_secs(timeout_secs),
        cancel.as_deref(),
        |stdout, read| async move {
            read_capped_json_stdout_into(stdout, MAX_YT_DLP_JSON_BYTES, &read).await;
        },
        read_filtered_stderr_lines,
    )
    .await
    .map_err(|failure| {
        use crate::utils::bounded_run::RunFailure;

        match failure {
            RunFailure::Spawn(error) | RunFailure::Wait(error) => {
                AppError::from_code(exec_code, format!("{exec_message}: {error}"))
            }
            RunFailure::TimedOut => AppError::from_code(timeout_code, timeout_message),
            RunFailure::Cancelled => AppError::from_code(
                AppErrorCode::YtDlpDownloadCancelled,
                "yt-dlp download cancelled",
            ),
        }
    })?;

    let status = run.status;

    let JsonStdout {
        payload: json_payload,
        logs: stdout_logs,
        overflowed: stdout_overflowed,
    } = run.stdout;
    let stderr_logs = run.stderr.into_vec();

    // A grandchild that inherited the pipes can keep them open after yt-dlp exited. The JSON line
    // has usually arrived by then and is kept. A run cut short before it did fails here, since the
    // JSON on stdout is the whole point of the run.
    if run.stdout_cut_short && json_payload.trim().is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::YtDlpStdoutCaptureFailed,
            "yt-dlp exited but its output stayed open, held by a program it started",
        ));
    }

    // Ahead of the exit status. Once the reader stops at the cap it drops the pipe, and yt-dlp then
    // fails writing to it, so checked after the status this would read as an ordinary failure with
    // an unrelated stderr tail.
    if stdout_overflowed {
        return Err(AppError::from_code_with_details(
            AppErrorCode::YtDlpMetadataParseFailed,
            "yt-dlp returned more data than can be processed for this URL.",
            format!("yt-dlp output exceeded the {MAX_YT_DLP_JSON_BYTES}-byte limit"),
        ));
    }

    if !status.success() {
        let detail = select_best_error_detail(&stdout_logs, &stderr_logs, failed_message);
        // The detail is embedded in the returned AppError, which is serialized to the frontend and
        // written to the file log. yt-dlp's `-v` mode echoes the whole argv (the
        // `[debug] Command-line config: [...]` line), so besides the cookies path this line can
        // carry the full pasted URL with its playlist/tracking parameters. Redact both, matching the
        // success path's terminal_logs redaction. The `--` separator means the URL is always the
        // last argument.
        let url = args.last().map(String::as_str).unwrap_or_default();
        let detail = redact_sensitive_from_line(
            &detail,
            cookies_path_from_args(args),
            cookies_browser_from_args(args),
            url,
        );

        return Err(AppError::from_code_with_details(
            failed_code,
            failed_message,
            format!("{failed_message}: {detail}"),
        ));
    }

    if json_payload.trim().is_empty() {
        return Err(AppError::from_code_with_details(
            AppErrorCode::YtDlpMetadataParseFailed,
            "yt-dlp returned invalid media information for this URL.",
            "yt-dlp metadata parse failed: JSON payload not found".to_string(),
        ));
    }

    Ok((json_payload, stdout_logs, stderr_logs))
}

/// Optionally registers a cancellable run so `cancel_media_download(run_id)` can abort a standalone
/// metadata/format/comment fetch, mirroring the download flow. Returns the cancel flag to hand to
/// `run_yt_dlp_and_capture_json` and a release guard that unregisters the run when dropped. An
/// empty/absent run_id means the caller opted out of cancellation, so the flag is `None` and the
/// fetch runs uninterruptibly to completion or timeout as before.
pub(in crate::services::yt_dlp) fn optional_cancellable_run(
    run_id: Option<&str>,
) -> AppResult<(Option<Arc<AtomicBool>>, Option<DownloadRunReleaseGuard>)> {
    match run_id.map(str::trim).filter(|value| !value.is_empty()) {
        Some(run_id) => {
            // The same rule a download's id meets, so a value of any length or shape never becomes
            // a registry key.
            if !crate::services::yt_dlp::download::is_valid_run_id(run_id) {
                return Err(AppError::from_code(
                    AppErrorCode::InvalidRunId,
                    "run_id has an invalid format",
                ));
            }

            let flag = register_download_run(run_id)?;
            Ok((Some(flag), Some(DownloadRunReleaseGuard::new(run_id))))
        }
        None => Ok((None, None)),
    }
}
