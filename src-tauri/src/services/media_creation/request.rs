//! What a media creation is asked for, and the checks and normalization it goes through before
//! anything touches the disk.

use super::*;

/// Where a media's bytes come from. The two modes differ only in how the artifacts are produced;
/// everything from the crash marker onwards is identical.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaSourceMode {
    Local,
    YtDlp,
}

/// Everything one media creation needs, as the renderer sends it.
///
/// Deliberately the same field set the frontend already assembled for its own orchestration, so the
/// move is a change of *who runs the steps* rather than of what the user is asked for. Every value
/// here is caller-supplied and none is trusted. The library is not among them (`create_media_async`
/// fills `library_path` from the settings), the title goes through the shared validator, and every produced
/// path is re-checked as a managed library-relative path before it reaches a row. The media type is
/// not asked for at all. A download reports it and a local import takes it from its extension, the
/// same rule that picks the file's subdirectory, so a row cannot say "video" about a file in
/// `audio/`.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct CreateMediaRequest {
    // Tauri serializes an i64 as a JSON number, so it is annotated rather than left to ts-rs's
    // `bigint` default. The same override every other exported id in this crate carries.
    #[cfg_attr(test, ts(type = "number"))]
    pub channel_id: i64,
    pub title: String,
    #[cfg_attr(test, ts(type = "\"local\" | \"yt-dlp\""))]
    pub source_mode: MediaSourceMode,
    /// A URL for a yt-dlp run, an absolute path for a local import.
    // path-surface: an absolute path in local-import mode, so it belongs to the caller-supplied
    // path surface the command inventory gates, and no naming rule can tell. `source_value` is the
    // honest name (it is a URL in the other mode), a `source_` prefix rule would also match
    // `source_mode` right above, and renaming it would make the name lie for yt-dlp runs and churn
    // the generated binding. Removing this line shrinks what the inventory check reports, which
    // fails that check rather than passing quietly.
    pub source_value: String,
    /// A managed `thumbnails/...` path, a remote URL, or an absolute path the user picked. Absent
    /// means "derive one", from the download's own thumbnail, or from the media file itself.
    pub thumbnail_source_path: Option<String>,
    #[cfg_attr(test, ts(type = "\"copy\" | \"move\""))]
    pub import_mode: ImportMode,
    /// Not sent by the renderer. `commands::media::create_media` fills it from the settings.
    #[serde(skip_deserializing)]
    #[cfg_attr(test, ts(skip))]
    pub library_path: String,
    pub published_at: Option<String>,
    pub yt_dlp_run_id: String,
    pub yt_dlp_format_id: String,
    /// Resolved from the format metadata before the download starts, so an already-registered video
    /// fails fast instead of after fetching the whole file.
    pub yt_dlp_youtube_video_id: Option<String>,
    pub download_live_chat: bool,
    pub cookies_browser: Option<String>,
    pub cookies_path: Option<String>,
}

/// The registered media, as the caller needs to see it.
///
/// Carries the stored paths rather than only the id because the steps that stay in the renderer
/// need them. The duration probe reads `file_path`/`media_type`, the comment backup reads
/// `youtube_video_id`, and the live-chat notice reads whether a replay was actually saved.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct CreatedMedia {
    #[cfg_attr(test, ts(type = "number"))]
    pub id: i64,
    pub file_path: String,
    pub thumbnail_path: Option<String>,
    #[cfg_attr(test, ts(type = "\"video\" | \"audio\""))]
    pub media_type: String,
    pub youtube_video_id: Option<String>,
    pub live_chat_file_path: Option<String>,
    pub is_live: bool,
    /// A Move import whose original could not be removed (another program holding it, a read-only
    /// folder). The media is registered from the library copy, so the import ended as a Copy, and
    /// the user is told rather than left to find the file still there.
    pub original_kept: bool,
}

