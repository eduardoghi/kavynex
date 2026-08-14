//! Pure planning for a yt-dlp download run, kept out of the async orchestration in the parent
//! module so it can be unit-tested without spawning a process: validating/normalizing the
//! request from the frontend, building the yt-dlp argument vector (with the `--` separator that
//! keeps the URL from ever being read as a flag), and classifying the run's terminal outcome
//! from the flags the wait loop set. Tests live in the parent's `mod tests`.

use std::path::Path;

use crate::services::yt_dlp::cookies::append_auth_args;
use crate::services::yt_dlp::url::is_allowed_youtube_url;
use crate::{AppError, AppErrorCode, AppResult};

/// Upper bound on the frontend-supplied `run_id`. The legitimate value is a `crypto.randomUUID()`
/// (36 chars); this cap leaves generous room while stopping a compromised frontend from driving an
/// arbitrarily long value into the download temp-directory name (`{run_id}-{suffix}`), where it
/// could otherwise blow past filesystem path-length limits. The backend is the trust boundary, so
/// it validates rather than assuming the run id is well-formed.
pub(super) const MAX_RUN_ID_LEN: usize = 128;

/// True for a well-formed run id: non-empty, within [`MAX_RUN_ID_LEN`], and made only of the
/// characters a UUID (or a hex/dash fallback) uses. It becomes part of a temp-directory name, so
/// restricting it to `[A-Za-z0-9._-]` also keeps a path separator or other filesystem-significant
/// character out of that name regardless of what the frontend sends.
///
/// `pub(crate)` (re-exported by `yt_dlp::download`) because a local import registers a run id too,
/// so `cancel_media_download` can reach it. That id never becomes a path (it is only a key in the
/// process registry), so this rule is stricter than that caller strictly needs. Reusing it anyway is
/// the point: one definition of what a run id may be beats a second, looser spelling that would
/// then have to be kept in step with this one.
pub(crate) fn is_valid_run_id(run_id: &str) -> bool {
    !run_id.is_empty()
        && run_id.len() <= MAX_RUN_ID_LEN
        && run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Accepts only format ids built from the characters yt-dlp uses for concrete format ids
/// (ASCII alphanumerics plus `.`, `_`, `-`), optionally `+`-combined for a video+audio
/// selection such as `137+140`. Every part must be non-empty and must not start with `-`, so
/// the value placed after `-f` can never be parsed as a yt-dlp flag. This is defense in depth
/// on top of `resolve_format_has_video`, which additionally requires the id to match a real
/// format from the fetched metadata: since that metadata is attacker-influenced (it comes from
/// the video being downloaded), the id is filtered by character class before it is trusted.
pub(super) fn is_valid_format_id(format_id: &str) -> bool {
    format_id.split('+').all(|part| {
        !part.is_empty()
            && !part.starts_with('-')
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    })
}

#[derive(Debug)]
pub(super) struct ValidatedDownloadInputs {
    pub(super) url: String,
    pub(super) run_id: String,
    pub(super) format_id: String,
}

/// Validates and normalizes the download request coming from the frontend. Rejects empty
/// values and any URL that is not http(s). Cookies are handled separately since they
/// never produce an error (invalid values are simply ignored).
pub(super) fn validate_download_inputs(
    url: &str,
    library_path: &str,
    run_id: &str,
    format_id: &str,
) -> AppResult<ValidatedDownloadInputs> {
    let url = url.trim().to_string();
    let run_id = run_id.trim().to_string();
    let format_id = format_id.trim().to_string();

    if url.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidUrl,
            "url is empty",
        ));
    }

    if !is_allowed_youtube_url(&url) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidUrl,
            "url must be an http(s) YouTube URL",
        ));
    }

    if library_path.trim().is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryPath,
            "library path is empty",
        ));
    }

    if run_id.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidRunId,
            "run_id is empty",
        ));
    }

    if !is_valid_run_id(&run_id) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidRunId,
            "run_id is too long or contains unexpected characters",
        ));
    }

    if format_id.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidFormatId,
            "format_id is empty",
        ));
    }

    if !is_valid_format_id(&format_id) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidFormatId,
            "format_id contains unexpected characters",
        ));
    }

    Ok(ValidatedDownloadInputs {
        url,
        run_id,
        format_id,
    })
}

