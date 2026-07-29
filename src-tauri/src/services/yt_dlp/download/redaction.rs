//! Redacting the yt-dlp argument vector before it is shown to the user.
//!
//! The `yt-dlp args: ...` line is streamed to the in-app terminal and is one of the first things a
//! user copies into a public bug report, so the values that carry an absolute local path are
//! dropped before it is built: the cookies file location, the ffmpeg directory (which falls back to
//! `<app_data_dir>/tools`, i.e. `C:\Users\<name>\AppData\...`), the `--paths` temp directory under
//! the app cache, and the pasted URL with whatever playlist/tracking parameters came with it.
//!
//! Kept apart from the async orchestration in the parent module so this - the part with a privacy
//! consequence and no I/O at all - can be mutation-tested. Tests live in the parent's `mod tests`.

use crate::services::yt_dlp::url::youtube_ref_for_log;

/// How the value following a flag must be redacted when building the log line.
enum PendingRedaction {
    None,
    /// Replace the whole value (used for `--cookies`).
    FullValue,
    /// Keep the `home:`/`temp:` scope prefix but drop the directory (used for `--paths`).
    PathsValue,
    /// Reduce a YouTube URL to its video id, dropping playlist/tracking query params (used for
    /// the URL after the `--` separator). This line is shown in the UI terminal and may be pasted
    /// into a public bug report, so it gets the same reduction the file log already applies via
    /// `youtube_ref_for_log`.
    YoutubeUrl,
}

/// Redacts a `--paths` value, keeping its `SCOPE:` prefix but dropping the directory. The
/// directory sits under the per-user app cache (e.g. `C:\Users\<name>\AppData\...`), so it would
/// otherwise leak the OS username. `split_once(':')` splits on the scope separator even though a
/// Windows path also contains a drive colon, because the scope colon always comes first.
pub(super) fn redact_paths_value(value: &str) -> String {
    match value.split_once(':') {
        Some((scope, _)) => format!("{scope}:<redacted>"),
        None => "<redacted>".to_string(),
    }
}

/// Maps a flag whose following value is sensitive to how that value must be redacted. Centralized
/// so a path-carrying flag is a single edit here rather than a new branch in the loop below - the
/// shape of gap that previously let `--ffmpeg-location` leak the app-cache path (and with it the OS
/// username) into a line shown in the UI and pasted into public bug reports. Any flag whose value is
/// an absolute local path belongs here.
fn redaction_for_flag(flag: &str) -> PendingRedaction {
    match flag {
        // Both carry an absolute path under the per-user profile: the cookies file location, and
        // the ffmpeg binary's parent directory - which falls back to `<app_data_dir>/tools`, i.e.
        // exactly the `C:\Users\<name>\AppData\...` layout the `--paths` redaction exists to hide.
        "--cookies" | "--ffmpeg-location" => PendingRedaction::FullValue,
        "--paths" => PendingRedaction::PathsValue,
        // The URL is the only argument after the `--` separator (see build_download_command_args);
        // reduce it so the raw pasted URL, with any playlist/tracking params, never reaches the UI
        // terminal.
        "--" => PendingRedaction::YoutubeUrl,
        _ => PendingRedaction::None,
    }
}

/// Joins yt-dlp args for display, redacting values that can leak local filesystem paths. The
/// value after `--cookies` reveals the cookies file location, `--ffmpeg-location` carries the
/// ffmpeg directory (which can sit under the app cache), and each `--paths` value carries the
/// temp directory under the user's app cache; all would expose the username/profile layout in a
/// log line that is shown in the app and may be pasted into a public bug report.
/// `--cookies-from-browser` (a browser name, not a path) is left intact. Which flags are treated
/// as sensitive lives in `redaction_for_flag`, so this loop never has to be touched to cover a new one.
pub(super) fn redacted_args_for_log(args: &[String]) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(args.len());
    let mut pending = PendingRedaction::None;

    for arg in args {
        match pending {
            PendingRedaction::FullValue => {
                parts.push("<redacted>".to_string());
                pending = PendingRedaction::None;
                continue;
            }
            PendingRedaction::PathsValue => {
                parts.push(redact_paths_value(arg));
                pending = PendingRedaction::None;
                continue;
            }
            PendingRedaction::YoutubeUrl => {
                parts.push(youtube_ref_for_log(arg));
                pending = PendingRedaction::None;
                continue;
            }
            PendingRedaction::None => {}
        }

        pending = redaction_for_flag(arg);

        parts.push(arg.clone());
    }

    parts.join(" ")
}
