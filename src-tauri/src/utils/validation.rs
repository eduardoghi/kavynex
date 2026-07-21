//! Backend validation of the text fields the frontend sends over IPC (channel name/handle,
//! media title/type).
//!
//! The frontend already validates these for fast UX feedback (`src/services/
//! channel-input-service.ts`, `src/services/media-input-service.ts`,
//! `src/utils/youtube.ts`), but the frontend is not a durable trust boundary: another call
//! path - a future feature, a devtools `invoke()`, or a bug that skips the service layer -
//! could otherwise persist a malformed handle or an empty title. The SQLite `CHECK`
//! constraints (`db_schema.rs`) already reject empty/blank names and a non-`video`/`audio`
//! `media_type`, but they surface as a raw constraint violation; validating here maps the
//! same conditions to the friendly, catalogued error codes the frontend already understands,
//! and additionally enforces the *handle format* the database cannot express.

use crate::{AppError, AppErrorCode, AppResult};

/// Upper bound (in Unicode scalar values) on a stored channel name. A real YouTube channel name is
/// well under this; the ceiling exists only so a malformed metadata response or a hand-edited import
/// cannot persist a megabyte-scale value. The database `CHECK`s enforce non-blankness but express no
/// length limit, so this is the only ceiling on what gets stored.
const MAX_CHANNEL_NAME_CHARS: usize = 200;

/// Upper bound (in Unicode scalar values) on a stored media title. Generous next to a real title
/// (YouTube caps its own at ~100) so a legitimately long local-file title still imports, while still
/// bounding an adversarial/malformed value that would otherwise also inflate `title_normalized` and
/// the cost of the search LIKE-scan it backs.
const MAX_MEDIA_TITLE_CHARS: usize = 500;

/// True for a normalized YouTube handle, mirroring `isValidNormalizedYoutubeHandle` in
/// `src/utils/youtube.ts`: either `@<name>` where `<name>` is non-empty and made only of
/// ASCII alphanumerics plus `.`/`_`/`-`, or a `channel/`, `c/` or `user/` prefix (case
/// insensitive) followed by a non-empty identifier. The frontend normalizes free-form input
/// (stripping URLs, adding the `@`) before it gets here; this only checks the stored shape.
fn is_valid_youtube_handle(value: &str) -> bool {
    let normalized = value.trim();

    if normalized.is_empty() {
        return false;
    }

    if let Some(handle) = normalized.strip_prefix('@') {
        let handle = handle.trim();

        return !handle.is_empty()
            && handle
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    }

    if let Some((prefix, identifier)) = normalized.split_once('/') {
        if matches!(
            prefix.trim().to_ascii_lowercase().as_str(),
            "channel" | "c" | "user"
        ) {
            return !identifier.trim().is_empty();
        }
    }

    false
}

/// True when `value` contains a control character (`\n`, `\r`, `\t`, and the rest of the C0/C1
/// range). These never appear in a legitimate channel name or media title, and rejecting them here
/// keeps a value that could forge a log line (an embedded newline) from ever being persisted -
/// defense in depth mirroring `commands::logging::sanitize_log_text`, which strips the same
/// characters at the other boundary. The database `CHECK`s cannot express this.
fn contains_control_char(value: &str) -> bool {
    value.chars().any(|c| c.is_control())
}

/// Rejects an empty/blank channel name, or one carrying control characters. The DB
/// `CHECK (TRIM(name) <> '')` enforces the non-blank part too, but mapping it here gives the
/// frontend the catalogued `INVALID_CHANNEL_NAME` code instead of a raw SQLite constraint error,
/// and the control-character rejection is something the database cannot express.
pub fn ensure_valid_channel_name(name: &str) -> AppResult<()> {
    if name.trim().is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidChannelName,
            "channel name is required",
        ));
    }

    if contains_control_char(name) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidChannelName,
            "channel name must not contain control characters",
        ));
    }

    if name.chars().count() > MAX_CHANNEL_NAME_CHARS {
        return Err(AppError::from_code(
            AppErrorCode::InvalidChannelName,
            "channel name is too long",
        ));
    }

    Ok(())
}