/// Builds the yt-dlp argument vector for a media download.
///
/// Extracted as a pure function so the argv (the format selector after `-f`, the `--paths`
/// sandboxing that confines yt-dlp's writes to the run's temp directory, and the `--`
/// separator that keeps the URL from ever being reinterpreted as a flag) can be asserted in
/// tests without spawning a process. The URL is always last and always preceded by `--`.
#[allow(clippy::too_many_arguments)]
pub(super) fn build_download_command_args(
    ffmpeg_location: &str,
    format_id: &str,
    download_live_chat: bool,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
    temp_dir: &Path,
    file_prefix: &str,
    url: &str,
) -> Vec<String> {
    let mut args = vec![
        "--ignore-config".to_string(),
        "--no-playlist".to_string(),
        "--restrict-filenames".to_string(),
        "--windows-filenames".to_string(),
        "--no-part".to_string(),
        "--newline".to_string(),
        "--progress".to_string(),
        "--no-warnings".to_string(),
        "--ffmpeg-location".to_string(),
        ffmpeg_location.to_string(),
        "-f".to_string(),
        format_id.to_string(),
    ];

    if download_live_chat {
        args.push("--write-subs".to_string());
        args.push("--sub-langs".to_string());
        args.push("live_chat".to_string());
    }

    append_auth_args(&mut args, cookies_browser, cookies_path);

    args.extend_from_slice(&[
        "--paths".to_string(),
        format!("home:{}", temp_dir.to_string_lossy()),
        "--paths".to_string(),
        format!("temp:{}", temp_dir.to_string_lossy()),
        "-o".to_string(),
        format!("{}.%(ext)s", file_prefix),
        // Separator so a URL can never be interpreted as a flag (defense in depth on
        // top of the http(s) scheme check).
        "--".to_string(),
        url.to_string(),
    ]);

    args
}

/// The terminal outcome of the yt-dlp wait loop, decided from the flags the loop set and the
/// child's exit status.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum DownloadTermination {
    /// The child went silent past the stall threshold with no file growth and was killed.
    Stalled,
    /// The user (or app exit) cancelled the run.
    Cancelled,
    /// The child exited non-zero; carries the user-facing message built from its stderr.
    Failed(String),
    /// The child exited zero and was neither stalled nor cancelled.
    Succeeded,
}

/// Decides the wait loop's terminal outcome. Extracted as a pure function so the precedence a
/// stall preempts a cancel, which preempts a non-zero exit and the failure-message shaping can be
/// asserted without spawning a process; the surrounding orchestration (`download_media_from_url_async`)
/// needs a live `AppHandle` to emit events and cannot run under the unit-test harness.
///
/// The precedence matters: a run killed for stalling also comes back with a non-success exit
/// status and a cancel flag set once the kill lands, so classifying purely on the exit status
/// would report every stall/cancel as a generic failure. `captured_stderr` is consulted only for
/// the `Failed` case and is expected to already carry the empty-buffer fallback the caller applies.
pub(super) fn classify_download_termination(
    stalled: bool,
    cancel_requested: bool,
    exit_success: bool,
    captured_stderr: &str,
) -> DownloadTermination {
    if stalled {
        return DownloadTermination::Stalled;
    }

    if cancel_requested {
        return DownloadTermination::Cancelled;
    }

    if !exit_success {
        let trimmed = captured_stderr.trim();

        let message = if trimmed.is_empty() {
            "yt-dlp download failed".to_string()
        } else {
            format!("yt-dlp download failed: {trimmed}")
        };

        return DownloadTermination::Failed(message);
    }

    DownloadTermination::Succeeded
}
