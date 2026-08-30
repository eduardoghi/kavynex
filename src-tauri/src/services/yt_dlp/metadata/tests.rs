// The tests for the parent module, kept in a file of their own so the module reads as its
// production code. Same module as before (`mod tests` declared under `#[cfg(test)]` in the
// parent), so `use super::*` still reaches every private item it did.

use super::{
    comments_extraction_looks_incomplete, cookies_browser_from_args, cookies_path_from_args,
    is_valid_youtube_video_id, read_capped_json_stdout, redact_cookies_path_from_line,
    redact_sensitive_from_line, resolve_youtube_video_id, run_yt_dlp_and_capture_json,
    sanitize_filename_component, sanitize_identifier_component,
};
use crate::AppErrorCode;

#[test]
fn sanitize_identifier_component_keeps_unaltered_ids_unchanged() {
    // A normal YouTube id survives sanitization untouched, so its filename stays byte-for-byte
    // what earlier versions produced (no churn for already-downloaded media).
    for id in ["dQw4w9WgXcQ", "abc-123_XYZ", "a.b_c"] {
        assert_eq!(sanitize_identifier_component(id), id);
        assert_eq!(
            sanitize_identifier_component(id),
            sanitize_filename_component(id)
        );
    }
}

#[test]
fn sanitize_filename_component_prefixes_windows_reserved_names() {
    // A component that sanitizes to a reserved device name is prefixed with '_' so the joined
    // filename is usable on Windows, with or without an extension.
    assert_eq!(sanitize_filename_component("CON"), "_CON");
    assert_eq!(sanitize_filename_component("nul"), "_nul");
    assert_eq!(sanitize_filename_component("com1"), "_com1");
    assert_eq!(sanitize_filename_component("LPT9.txt"), "_LPT9.txt");

    // A component that merely contains a reserved substring is a real name, left untouched.
    assert_eq!(sanitize_filename_component("console"), "console");
    assert_eq!(sanitize_filename_component("com10"), "com10");
}

#[test]
fn sanitize_filename_component_maps_dot_only_values_to_a_neutral_name() {
    // A value that sanitizes to only dots ('.', '..', '...') is path-significant as a bare
    // segment; it must never survive as itself, so a future `join` of the result can never
    // walk the directory tree. Mapped to the same placeholder as the empty case.
    for value in [".", "..", "...", " .. ", "..\\"] {
        assert_eq!(
            sanitize_filename_component(value),
            "media",
            "{value:?} should sanitize to the neutral placeholder"
        );
    }

    // A dot that is part of a real name (an extension) is untouched.
    assert_eq!(sanitize_filename_component("clip.mp4"), "clip.mp4");
}

#[test]
fn sanitize_identifier_component_disambiguates_ids_that_share_a_sanitized_form() {
    // `a__b` and `a_b` both sanitize to `a_b`; the colliding one must get a distinct suffix so
    // one download can never silently overwrite the other, while the canonical `a_b` is kept.
    let canonical = sanitize_identifier_component("a_b");
    let collider = sanitize_identifier_component("a__b");
    let other_collider = sanitize_identifier_component("a:b");

    assert_eq!(canonical, "a_b");
    assert_ne!(collider, canonical);
    assert_ne!(other_collider, canonical);
    assert_ne!(collider, other_collider);
    // The disambiguated names still start with the sanitized form.
    assert!(collider.starts_with("a_b_"));
    assert!(other_collider.starts_with("a_b_"));
}

// Spawns a real child process (`sleep`/`ping`) and exercises the kill/timeout path.
#[tokio::test]
async fn run_and_capture_kills_the_child_and_reports_timeout_when_it_expires() {
    // A slow command that would outlive the 1s timeout by far; the call must come
    // back with the timeout error instead of waiting for it (the child is killed).
    let (binary, args): (&str, Vec<String>) = if cfg!(windows) {
        (
            "ping",
            vec!["-n".to_string(), "30".to_string(), "127.0.0.1".to_string()],
        )
    } else {
        ("sleep", vec!["30".to_string()])
    };

    let error = run_yt_dlp_and_capture_json(
        binary,
        &args,
        1,
        AppErrorCode::YtDlpMetadataTimeout,
        AppErrorCode::YtDlpMetadataExecFailed,
        AppErrorCode::YtDlpMetadataFailed,
        "timed out",
        "exec failed",
        "failed",
        None,
    )
    .await
    .unwrap_err();

    assert_eq!(error.code, AppErrorCode::YtDlpMetadataTimeout.as_str());
}