/// The artifacts one creation wrote into the library, before any row points at them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct PreparedArtifacts {
    pub(crate) file_path: String,
    pub(crate) thumbnail_path: Option<String>,
    pub(crate) media_type: String,
    pub(crate) youtube_video_id: Option<String>,
    pub(crate) published_at: Option<String>,
    pub(crate) is_live: bool,
    pub(crate) live_chat_file_path: Option<String>,
    /// A Move import's source, still on disk until the row lands. See
    /// `library::media::StagedMediaImport`.
    pub(crate) move_source_to_remove: Option<PathBuf>,
    /// True when `file_path` is the only copy of the user's file, so neither the failure path nor
    /// the startup sweep may delete it.
    pub(crate) media_file_is_only_copy: bool,
    /// Where a Move renamed the user's file from (see `library::media::StagedMediaImport`). A failed
    /// registration puts the file back there.
    pub(crate) renamed_from: Option<PathBuf>,
    /// A crash marker an earlier step already recorded for these artifacts (a download records one
    /// for its file the moment it is placed). Cleared once the registration's own marker is down.
    pub(crate) interim_marker: Option<String>,
}

/// What a caller-supplied thumbnail value actually is, which decides how it is turned into a stored
/// path.
///
/// Pure and separate from the resolving, because the classification is the part with a security
/// consequence and no I/O. An absolute path is handed to the persist step, a URL to the downloader
/// (whose own host allow-list then applies), and a value that is already a managed `thumbnails/...`
/// path is taken as-is rather than re-persisted. Reading a remote URL as a local path, or the
/// reverse, is exactly the confusion worth pinning with a test rather than inferring from a chain of
/// regexes buried in an async function.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ThumbnailSource {
    /// Already stored in the library under `thumbnails/`, so there is nothing to do.
    Managed(String),
    /// An `http(s)` URL to fetch.
    Remote(String),
    /// An absolute path on disk to copy into the library.
    Local(String),
    /// Nothing was supplied.
    Absent,
}

pub(super) fn is_remote_url(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();

    lowered.starts_with("http://") || lowered.starts_with("https://")
}

/// True for an absolute path in either platform's spelling.
///
/// Both are recognized regardless of the host platform, matching the frontend predicate this
/// replaced. The value can come from a database row written on another machine (an imported
/// library), so a Windows path reaching a Linux build must still be classified as a path rather
/// than falling through to the managed branch.
pub(super) fn is_absolute_file_path(value: &str) -> bool {
    if value.starts_with('/') || value.starts_with('\\') {
        return true;
    }

    let mut chars = value.chars();

    match (chars.next(), chars.next(), chars.next()) {
        (Some(drive), Some(':'), Some('\\' | '/')) => drive.is_ascii_alphabetic(),
        _ => false,
    }
}

/// Whether a download may skip fetching its own thumbnail because the request supplies one.
///
/// Only a value that classifies as a thumbnail does. One the classifier reads as absent (a `file:`
/// or `data:` URL, a relative path outside `thumbnails/`) is not stored either, so skipping on its
/// mere presence registered the media with no thumbnail at all, and nothing said so.
pub(crate) fn supplied_thumbnail_replaces_fetched(value: Option<&str>) -> bool {
    !matches!(classify_thumbnail_source(value), ThumbnailSource::Absent)
}

pub(crate) fn classify_thumbnail_source(value: Option<&str>) -> ThumbnailSource {
    let trimmed = value.map(str::trim).unwrap_or_default();

    if trimmed.is_empty() {
        return ThumbnailSource::Absent;
    }

    if is_remote_url(trimmed) {
        return ThumbnailSource::Remote(trimmed.to_string());
    }

    if is_absolute_file_path(trimmed) {
        return ThumbnailSource::Local(trimmed.to_string());
    }

    // A relative value is only meaningful when it names the managed thumbnails directory. Anything
    // else is a value this app did not write and has no way to interpret.
    if trimmed.starts_with(&format!("{}/", crate::constants::LIBRARY_DIR_THUMBNAILS)) {
        return ThumbnailSource::Managed(trimmed.to_string());
    }

    ThumbnailSource::Absent
}

