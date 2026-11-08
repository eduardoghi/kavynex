//! Taking the user's paths and cookie details out of a yt-dlp line before anything shows or logs it.

use super::*;

/// Redacts a cookies file path from a yt-dlp log line before it can surface to the frontend.
///
/// yt-dlp is run with `-v`, and its captured stdout/stderr reaches the frontend on two paths.
/// As the `terminal_logs` of `list_yt_dlp_formats_async` on success, and as the error
/// `details` built from `select_best_error_detail` on failure (which is also written to the
/// file log). yt-dlp's verbose mode prints a `[debug] Command-line config: [...]` line that
/// echoes the full argv verbatim, including the value passed to `--cookies`. That local
/// filesystem path can reveal the user's OS username/profile layout, and such a line may end
/// up pasted into a public bug report, so any occurrence of the path is replaced regardless of
/// which line it shows up in (the `Command-line config` echo, or any other yt-dlp message that
/// happens to mention it).
///
/// The match is not a bare substring compare. yt-dlp's argv echo prints the path verbatim, but
/// another message could print it with the separators swapped (yt-dlp normalizes to `/` internally
/// on Windows) or with a different ASCII casing (Windows paths are case-insensitive). Each of those
/// full-path forms is redacted. The bare filename is deliberately left alone. It is generic
/// ("cookies.txt"), appears in benign hint text, and does not reveal the user's profile layout. It
/// is the directory portion that does.
pub(crate) fn redact_cookies_path_from_line(line: &str, cookies_path: Option<&str>) -> String {
    match cookies_path {
        Some(path) => redact_path_from_line(line, path),
        None => line.to_string(),
    }
}

/// Replaces every spelling of the local `path` in `line` with `<redacted>`, verbatim and with
/// either separator convention, ignoring ASCII case. Not specific to cookies. A thumbnail's ffmpeg
/// error uses it for the user's input file.
pub(crate) fn redact_path_from_line(line: &str, path: &str) -> String {
    let path = path.trim();

    if path.is_empty() {
        return line.to_string();
    }

    // The plausible representations of the same full path. Verbatim, with either separator
    // convention, and with every backslash doubled. The doubled one is what yt-dlp actually prints
    // on Windows. Its `-v` argv echo and its "could not find ... in '<path>'" errors both write the
    // Python repr of the string, so a path never appears there with single backslashes, and the
    // other spellings matched nothing on the platform where paths carry the user's name. Case is
    // handled by the ASCII-insensitive matcher below.
    let variants = [
        path.replace('\\', "\\\\"),
        path.to_string(),
        path.replace('\\', "/"),
        path.replace('/', "\\"),
    ];

    let mut result = line.to_string();
    for variant in variants {
        result = replace_ascii_case_insensitive(&result, &variant, "<redacted>");
    }
    result
}

/// Sanitizes a yt-dlp `-v` log line before it reaches the frontend/file log. Redacts the cookies
/// file path (see [`redact_cookies_path_from_line`]), hides the profile and container of a
/// `--cookies-from-browser` selector (a profile is often a path under the user's home directory,
/// and the `[debug] Command-line config` echo prints the whole argv verbatim), and reduces the full
/// pasted URL to the same privacy-preserving reference the download flow logs
/// (`youtube_ref_for_log`), so playlist and tracking parameters do not survive into a log a user
/// might paste into a public issue.
pub(crate) fn redact_sensitive_from_line(
    line: &str,
    cookies_path: Option<&str>,
    cookies_browser: Option<&str>,
    url: &str,
) -> String {
    let redacted = redact_cookies_from_line(line, cookies_path, cookies_browser);

    let url = url.trim();

    if url.is_empty() {
        return redacted;
    }

    redacted.replace(url, &youtube_ref_for_log(url))
}

/// [`redact_sensitive_from_line`] for a run handed a copy of the cookies file. Both the user's path
/// and the copy's are hidden, since the argv echo names the copy and the copy sits under the user's
/// home folder too.
pub(crate) fn redact_probe_line(
    line: &str,
    cookies_paths: [Option<&str>; 2],
    cookies_browser: Option<&str>,
    url: &str,
) -> String {
    let [user_path, copy_path] = cookies_paths;
    let redacted = redact_sensitive_from_line(line, user_path, cookies_browser, url);

    redact_cookies_path_from_line(&redacted, copy_path)
}