// Spawns a real child process and exercises the kill/cancel path.
#[tokio::test]
async fn run_and_capture_kills_the_child_and_reports_cancellation_when_flagged() {
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    let (binary, args) = if cfg!(windows) {
        (
            "cmd",
            vec!["/C".to_string(), "ping -n 30 127.0.0.1 > NUL".to_string()],
        )
    } else {
        ("sleep", vec!["30".to_string()])
    };

    // Flag already set. The cancel branch wins immediately and the long-running child is
    // killed instead of the call blocking for the full timeout.
    let cancel = Arc::new(AtomicBool::new(true));

    let error = run_yt_dlp_and_capture_json(
        binary,
        &args,
        30,
        AppErrorCode::YtDlpMetadataTimeout,
        AppErrorCode::YtDlpMetadataExecFailed,
        AppErrorCode::YtDlpMetadataFailed,
        "timed out",
        "exec failed",
        "failed",
        Some(Arc::clone(&cancel)),
    )
    .await
    .unwrap_err();

    assert_eq!(error.code, AppErrorCode::YtDlpDownloadCancelled.as_str());
}

#[tokio::test]
async fn read_capped_json_stdout_flags_overflow() {
    // A single JSON line larger than the cap is flagged as overflowed.
    let big = format!("{{\"x\":\"{}\"}}", "a".repeat(200));
    let (_json, _logs, overflowed) = read_capped_json_stdout(big.as_bytes(), 32).await;
    assert!(overflowed);
}

#[tokio::test]
async fn read_capped_json_stdout_reads_normal_output() {
    let input = "{\"id\":\"abc\"}\nsome log line\n";
    let (json, logs, overflowed) = read_capped_json_stdout(input.as_bytes(), 4096).await;

    assert!(!overflowed);
    assert_eq!(json, "{\"id\":\"abc\"}");
    assert_eq!(logs, vec!["some log line".to_string()]);
}

#[test]
fn accepts_standard_id() {
    assert!(is_valid_youtube_video_id("dQw4w9WgXcQ"));
}

#[test]
fn accepts_id_with_dash_and_underscore() {
    assert!(is_valid_youtube_video_id("a-b_cDeFgHi"));
}

#[test]
fn rejects_empty() {
    assert!(!is_valid_youtube_video_id(""));
}

#[test]
fn rejects_10_chars() {
    assert!(!is_valid_youtube_video_id("dQw4w9WgXc"));
}

#[test]
fn rejects_12_chars() {
    assert!(!is_valid_youtube_video_id("dQw4w9WgXcQQ"));
}

#[test]
fn rejects_id_with_query_param() {
    assert!(!is_valid_youtube_video_id("dQw4w9W&list"));
}

#[test]
fn rejects_id_with_fragment() {
    assert!(!is_valid_youtube_video_id("dQw4w9WgX#Q"));
}

#[test]
fn rejects_unicode() {
    assert!(!is_valid_youtube_video_id("dQw4w9WgXcé"));
}

#[test]
fn redact_cookies_path_strips_path_from_command_line_config_echo() {
    // This mirrors the line yt-dlp's `-v` flag prints, which echoes the full argv
    // (including `--cookies <path>`) verbatim.
    let line = "[debug] Command-line config: ['-v', '--cookies', '/home/user/.config/cookies.txt', '--', 'https://youtube.com/watch?v=x']";

    let redacted = redact_cookies_path_from_line(line, Some("/home/user/.config/cookies.txt"));

    assert!(!redacted.contains("/home/user/.config/cookies.txt"));
    assert!(redacted.contains("<redacted>"));
}

