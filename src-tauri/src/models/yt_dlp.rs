use serde::{Deserialize, Serialize};

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    Copy,
    Move,
}

impl ImportMode {
    /// The mode's name for a log line.
    ///
    /// Spelled out rather than reached through `{:?}`, so that a log line never carries a
    /// `Debug`-formatted value. `Debug` on a `Path` prints the whole path, which is what
    /// `services::logger::redact_path` exists to prevent, and CI now refuses `{:?}` anywhere near a
    /// logger call rather than trusting each site to be the harmless kind. This was the one
    /// harmless kind.
    pub fn as_str(self) -> &'static str {
        match self {
            ImportMode::Copy => "copy",
            ImportMode::Move => "move",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct DownloadedMediaResult {
    pub file_path: String,
    pub suggested_title: String,
    pub youtube_video_id: Option<String>,
    pub published_at: Option<String>,
    #[cfg_attr(test, ts(type = "\"video\" | \"audio\""))]
    pub media_type: String,
    pub thumbnail_path: Option<String>,
    pub is_live: bool,
    pub live_chat_file_path: Option<String>,
    /// The crash marker the download recorded for its file as soon as it was in the library, which
    /// the registration replaces with its own. Backend only.
    #[serde(skip)]
    #[cfg_attr(test, ts(skip))]
    pub placement_marker: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum DownloadLogLevel {
    Info,
    Warn,
    Error,
}

// Exposed to the frontend as `YtDlpLogEvent`. `stream` is a plain String, but the emitter
// only ever sets these three values, so it is refined to a union for the frontend.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        rename = "YtDlpLogEvent",
        export_to = "../../src/types/generated/"
    )
)]
pub struct DownloadLogEvent {
    pub run_id: String,
    pub line: String,
    #[cfg_attr(test, ts(type = "\"stdout\" | \"stderr\" | \"system\""))]
    pub stream: String,
    pub level: DownloadLogLevel,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        rename = "YtDlpFinishedEvent",
        export_to = "../../src/types/generated/"
    )
)]
pub struct DownloadFinishedEvent {
    pub run_id: String,
    pub file_path: String,
    pub suggested_title: String,
}

// Emitted for both the error and cancelled events (identical shape).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        rename = "YtDlpFailedEvent",
        export_to = "../../src/types/generated/"
    )
)]
pub struct DownloadFailedEvent {
    pub run_id: String,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum DownloadTerminalStatus {
    Finished,
    Failed,
    Cancelled,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        rename = "YtDlpTerminalEvent",
        export_to = "../../src/types/generated/"
    )
)]
pub struct DownloadTerminalEvent {
    pub run_id: String,
    pub status: DownloadTerminalStatus,
    pub message: Option<String>,
    pub file_path: Option<String>,
    pub suggested_title: Option<String>,
}

#[derive(Deserialize, Default, Clone, Debug)]
pub struct YtDlpMetadata {
    pub id: Option<String>,
    pub title: Option<String>,
    pub extractor: Option<String>,
    pub upload_date: Option<String>,
    pub thumbnail: Option<String>,
    // Every thumbnail yt-dlp knows of, in ascending preference. Entries with a width are the ones
    // YouTube declared. The rest are URLs yt-dlp guesses at, which 404 on older videos.
    #[serde(default)]
    pub thumbnails: Vec<YtDlpThumbnailMetadata>,
    pub live_status: Option<String>,
    pub was_live: Option<bool>,
    #[serde(default)]
    pub formats: Vec<YtDlpFormatMetadata>,
    #[serde(default)]
    pub comments: Vec<YtDlpCommentMetadata>,
    // The comment total YouTube reports for the video, independent of how many comments were
    // actually downloaded. Used to tell "the video genuinely has no comments" (null / 0) from
    // "the video has comments but extraction returned none" (a positive count with an empty
    // `comments`). Absent/`null` when comments are disabled.
    #[serde(default)]
    pub comment_count: Option<i64>,
}

/// A count or a size from yt-dlp's JSON, as an unsigned integer when it is one.
///
/// yt-dlp writes these as integers today, but a single field of another shape (a float such as
/// `4182345.5`, a negative, a string) failed the whole metadata parse with it, which turns one odd
/// value in one format into a media that cannot be added at all. A float is rounded, and anything
/// that is not a non-negative number reads as absent, the way a missing field already does.
fn lenient_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;

    Ok(value.and_then(|value| {
        value.as_u64().or_else(|| {
            value
                .as_f64()
                .filter(|number| number.is_finite() && *number >= 0.0 && *number <= u64::MAX as f64)
                .map(|number| number.round() as u64)
        })
    }))
}

