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

/// Rejects an empty/blank channel name. The DB `CHECK (TRIM(name) <> '')` enforces this too,
/// but mapping it here gives the frontend the catalogued `INVALID_CHANNEL_NAME` code instead
/// of a raw SQLite constraint error.
pub fn ensure_valid_channel_name(name: &str) -> AppResult<()> {
    if name.trim().is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidChannelName,
            "channel name is required",
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
    fn channel_name_requires_non_blank() {
        ensure_valid_channel_name("Chan").unwrap();
        ensure_valid_channel_name("  Chan  ").unwrap();

        for name in ["", "   ", "\t\n"] {
            let error = ensure_valid_channel_name(name).unwrap_err();
            assert_eq!(error.code, AppErrorCode::InvalidChannelName.as_str());
        }
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