#[test]
fn redact_cookies_path_leaves_unrelated_lines_untouched() {
    let line = "[youtube] Extracting URL: https://youtube.com/watch?v=x";

    assert_eq!(
        redact_cookies_path_from_line(line, Some("/home/user/.config/cookies.txt")),
        line
    );
}

#[test]
fn redact_cookies_path_is_a_noop_when_no_cookies_path_was_used() {
    let line = "[debug] Command-line config: ['-v', '--cookies-from-browser', 'firefox']";

    assert_eq!(redact_cookies_path_from_line(line, None), line);
}

#[test]
fn redact_cookies_path_catches_separator_and_case_variants() {
    // yt-dlp could print the same Windows path with forward slashes (its internal form) or a
    // different casing; the full path must be redacted in every such form, not only verbatim.
    let configured = r"C:\Users\Alice\AppData\cookies.txt";

    let forward_slashes = "[debug] loading cookies from C:/Users/Alice/AppData/cookies.txt";
    let redacted = redact_cookies_path_from_line(forward_slashes, Some(configured));
    assert!(!redacted.contains("Alice"));
    assert!(redacted.contains("<redacted>"));

    let lowercased = r"[debug] loading cookies from c:\users\alice\appdata\cookies.txt";
    let redacted = redact_cookies_path_from_line(lowercased, Some(configured));
    assert!(!redacted.contains("alice"));
    assert!(redacted.contains("<redacted>"));
}

#[test]
fn redact_cookies_path_leaves_the_generic_filename_alone() {
    // The bare filename is generic and shows up in benign hint text; only the full path leaks
    // the profile layout, so a line mentioning just "cookies.txt" must survive untouched.
    let line = "provide a cookies.txt file from a verified account";

    assert_eq!(
        redact_cookies_path_from_line(line, Some(r"C:\Users\Alice\cookies.txt")),
        line
    );
}

#[test]
fn redact_sensitive_reduces_the_full_url_to_a_video_reference() {
    // yt-dlp's -v echo prints the whole argv, including the pasted URL with its playlist and
    // tracking parameters. The sanitized line must keep only the video reference and still
    // redact the cookies path, matching the download flow's redaction.
    let line = "[debug] Command-line config: ['--cookies', 'C:\\Users\\Alice\\cookies.txt', '--', 'https://www.youtube.com/watch?v=abc123&list=PLxyz&t=42s']";

    let redacted = redact_sensitive_from_line(
        line,
        Some(r"C:\Users\Alice\cookies.txt"),
        None,
        "https://www.youtube.com/watch?v=abc123&list=PLxyz&t=42s",
    );

    assert!(
        redacted.contains("www.youtube.com?v=abc123"),
        "url should be reduced to its video reference: {redacted}"
    );
    assert!(
        !redacted.contains("list=PLxyz"),
        "playlist/tracking params must not survive: {redacted}"
    );
    assert!(
        !redacted.contains(r"C:\Users\Alice\cookies.txt"),
        "cookies path must still be redacted: {redacted}"
    );
}

#[test]
fn redact_sensitive_hides_a_browser_profile_in_the_argv_echo() {
    // `-v` echoes the argv, so a profile path given through `--cookies-from-browser` lands in
    // the terminal_logs and in a failure detail exactly like the cookies file path does. The
    // browser name stays (it names a tool, not the user); the profile goes.
    let line = "[debug] Command-line config: ['--cookies-from-browser', 'firefox:/home/alice/.mozilla/firefox/abc.default', '--', 'https://youtu.be/abc']";

    let redacted = redact_sensitive_from_line(
        line,
        None,
        Some("firefox:/home/alice/.mozilla/firefox/abc.default"),
        "https://youtu.be/abc",
    );

    assert!(
        !redacted.contains("alice"),
        "the profile path must not survive: {redacted}"
    );
    assert!(
        redacted.contains("'firefox:<redacted>'"),
        "the browser name stays and the profile is marked redacted: {redacted}"
    );

    // A bare browser is left exactly as it was, so a line that only names the tool is
    // untouched rather than rewritten with a placeholder.
    let bare = "[debug] Command-line config: ['--cookies-from-browser', 'firefox']";
    assert_eq!(
        redact_sensitive_from_line(bare, None, Some("firefox"), ""),
        bare
    );
}