/// [`lenient_u64`] for a value that may be negative. yt-dlp's `language_preference` is one, from 10
/// for a video's original audio track down to -10 for an audio description.
fn lenient_i64<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;

    Ok(value.and_then(|value| {
        value.as_i64().or_else(|| {
            value
                .as_f64()
                .filter(|number| {
                    number.is_finite() && *number >= i64::MIN as f64 && *number <= i64::MAX as f64
                })
                .map(|number| number.round() as i64)
        })
    }))
}

/// A string field that reads as absent when yt-dlp sends anything else, for the same reason as
/// [`lenient_u64`].
fn lenient_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;

    Ok(value.and_then(|value| value.as_str().map(str::to_string)))
}

#[derive(Deserialize, Default, Clone, Debug)]
pub struct YtDlpThumbnailMetadata {
    pub url: Option<String>,
    #[serde(default, deserialize_with = "lenient_u64")]
    pub width: Option<u64>,
}

#[derive(Deserialize, Default, Clone, Debug)]
pub struct YtDlpFormatMetadata {
    pub format_id: Option<String>,
    pub ext: Option<String>,
    pub format: Option<String>,
    pub format_note: Option<String>,
    pub resolution: Option<String>,
    #[serde(default, deserialize_with = "lenient_u64")]
    pub filesize: Option<u64>,
    #[serde(default, deserialize_with = "lenient_u64")]
    pub filesize_approx: Option<u64>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    #[serde(default, deserialize_with = "lenient_u64")]
    pub height: Option<u64>,
    pub fps: Option<f64>,
    pub abr: Option<f64>,
    pub tbr: Option<f64>,
    pub protocol: Option<String>,
    /// The audio track's language, on a video with more than one (YouTube's dubbed tracks).
    #[serde(default, deserialize_with = "lenient_string")]
    pub language: Option<String>,
    /// How yt-dlp ranks the audio track's language. On YouTube 10 is the original track, 5 the
    /// default one, -1 a dubbed one and -10 an audio description.
    #[serde(default, deserialize_with = "lenient_i64")]
    pub language_preference: Option<i64>,
}

#[derive(Deserialize, Default, Clone, Debug)]
pub struct YtDlpCommentMetadata {
    pub id: Option<String>,
    pub parent: Option<String>,
    pub author: Option<String>,
    pub author_id: Option<String>,
    pub author_thumbnail: Option<String>,
    pub author_is_uploader: Option<bool>,
    pub author_url: Option<String>,
    pub is_favorited: Option<bool>,
    pub is_pinned: Option<bool>,
    pub text: Option<String>,
    #[serde(default, deserialize_with = "lenient_u64")]
    pub like_count: Option<u64>,
    #[serde(default, deserialize_with = "lenient_u64")]
    pub reply_count: Option<u64>,
    pub time_text: Option<String>,
    pub timestamp: Option<i64>,
    pub is_edited: Option<bool>,
}