/// Hides the cookies file path and the profile of a `--cookies-from-browser` selector, in every
/// spelling yt-dlp prints them. Shared by the metadata calls and the download, whose output reaches
/// the same terminal and log.
pub(crate) fn redact_cookies_from_line(
    line: &str,
    cookies_path: Option<&str>,
    cookies_browser: Option<&str>,
) -> String {
    let mut redacted =
        redact_cookie_database_path(&redact_cookies_path_from_line(line, cookies_path));

    let Some(selector) = cookies_browser
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return redacted;
    };

    let safe = redact_cookies_browser_selector(selector);

    // A bare browser name redacts to itself. Replacing it with itself would be a no-op, and a
    // selector with a profile is the only case where the argv echo carries something to hide. The
    // echo is a Python repr, so on Windows the selector appears there with its backslashes doubled.
    if safe != selector {
        redacted = redacted.replace(&selector.replace('\\', "\\\\"), &safe);
        redacted = redacted.replace(selector, &safe);
    }

    // The profile also turns up on its own, as the directory an error says it searched ("could not
    // find firefox cookies database in '<profile>'"), where no selector surrounds it to match. Only
    // a profile written as a path is hidden there. A bare profile name is a word, and replacing every
    // occurrence of a word like "default" would garble the line for nothing.
    if let Some(profile) =
        crate::services::yt_dlp::cookies::parse_cookies_browser_selector(selector)
            .and_then(|parsed| parsed.profile().map(str::to_owned))
            .filter(|profile| profile.contains(['/', '\\']))
    {
        redacted = redact_path_from_line(&redacted, &profile);
    }

    redacted
}

/// What yt-dlp prints before the path of the browser's cookie database it found by itself. With a
/// bare `--cookies-from-browser chrome` no profile was given, so nothing the app passed can be
/// matched, and the path it found sits under the user's home directory.
pub(super) const COOKIE_DATABASE_PREFIX: &str = "Extracting cookies from: \"";

/// Hides the quoted path after [`COOKIE_DATABASE_PREFIX`], keeping the rest of the line.
pub(super) fn redact_cookie_database_path(line: &str) -> String {
    let Some(start) = line.find(COOKIE_DATABASE_PREFIX) else {
        return line.to_string();
    };

    let path_start = start + COOKIE_DATABASE_PREFIX.len();
    let Some(path_len) = line[path_start..].find('"') else {
        return format!("{}<redacted>", &line[..path_start]);
    };

    format!(
        "{}<redacted>{}",
        &line[..path_start],
        &line[path_start + path_len..]
    )
}

/// Replaces every ASCII-case-insensitive occurrence of `needle` in `haystack`. Uses
/// `to_ascii_lowercase`, which only folds ASCII `A-Z` and so is byte-length preserving. An offset
/// found in the lowercased copy indexes the original correctly even when the path carries non-ASCII
/// bytes (a Unicode username), so this never slices a UTF-8 char boundary.
pub(super) fn replace_ascii_case_insensitive(
    haystack: &str,
    needle: &str,
    replacement: &str,
) -> String {
    if needle.is_empty() {
        return haystack.to_string();
    }

    let haystack_lower = haystack.to_ascii_lowercase();
    let needle_lower = needle.to_ascii_lowercase();

    let mut result = String::with_capacity(haystack.len());
    let mut cursor = 0;
    while let Some(offset) = haystack_lower[cursor..].find(&needle_lower) {
        let start = cursor + offset;
        result.push_str(&haystack[cursor..start]);
        result.push_str(replacement);
        cursor = start + needle.len();
    }
    result.push_str(&haystack[cursor..]);
    result
}

/// Extracts the value passed to `--cookies` in an argv, so a failure `detail` built from
/// yt-dlp's verbose output can have that local path redacted even though the caller only hands
/// this function the fully-built args. `--cookies-from-browser` is not returned. It carries a
/// browser name, not a filesystem path.
pub(super) fn cookies_path_from_args(args: &[String]) -> Option<&str> {
    args.iter()
        .position(|arg| arg == "--cookies")
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

/// Extracts the value passed to `--cookies-from-browser` in an argv, for the same reason as
/// [`cookies_path_from_args`]. A profile in it can be a path under the user's home directory, and
/// yt-dlp's verbose echo prints it back.
pub(super) fn cookies_browser_from_args(args: &[String]) -> Option<&str> {
    args.iter()
        .position(|arg| arg == "--cookies-from-browser")
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}