#[test]
fn cookies_browser_from_args_finds_the_value_after_the_flag() {
    let args = vec![
        "--cookies-from-browser".to_string(),
        "firefox:Work".to_string(),
        "--".to_string(),
        "https://youtu.be/x".to_string(),
    ];
    assert_eq!(cookies_browser_from_args(&args), Some("firefox:Work"));

    let none = vec!["--cookies".to_string(), "c.txt".to_string()];
    assert_eq!(cookies_browser_from_args(&none), None);
}

#[test]
fn cookies_path_from_args_finds_the_value_after_the_flag() {
    let args = vec![
        "-v".to_string(),
        "--cookies".to_string(),
        "/home/user/.config/cookies.txt".to_string(),
        "--".to_string(),
        "https://youtube.com/watch?v=x".to_string(),
    ];

    assert_eq!(
        cookies_path_from_args(&args),
        Some("/home/user/.config/cookies.txt")
    );
}

#[test]
fn cookies_path_from_args_is_none_without_the_flag_or_a_trailing_value() {
    // `--cookies-from-browser` carries a browser name, not a path, and must not match.
    let browser = vec!["--cookies-from-browser".to_string(), "firefox".to_string()];
    assert_eq!(cookies_path_from_args(&browser), None);

    // A dangling `--cookies` with no following value yields None rather than panicking.
    let dangling = vec!["-v".to_string(), "--cookies".to_string()];
    assert_eq!(cookies_path_from_args(&dangling), None);
}

#[test]
fn resolve_youtube_video_id_accepts_a_youtube_extractor() {
    assert_eq!(
        resolve_youtube_video_id(Some("abc123"), Some("Youtube")),
        Some("abc123".to_string())
    );
    assert_eq!(
        resolve_youtube_video_id(Some("abc123"), Some("youtube:tab")),
        Some("abc123".to_string())
    );
}

#[test]
fn resolve_youtube_video_id_rejects_a_non_youtube_extractor() {
    assert_eq!(
        resolve_youtube_video_id(Some("abc123"), Some("vimeo")),
        None
    );
    assert_eq!(resolve_youtube_video_id(Some("abc123"), None), None);
}

#[test]
fn resolve_youtube_video_id_rejects_a_missing_or_blank_id() {
    assert_eq!(resolve_youtube_video_id(None, Some("youtube")), None);
    assert_eq!(resolve_youtube_video_id(Some("   "), Some("youtube")), None);
}

/// Real `yt-dlp -J` output, trimmed to what this app reads. See the fixture's own `_comment`
/// for how it was captured and what was edited.
const REAL_METADATA_FIXTURE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/yt-dlp-metadata-youtube.json"
));

fn parse_real_metadata() -> crate::models::yt_dlp::YtDlpMetadata {
    serde_json::from_str(REAL_METADATA_FIXTURE)
        .expect("the captured yt-dlp output must still deserialize into YtDlpMetadata")
}

// The four tests below are this repository's only check against something it does not control.
// Everything else compares the app to itself, so a field yt-dlp renames or retypes passes cargo
// test, clippy, the coverage floor and both release self-checks, and arrives on a user's machine
// as a download that fails with nothing local to explain it. These pin the contract as it was
// observed; `live_yt_dlp_output_still_matches_the_committed_fixture` is what notices it moving.