// Exposed to the frontend as `YtDlpFormat`. u64 fields are annotated `number` (Tauri
// serializes them as JSON numbers, not the bigint ts-rs emits by default), and f64 fields map
// to `number` natively.
//
// Carries no display label or presentation order on purpose. The frontend cannot use either.
// It synthesizes the "merged" video+audio entries that YouTube does not serve as a single
// format (see `buildMergedFormats`), so it has to label and order entries this side never
// emitted, and a label produced here would be overwritten for every row. What the two sides
// do agree on is `format_id`. The frontend mints combined ids like `137+140` from these, and
// `yt_dlp::download::resolve_format_has_video` resolves them back against this metadata.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        rename = "YtDlpFormat",
        export_to = "../../src/types/generated/"
    )
)]
pub struct YtDlpFormatOption {
    pub format_id: String,
    pub ext: String,
    #[cfg_attr(test, ts(type = "\"video\" | \"audio\""))]
    pub media_type: String,
    pub has_video: bool,
    pub has_audio: bool,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub filesize_bytes: Option<u64>,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub height: Option<u64>,
    pub abr: Option<f64>,
    pub tbr: Option<f64>,
    pub vcodec: Option<String>,
    pub protocol: Option<String>,
    /// See [`YtDlpFormatMetadata::language`]. Optional on the frontend side, since only a video
    /// with several audio tracks has it.
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub language: Option<String>,
    /// See [`YtDlpFormatMetadata::language_preference`]. The picker joins a video to the original
    /// track before any other, so a video with dubbed tracks is not saved with one of them.
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable, type = "number | null"))]
    pub language_preference: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct YtDlpFormatsResult {
    pub suggested_title: String,
    // Resolved from the same metadata fetch, before any download starts, so the frontend can
    // pre-check for an already-registered duplicate (see `media_exists_for_channel_and_youtube_id`)
    // without having to download the video first.
    pub youtube_video_id: Option<String>,
    pub formats: Vec<YtDlpFormatOption>,
    pub terminal_logs: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct YtDlpComment {
    pub comment_id: Option<String>,
    pub parent_comment_id: Option<String>,
    pub author_name: String,
    pub author_handle: Option<String>,
    pub author_channel_id: Option<String>,
    pub author_thumbnail: Option<String>,
    pub text: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub like_count: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub reply_count: u64,
    pub is_author_uploader: bool,
    pub is_favorited: bool,
    pub is_pinned: bool,
    pub is_edited: bool,
    pub time_text: Option<String>,
    pub published_at: Option<String>,
}

// Exposed to the frontend as `ExternalToolStatus`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        rename = "ExternalToolStatus",
        export_to = "../../src/types/generated/"
    )
)]
pub struct ExternalToolHealth {
    pub path: String,
    pub version: String,
    pub healthy: bool,
    /// Days between the release this version names and today, when the version string encodes a
    /// date. Yt-dlp's versions are dates (`2026.07.01`), ffmpeg's are not, so this is `None` for
    /// ffmpeg and for anything unparseable.
    ///
    /// Deliberately a fact rather than a verdict. Whether an age is worth warning about is a
    /// diagnostics policy, and every other such rule lives in `src/services/diagnostics-rules.ts`
    /// rather than being split across the IPC boundary.
    pub release_age_days: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct ExternalToolsStatus {
    pub yt_dlp: ExternalToolHealth,
    pub ffmpeg: ExternalToolHealth,
    /// Deno, the JavaScript runtime yt-dlp runs YouTube's player code with. Unlike the two above,
    /// a missing one does not fail the check. yt-dlp still starts without it and downloads less
    /// (some formats go missing, some videos fail), which Diagnostics reports as a warning.
    pub js_runtime: ExternalToolHealth,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_odd_numeric_field_does_not_fail_the_whole_format() {
        let format: YtDlpFormatMetadata = serde_json::from_value(serde_json::json!({
            "format_id": "137",
            "filesize": 1024,
            "filesize_approx": 4182345.5,
            "height": "1080",
        }))
        .unwrap();

        assert_eq!(format.filesize, Some(1024));
        assert_eq!(format.filesize_approx, Some(4182346));
        assert_eq!(format.height, None);
        assert_eq!(format.format_id.as_deref(), Some("137"));
    }

    #[test]
    fn an_audio_track_keeps_its_language_and_a_negative_preference() {
        let dubbed: YtDlpFormatMetadata = serde_json::from_value(serde_json::json!({
            "format_id": "140-0",
            "language": "es",
            "language_preference": -1,
        }))
        .unwrap();

        assert_eq!(dubbed.language.as_deref(), Some("es"));
        assert_eq!(dubbed.language_preference, Some(-1));

        // Odd shapes read as absent rather than failing the format.
        let odd: YtDlpFormatMetadata = serde_json::from_value(serde_json::json!({
            "format_id": "140",
            "language": 7,
            "language_preference": "original",
        }))
        .unwrap();

        assert_eq!(odd.language, None);
        assert_eq!(odd.language_preference, None);
    }

    #[test]
    fn a_missing_or_negative_count_reads_as_absent() {
        let comment: YtDlpCommentMetadata = serde_json::from_value(serde_json::json!({
            "id": "c1",
            "like_count": -3,
        }))
        .unwrap();

        assert_eq!(comment.like_count, None);
        assert_eq!(comment.reply_count, None);
    }
}