/// Rejects a handle that is empty or not in the normalized `@name` / `channel|c|user/id`
/// shape. Unlike the name/title checks, this enforces a format the database cannot express.
pub fn ensure_valid_youtube_handle(handle: &str) -> AppResult<()> {
    if !is_valid_youtube_handle(handle) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidYoutubeHandle,
            "invalid YouTube handle; use formats like @channelname, channel/..., c/... or user/...",
        ));
    }

    Ok(())
}

/// Rejects an empty/blank media title. Mirrors `db_schema.rs`'s `CHECK (TRIM(title) <> '')`
/// with the catalogued `INVALID_MEDIA_TITLE` code.
pub fn ensure_valid_media_title(title: &str) -> AppResult<()> {
    if title.trim().is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidMediaTitle,
            "media title is required",
        ));
    }

    if contains_control_char(title) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidMediaTitle,
            "media title must not contain control characters",
        ));
    }

    if title.chars().count() > MAX_MEDIA_TITLE_CHARS {
        return Err(AppError::from_code(
            AppErrorCode::InvalidMediaTitle,
            "media title is too long",
        ));
    }

    Ok(())
}

/// Rejects a `media_type` outside the supported set. Mirrors `db_schema.rs`'s
/// `CHECK (media_type IN ('video', 'audio'))`.
pub fn ensure_valid_media_type(media_type: &str) -> AppResult<()> {
    if matches!(media_type.trim(), "video" | "audio") {
        return Ok(());
    }

    Err(AppError::from_code(
        AppErrorCode::InvalidMediaCreationArguments,
        "media type must be 'video' or 'audio'",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_handles() {
        for handle in [
            "@chan",
            "@Chan_Name-1.2",
            "@a",
            "channel/UCabcdef",
            "c/SomeName",
            "user/legacyname",
            "CHANNEL/UCabc", // prefix is case-insensitive
            "channel/UC/with/slashes",
        ] {
            ensure_valid_youtube_handle(handle)
                .unwrap_or_else(|error| panic!("{handle} should be accepted: {error}"));
        }
    }

    #[test]
    fn rejects_invalid_handles() {
        for handle in [
            "",
            "   ",
            "@",
            "@ ",
            "@bad name", // internal space
            "@bad/name", // slash is not allowed inside an @handle
            "@emoji\u{1f600}",
            "plainname", // not normalized (no @ and no known prefix)
            "channel/",  // empty identifier
            "c/",
            "user/  ",                  // blank identifier
            "channels/x",               // unknown prefix
            "http://youtube.com/@chan", // a URL, not a normalized handle
        ] {
            let error = ensure_valid_youtube_handle(handle)
                .expect_err(&format!("{handle} should be rejected"));
            assert_eq!(error.code, AppErrorCode::InvalidYoutubeHandle.as_str());
        }
    }

    #[test]
    fn youtube_handle_validation_matches_the_shared_fixture() {
        // The frontend has its own copy of this rule (isValidNormalizedYoutubeHandle in
        // src/utils/youtube.ts) so it can give fast, friendly feedback before a round trip. The two
        // are independent implementations that must agree on every normalized handle: if the
        // backend tightened the rule and the frontend did not, an invalid handle would pass the
        // client check and come back as a raw backend error instead of the catalogued one. This
        // asserts the Rust side against the same shared cases the TypeScript side checks (see
        // src/utils/youtube.parity.test.ts), so a change on either side that breaks parity fails a
        // test rather than surfacing to a user.
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/youtube-handle-cases.json"
        ));
        let cases: serde_json::Value =
            serde_json::from_str(raw).expect("the shared fixture must be valid JSON");

        for handle in cases["valid"].as_array().expect("valid must be an array") {
            let handle = handle.as_str().expect("each case must be a string");
            assert!(
                is_valid_youtube_handle(handle),
                "the shared fixture marks {handle:?} valid but Rust rejects it"
            );
        }

        for handle in cases["invalid"]
            .as_array()
            .expect("invalid must be an array")
        {
            let handle = handle.as_str().expect("each case must be a string");
            assert!(
                !is_valid_youtube_handle(handle),
                "the shared fixture marks {handle:?} invalid but Rust accepts it"
            );
        }
    }

    #[test]
    fn channel_name_requires_non_blank() {
        ensure_valid_channel_name("Chan").unwrap();
        ensure_valid_channel_name("  Chan  ").unwrap();

        for name in ["", "   ", "\t\n"] {
            let error = ensure_valid_channel_name(name).unwrap_err();
            assert_eq!(error.code, AppErrorCode::InvalidChannelName.as_str());
        }
    }

    #[test]
    fn channel_name_rejects_embedded_control_characters() {
        // A name that is non-blank but carries a newline/carriage-return/tab (a log-forging value)
        // must be rejected, not just an all-blank one.
        for name in ["Chan\nnel", "Chan\rnel", "Chan\tnel", "Chan\u{7}nel"] {
            let error = ensure_valid_channel_name(name).unwrap_err();
            assert_eq!(error.code, AppErrorCode::InvalidChannelName.as_str());
        }
    }

    #[test]
    fn channel_name_rejects_an_over_length_value() {
        // At the ceiling is accepted; one scalar over is rejected. Guards against a malformed
        // metadata response or hand-edited import persisting a megabyte-scale name.
        ensure_valid_channel_name(&"a".repeat(MAX_CHANNEL_NAME_CHARS)).unwrap();

        let error = ensure_valid_channel_name(&"a".repeat(MAX_CHANNEL_NAME_CHARS + 1)).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidChannelName.as_str());
    }

    #[test]
    fn media_title_rejects_an_over_length_value() {
        ensure_valid_media_title(&"a".repeat(MAX_MEDIA_TITLE_CHARS)).unwrap();

        let error = ensure_valid_media_title(&"a".repeat(MAX_MEDIA_TITLE_CHARS + 1)).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidMediaTitle.as_str());
    }

    #[test]
    fn length_limits_count_scalar_values_not_bytes() {
        // The cap is in Unicode scalar values, so a multi-byte character counts once. A title of
        // MAX multi-byte chars (well over MAX bytes) must still be accepted.
        ensure_valid_media_title(&"e".repeat(MAX_MEDIA_TITLE_CHARS)).unwrap();
        ensure_valid_media_title(&"\u{e9}".repeat(MAX_MEDIA_TITLE_CHARS)).unwrap();
    }

    #[test]
    fn media_title_requires_non_blank() {
        ensure_valid_media_title("A title").unwrap();

        for title in ["", "   "] {
            let error = ensure_valid_media_title(title).unwrap_err();
            assert_eq!(error.code, AppErrorCode::InvalidMediaTitle.as_str());
        }
    }

    #[test]
    fn media_title_rejects_embedded_control_characters() {
        for title in ["A\ntitle", "A\rtitle", "A\ttitle", "A\u{7}title"] {
            let error = ensure_valid_media_title(title).unwrap_err();
            assert_eq!(error.code, AppErrorCode::InvalidMediaTitle.as_str());
        }
    }

    #[test]
    fn media_type_must_be_video_or_audio() {
        ensure_valid_media_type("video").unwrap();
        ensure_valid_media_type("audio").unwrap();
        ensure_valid_media_type("  video  ").unwrap();

        for media_type in ["", "image", "Video", "VIDEO", "movie"] {
            let error = ensure_valid_media_type(media_type).unwrap_err();
            assert_eq!(
                error.code,
                AppErrorCode::InvalidMediaCreationArguments.as_str()
            );
        }
    }
}