#[test]
fn real_yt_dlp_metadata_deserializes_with_every_field_the_app_reads() {
    let metadata = parse_real_metadata();

    // Named individually rather than asserted as a whole, because the failure this catches is
    // one field going quiet. Serde maps an absent or renamed key to None on every one of these,
    // so a blanket "it parsed" assertion would pass while the value the app depends on vanished.
    assert_eq!(metadata.id.as_deref(), Some("jNQXAC9IVRw"));
    assert_eq!(metadata.title.as_deref(), Some("Me at the zoo"));
    assert_eq!(metadata.extractor.as_deref(), Some("youtube"));
    assert_eq!(metadata.upload_date.as_deref(), Some("20050424"));
    assert_eq!(metadata.live_status.as_deref(), Some("not_live"));
    assert_eq!(metadata.was_live, Some(false));
    assert_eq!(metadata.comment_count, Some(10_000_000));
    assert!(metadata
        .thumbnail
        .as_deref()
        .is_some_and(|url| url.starts_with("https://i.ytimg.com/")));
    assert_eq!(metadata.formats.len(), 3);
}

#[test]
fn real_yt_dlp_metadata_normalizes_to_what_a_creation_stores() {
    // The other half. Not just that the fields parse, but that the values the row is built from
    // come out right. `upload_date` is the one that transforms (yt-dlp's compact YYYYMMDD into
    // the ISO date the schema holds), and `youtube_video_id` is derived from the extractor
    // rather than read, so both are asserted against real input rather than a crafted string.
    let metadata = parse_real_metadata();
    let (id, extractor, suggested_title, youtube_video_id, published_at) =
        super::normalize_download_metadata(&metadata).expect("real metadata must normalize");

    assert_eq!(id, "jNQXAC9IVRw");
    assert_eq!(extractor, "youtube");
    assert_eq!(suggested_title, "Me at the zoo");
    assert_eq!(youtube_video_id.as_deref(), Some("jNQXAC9IVRw"));
    assert_eq!(published_at.as_deref(), Some("2005-04-24"));

    // The filename the download lands under is built from the first three (see
    // `place_downloaded_file`), so this is also what pins that a real video keeps producing the
    // documented `youtube_<id>_<format>.<ext>` shape.
    assert_eq!(
        format!(
            "{}_{}_{}",
            sanitize_filename_component(&extractor),
            sanitize_identifier_component(&id),
            sanitize_filename_component("137")
        ),
        "youtube_jNQXAC9IVRw_137"
    );
}

#[test]
fn real_yt_dlp_formats_carry_what_the_format_picker_branches_on() {
    use crate::utils::format::codec_is_present;

    let metadata = parse_real_metadata();
    let by_id = |id: &str| {
        metadata
            .formats
            .iter()
            .find(|format| format.format_id.as_deref() == Some(id))
            .unwrap_or_else(|| panic!("format {id} must be in the fixture"))
    };

    // `resolve_format_has_video` decides video-vs-audio from these two, and the literal it
    // compares against is the string "none" that yt-dlp emits. If that ever became null, an
    // empty string, or an omitted key, every audio-only download would be filed as video.
    let muxed = by_id("18");
    assert!(codec_is_present(&muxed.vcodec));
    assert!(codec_is_present(&muxed.acodec));

    let video_only = by_id("160");
    assert_eq!(video_only.acodec.as_deref(), Some("none"));
    assert!(codec_is_present(&video_only.vcodec));
    assert!(!codec_is_present(&video_only.acodec));

    let audio_only = by_id("139");
    assert_eq!(audio_only.vcodec.as_deref(), Some("none"));
    assert!(!codec_is_present(&audio_only.vcodec));
    assert!(codec_is_present(&audio_only.acodec));

    // A real muxed format reports no exact `filesize` and only an approximation, which is why
    // the model carries both and the UI falls back. Captured rather than assumed.
    assert_eq!(muxed.filesize, None);
    assert!(muxed.filesize_approx.is_some());
    assert_eq!(muxed.ext.as_deref(), Some("mp4"));
    assert_eq!(audio_only.ext.as_deref(), Some("m4a"));
}

#[test]
fn real_yt_dlp_output_omits_comments_and_the_model_tolerates_it() {
    // `-J` carries no `comments` key at all (they need `--write-comments`), so
    // `YtDlpMetadata::comments` rests entirely on its `#[serde(default)]`. Dropping that
    // attribute would make every metadata probe fail to parse, which no other test would catch
    // because every crafted fixture in this file supplies the field.
    assert!(
        !REAL_METADATA_FIXTURE.contains("\"comments\""),
        "the captured output must not carry a comments key, or this asserts nothing"
    );

    let metadata = parse_real_metadata();
    assert!(metadata.comments.is_empty());
}