/// Refuses a request naming a local file the backend never handed out (the media file of a local
/// import, a thumbnail on disk, or a cookies file). See `services::chosen_files`.
///
/// A string comparison only, so it runs before anything stats the paths.
pub(crate) fn ensure_request_files_were_chosen(request: &CreateMediaRequest) -> AppResult<()> {
    use crate::services::chosen_files::{ensure_chosen, ensure_chosen_if_present, ChosenFile};

    if matches!(request.source_mode, MediaSourceMode::Local) {
        ensure_chosen(ChosenFile::MEDIA, &request.source_value)?;
    }

    if let ThumbnailSource::Local(path) =
        classify_thumbnail_source(request.thumbnail_source_path.as_deref())
    {
        ensure_chosen(ChosenFile::IMAGE, &path)?;
    }

    ensure_chosen_if_present(ChosenFile::COOKIES, request.cookies_path.as_deref())
}

/// Normalizes a caller-supplied optional string to `None` when it is blank.
pub(super) fn normalized_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Validates and normalizes the request before any file is written.
///
/// Runs first, and entirely, so a rejected request produces nothing to clean up. The title and media
/// type go through the same validators every other write boundary calls. The rest is trimming, which
/// matters because a padded value would otherwise be validated in one form and stored in another.
///
/// Pure, so every refusal is one call from a test. The request arrives over IPC, so these are the
/// checks that stand between a hostile payload and a download.
pub(crate) fn normalize_create_media_request(
    request: CreateMediaRequest,
) -> AppResult<CreateMediaRequest> {
    let title = request.title.trim().to_string();
    let source_value = request.source_value.trim().to_string();
    let library_path = request.library_path.trim().to_string();

    ensure_valid_media_title(&title)?;

    if source_value.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidMediaCreationArguments,
            "media source is required",
        ));
    }

    if library_path.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryPath,
            "library path is empty",
        ));
    }

    let yt_dlp_run_id = request.yt_dlp_run_id.trim().to_string();
    let yt_dlp_format_id = request.yt_dlp_format_id.trim().to_string();

    // Only checked for a yt-dlp source. A local import legitimately carries neither, and demanding
    // them there would reject every local add. The values themselves are validated again, by
    // character class, in `yt_dlp::download::command` before they reach an argv.
    if request.source_mode == MediaSourceMode::YtDlp {
        if yt_dlp_run_id.is_empty() {
            return Err(AppError::from_code(
                AppErrorCode::InvalidRunId,
                "yt-dlp run id is required",
            ));
        }

        if yt_dlp_format_id.is_empty() {
            return Err(AppError::from_code(
                AppErrorCode::InvalidFormatId,
                "yt-dlp format id is required",
            ));
        }
    }

    // A calendar date, the shape the form's date field produces and the one a yt-dlp upload date is
    // normalized to. The sort by publication date compares the column as text, so anything else
    // stored here would sort somewhere arbitrary.
    let published_at = normalized_optional(request.published_at);

    if let Some(date) = published_at.as_deref() {
        if chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() || date.len() != 10 {
            return Err(AppError::from_code(
                AppErrorCode::InvalidMediaCreationArguments,
                "the publication date must be a date written as YYYY-MM-DD",
            ));
        }
    }

    Ok(CreateMediaRequest {
        title,
        source_value,
        library_path,
        thumbnail_source_path: normalized_optional(request.thumbnail_source_path),
        published_at,
        yt_dlp_run_id,
        yt_dlp_format_id,
        yt_dlp_youtube_video_id: normalized_optional(request.yt_dlp_youtube_video_id),
        cookies_browser: normalized_optional(request.cookies_browser),
        cookies_path: normalized_optional(request.cookies_path),
        ..request
    })
}