/// Re-fetches the metadata the committed fixture was captured from and holds the live answer to
/// the same contract.
///
/// Ignored by default because it needs the network and a real `yt-dlp` on PATH, neither of
/// which a unit-test run may assume. Not because it spawns a process. The yt-dlp
/// process-kill/timeout/cancel tests in this file used to be `#[ignore]`d for that reason and no
/// longer are, since the hang was specific to the ubuntu-22.04 runner (see the note beside
/// `release.yml`'s "Run Rust tests" step). Run it deliberately:
///
/// ```text
/// cargo test --manifest-path src-tauri/Cargo.toml -- --ignored live_yt_dlp_output
/// ```
///
/// A failure here is not a bug in this code. It means yt-dlp's output moved and the fixture, and
/// probably `models/yt_dlp.rs` with it, needs updating. Skips rather than fails when yt-dlp is
/// absent or the network is unavailable, so "cannot answer" never reads as "the contract broke".
#[test]
#[ignore = "needs the network and a real yt-dlp; run deliberately, see the doc comment"]
fn live_yt_dlp_output_still_matches_the_committed_fixture() {
    let output = match std::process::Command::new("yt-dlp")
        .args([
            "--ignore-config",
            "-J",
            "--no-warnings",
            "--",
            "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        ])
        .output()
    {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            eprintln!(
                "skipping: yt-dlp exited {:?}: {}",
                output.status.code(),
                String::from_utf8_lossy(&output.stderr).trim()
            );
            return;
        }
        Err(error) => {
            eprintln!("skipping: yt-dlp could not be run: {error}");
            return;
        }
    };

    let live: crate::models::yt_dlp::YtDlpMetadata = serde_json::from_slice(&output.stdout)
        .expect("live yt-dlp output must still deserialize into YtDlpMetadata");
    let fixture = parse_real_metadata();

    // The stable identity fields, which are facts about the video rather than about yt-dlp.
    assert_eq!(live.id, fixture.id);
    assert_eq!(live.title, fixture.title);
    assert_eq!(live.extractor, fixture.extractor);
    assert_eq!(live.upload_date, fixture.upload_date);
    assert_eq!(live.live_status, fixture.live_status);
    assert_eq!(live.was_live, fixture.was_live);

    // The shape assertions, which are the ones that catch an upstream move. Deliberately not
    // compared field-for-field against the fixture. Format lists and comment totals change on
    // their own, so equality there would cry wolf. What must hold is that the values are still
    // there and still typed the way the app reads them.
    assert!(live.comment_count.is_some());
    assert!(live
        .thumbnail
        .as_deref()
        .is_some_and(|url| url.starts_with("https://")));
    assert!(!live.formats.is_empty());
    assert!(live.comments.is_empty(), "-J must still omit comments");

    assert!(live
        .formats
        .iter()
        .any(|format| format.vcodec.as_deref() == Some("none")));
    assert!(live
        .formats
        .iter()
        .any(|format| format.acodec.as_deref() == Some("none")));

    assert_eq!(
        super::normalize_download_metadata(&live).expect("live metadata must normalize"),
        super::normalize_download_metadata(&fixture).expect("fixture must normalize"),
    );
}

#[test]
fn empty_comments_are_incomplete_only_when_a_positive_count_is_reported() {
    // Video reports comments but none came back -> extraction is incomplete (a failure).
    assert!(comments_extraction_looks_incomplete(Some(42), 0));

    // Genuinely zero, or comments disabled (None). Not incomplete.
    assert!(!comments_extraction_looks_incomplete(Some(0), 0));
    assert!(!comments_extraction_looks_incomplete(None, 0));

    // Any comments were retrieved. Never incomplete, regardless of the reported total.
    assert!(!comments_extraction_looks_incomplete(Some(42), 10));
    assert!(!comments_extraction_looks_incomplete(None, 5));
}
