//! The yt-dlp runs that read one JSON document back (a video's metadata, its comments, its formats),
//! with what they share split by topic into the submodules below.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Runtime};
use tokio::{
    io::{AsyncRead, AsyncReadExt, BufReader},
    process::Command,
};

use crate::models::yt_dlp::{
    YtDlpComment, YtDlpCommentMetadata, YtDlpFormatOption, YtDlpFormatsResult, YtDlpMetadata,
};
use crate::services::binaries::resolve_yt_dlp_binary_async;
use crate::services::yt_dlp::cookies::{
    append_auth_args, normalize_cookies_browser, redact_cookies_browser_selector,
};
use crate::services::yt_dlp::registry::{register_download_run, DownloadRunReleaseGuard};
use crate::services::yt_dlp::url::{is_allowed_youtube_url, youtube_ref_for_log};
use crate::utils::bounded_semaphore::BoundedSemaphore;
use crate::utils::format::{codec_is_present, normalize_yt_dlp_upload_date};
use crate::utils::io::{read_lossy_line, read_lossy_line_capped, MAX_PROGRESS_LINE_BYTES};
use crate::{AppError, AppErrorCode, AppResult};

mod json_run;
mod redaction;
mod sanitize;
mod terminal;

pub(crate) use json_run::*;
pub(crate) use redaction::*;
pub use sanitize::*;
use terminal::*;

const YT_DLP_METADATA_TIMEOUT_SECS: u64 = 60;
const YT_DLP_COMMENTS_TIMEOUT_SECS: u64 = 180;

pub async fn fetch_yt_dlp_metadata(
    yt_dlp: &str,
    url: &str,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
    cancel: Option<Arc<AtomicBool>>,
) -> AppResult<YtDlpMetadata> {
    let mut args = base_json_args();
    args.extend(["-v".to_string(), "--no-playlist".to_string()]);

    append_auth_args(&mut args, cookies_browser, cookies_path);
    args.push("--".to_string());
    args.push(url.to_string());

    let (json_payload, _stdout_logs, _stderr_logs) = run_yt_dlp_and_capture_json(
        yt_dlp,
        &args,
        YT_DLP_METADATA_TIMEOUT_SECS,
        AppErrorCode::YtDlpMetadataTimeout,
        AppErrorCode::YtDlpMetadataExecFailed,
        AppErrorCode::YtDlpMetadataFailed,
        "yt-dlp metadata request timed out",
        "failed to execute yt-dlp metadata command",
        "yt-dlp could not load media information for this URL.",
        cancel,
    )
    .await?;

    serde_json::from_str(&json_payload).map_err(|e| {
        AppError::from_code_with_details(
            AppErrorCode::YtDlpMetadataParseFailed,
            "yt-dlp returned invalid media information for this URL.",
            format!("yt-dlp metadata parse failed: {e}"),
        )
    })
}

/// The extractor arguments for a comment backup.
///
/// Capped at `MAX_COMMENTS_PER_MEDIA` because that is the most one `merge_media_comments` accepts.
/// Uncapped, yt-dlp kept paging through a video with more, and the whole backup was then refused
/// at that limit, or ran into the timeout first, with nothing saved either way.
fn comments_extractor_args() -> String {
    format!(
        "youtube:comment_sort=top;max_comments={}",
        crate::services::media_comments::MAX_COMMENTS_PER_MEDIA
    )
}

async fn fetch_yt_dlp_metadata_with_comments(
    yt_dlp: &str,
    url: &str,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
    cancel: Option<Arc<AtomicBool>>,
) -> AppResult<YtDlpMetadata> {
    let mut args = base_json_args();
    args.extend([
        "-v".to_string(),
        "--no-playlist".to_string(),
        "--skip-download".to_string(),
        "--write-comments".to_string(),
        "--extractor-args".to_string(),
        comments_extractor_args(),
    ]);

    append_auth_args(&mut args, cookies_browser, cookies_path);
    args.push("--".to_string());
    args.push(url.to_string());

    let (json_payload, _stdout_logs, _stderr_logs) = run_yt_dlp_and_capture_json(
        yt_dlp,
        &args,
        YT_DLP_COMMENTS_TIMEOUT_SECS,
        AppErrorCode::YtDlpCommentsTimeout,
        AppErrorCode::YtDlpCommentsExecFailed,
        AppErrorCode::YtDlpCommentsFailed,
        "yt-dlp comments request timed out",
        "failed to execute yt-dlp comments command",
        "yt-dlp could not load YouTube comments for this media.",
        cancel,
    )
    .await?;

    serde_json::from_str(&json_payload).map_err(|e| {
        AppError::from_code_with_details(
            AppErrorCode::YtDlpCommentsParseFailed,
            "yt-dlp returned invalid YouTube comments data.",
            format!("yt-dlp comments parse failed: {e}"),
        )
    })
}

fn normalize_comment_metadata(comment: YtDlpCommentMetadata) -> Option<YtDlpComment> {
    let text = comment.text.unwrap_or_default().trim().to_string();

    if text.is_empty() {
        return None;
    }

    let author_name = comment
        .author
        .unwrap_or_else(|| "Unknown author".to_string())
        .trim()
        .to_string();

    let author_name = if author_name.is_empty() {
        "Unknown author".to_string()
    } else {
        author_name
    };

    let author_handle = author_name.strip_prefix('@').map(|_| author_name.clone());

    Some(YtDlpComment {
        comment_id: comment
            .id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        parent_comment_id: comment
            .parent
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        author_name,
        author_handle,
        author_channel_id: comment
            .author_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        author_thumbnail: comment
            .author_thumbnail
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        text,
        like_count: comment.like_count.unwrap_or(0),
        reply_count: comment.reply_count.unwrap_or(0),
        is_author_uploader: comment.author_is_uploader.unwrap_or(false),
        is_favorited: comment.is_favorited.unwrap_or(false),
        is_pinned: comment.is_pinned.unwrap_or(false),
        is_edited: comment.is_edited.unwrap_or(false),
        time_text: comment
            .time_text
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        published_at: comment.timestamp.map(|value| value.to_string()),
    })
}

pub(crate) fn is_valid_youtube_video_id(value: &str) -> bool {
    value.len() == 11
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Decides whether an empty comment result means extraction *failed* rather than the video
/// genuinely having no comments. yt-dlp succeeded (a hard failure would already be an error),
/// but returned no comments while YouTube reports a positive `comment_count`, so the comments
/// exist and could not be retrieved (rate limiting, temporary unavailability). A `None`/`0`
/// reported count means comments are disabled or genuinely zero, which is not an error.
fn comments_extraction_looks_incomplete(reported_count: Option<i64>, extracted: usize) -> bool {
    extracted == 0 && reported_count.is_some_and(|count| count > 0)
}

pub async fn fetch_youtube_comments_async<R: Runtime>(
    app: &AppHandle<R>,
    video_id: &str,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
    run_id: Option<&str>,
) -> AppResult<Vec<YtDlpComment>> {
    let normalized_video_id = video_id.trim();

    if normalized_video_id.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidYoutubeVideoId,
            "youtube video id is empty",
        ));
    }

    if !is_valid_youtube_video_id(normalized_video_id) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidYoutubeVideoId,
            format!("invalid youtube video id: \"{}\"", normalized_video_id),
        ));
    }

    // Register the run (when a run_id was supplied) so the frontend can cancel this comment backup
    // (which can run for up to YT_DLP_COMMENTS_TIMEOUT_SECS) promptly, instead of waiting it out.
    // The guard unregisters the run when this function returns. Registered before anything else
    // awaits, so a Cancel clicked right after the fetch starts finds the run instead of being
    // refused as unknown.
    let (cancel_flag, _run_release_guard) = optional_cancellable_run(run_id)?;

    let yt_dlp = resolve_yt_dlp_binary_async(app).await?;
    let url = format!("https://www.youtube.com/watch?v={}", normalized_video_id);

    // yt-dlp reads and rewrites a copy (see RunCookies).
    let run_cookies = super::cookies::RunCookies::prepare_async(
        cookies_path,
        crate::services::temp_paths::yt_dlp_temp_dir_async(app).await?,
    )
    .await;

    let metadata = fetch_yt_dlp_metadata_with_comments(
        &yt_dlp,
        &url,
        cookies_browser,
        run_cookies.path().as_deref(),
        cancel_flag,
    )
    .await?;

    run_cookies.keep_refreshed_async().await;

    let reported_comment_count = metadata.comment_count;

    let comments = metadata
        .comments
        .into_iter()
        .filter_map(normalize_comment_metadata)
        .collect::<Vec<_>>();

    // Distinguish "the video has no comments" (fine) from "the video has comments but none
    // could be retrieved" (a failure worth surfacing, so the caller does not report an empty
    // refresh as success). A genuine hard failure already returned an error above.
    if comments_extraction_looks_incomplete(reported_comment_count, comments.len()) {
        return Err(AppError::from_code(
            AppErrorCode::YtDlpCommentsIncomplete,
            "the video reports comments but none could be retrieved (they may be rate-limited or temporarily unavailable)",
        ));
    }

    Ok(comments)
}

pub async fn list_yt_dlp_formats_async<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
    run_id: Option<&str>,
) -> AppResult<YtDlpFormatsResult> {
    let normalized_url = url.trim().to_string();

    if normalized_url.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidUrl,
            "url is empty",
        ));
    }

    if !is_allowed_youtube_url(&normalized_url) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidUrl,
            "url must be an http(s) YouTube URL",
        ));
    }

    if !crate::services::yt_dlp::url::names_one_video(&normalized_url) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidUrl,
            "the link is not a single video (a playlist, a channel, a feed or a search)",
        ));
    }

    // Register the run (when a run_id was supplied) so the frontend can cancel a slow format probe
    // promptly instead of waiting out YT_DLP_METADATA_TIMEOUT_SECS. The guard unregisters the run
    // when this function returns. Before anything else awaits, as the comment fetch does, so a
    // cancel sent right after the probe starts finds it.
    let (cancel_flag, _run_release_guard) = optional_cancellable_run(run_id)?;

    let yt_dlp = resolve_yt_dlp_binary_async(app).await?;

    let mut args = base_json_args();
    args.extend(["-v".to_string(), "--no-playlist".to_string()]);

    // yt-dlp reads and rewrites a copy (see RunCookies).
    let run_cookies = super::cookies::RunCookies::prepare_async(
        cookies_path,
        crate::services::temp_paths::yt_dlp_temp_dir_async(app).await?,
    )
    .await;

    append_auth_args(&mut args, cookies_browser, run_cookies.path().as_deref());
    args.push("--".to_string());
    args.push(normalized_url.clone());

    let (json_payload, mut stdout_logs, mut stderr_logs) = run_yt_dlp_and_capture_json(
        &yt_dlp,
        &args,
        YT_DLP_METADATA_TIMEOUT_SECS,
        AppErrorCode::YtDlpMetadataTimeout,
        AppErrorCode::YtDlpMetadataExecFailed,
        AppErrorCode::YtDlpMetadataFailed,
        "yt-dlp metadata request timed out",
        "failed to execute yt-dlp metadata command",
        "yt-dlp could not load media information for this URL.",
        cancel_flag,
    )
    .await?;

    // These logs are returned to the frontend below (`terminal_logs`). Neither the cookies file
    // path nor the full pasted URL may survive into them. yt-dlp's `-v` mode echoes the whole argv
    // (the `[debug] Command-line config: [...]` line), so the URL with its playlist/tracking
    // parameters would otherwise reach a log the user might paste into a public issue. Reduce it to
    // the same privacy-preserving reference the download flow logs (`youtube_ref_for_log`), matching
    // that flow's `redacted_args_for_log`.
    // The browser selector is redacted as it was *normalized* (the argv carries that form), so
    // the replacement matches the echoed value rather than whatever spacing the caller typed.
    let normalized_cookies_browser = normalize_cookies_browser(cookies_browser);
    // The argv names the run's copy of the cookies file, not the user's, and the copy sits in the
    // app's cache under the user's home folder. Both are redacted.
    let run_cookies_path = run_cookies.path();

    for line in stdout_logs.iter_mut().chain(stderr_logs.iter_mut()) {
        *line = redact_probe_line(
            line,
            [cookies_path, run_cookies_path.as_deref()],
            normalized_cookies_browser.as_deref(),
            &normalized_url,
        );
    }

    // The probe is a full YouTube request, so the cookies it renewed are kept like a download's.
    run_cookies.keep_refreshed_async().await;

    let metadata: YtDlpMetadata = serde_json::from_str(&json_payload).map_err(|e| {
        AppError::from_code_with_details(
            AppErrorCode::YtDlpMetadataParseFailed,
            "yt-dlp returned invalid media information for this URL.",
            format!("yt-dlp metadata parse failed: {e}"),
        )
    })?;

    let suggested_title = metadata
        .title
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "Untitled".to_string());

    let youtube_video_id =
        resolve_youtube_video_id(metadata.id.as_deref(), metadata.extractor.as_deref());

    let formats: Vec<YtDlpFormatOption> = metadata
        .formats
        .into_iter()
        .filter_map(|format| {
            let format_id = format
                .format_id
                .as_ref()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())?;

            let has_video = codec_is_present(&format.vcodec);
            let has_audio = codec_is_present(&format.acodec);

            if !has_video && !has_audio {
                return None;
            }

            let media_type = if has_video {
                "video".to_string()
            } else {
                "audio".to_string()
            };

            let ext = format
                .ext
                .as_ref()
                .map(|v| v.trim().to_lowercase())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "bin".to_string());

            let filesize_bytes = format.filesize.or(format.filesize_approx);

            let protocol = format
                .protocol
                .as_ref()
                .map(|value| value.trim().to_lowercase())
                .filter(|value| !value.is_empty());

            Some(YtDlpFormatOption {
                format_id,
                ext,
                media_type,
                has_video,
                has_audio,
                filesize_bytes,
                height: format.height,
                abr: format.abr,
                tbr: format.tbr,
                vcodec: format
                    .vcodec
                    .as_ref()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                protocol,
                language: format
                    .language
                    .as_ref()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                language_preference: format.language_preference,
            })
        })
        .collect();

    let friendly_hints = build_friendly_terminal_hints(&stdout_logs, &stderr_logs);

    if !friendly_hints.is_empty() {
        stdout_logs.push(String::new());
        stdout_logs.extend(friendly_hints);
    }

    let mut terminal_logs = Vec::new();
    terminal_logs.extend(stdout_logs);
    terminal_logs.extend(stderr_logs);

    Ok(YtDlpFormatsResult {
        suggested_title,
        youtube_video_id,
        formats,
        terminal_logs,
    })
}

/// True when yt-dlp's `extractor` field indicates the media came from YouTube. Shared by the
/// download flow (`normalize_download_metadata`) and the format-listing flow
/// (`list_yt_dlp_formats_async`) so both resolve the same youtube video id from the same
/// metadata fetch. The latter lets the frontend pre-check for an already-registered duplicate
/// before any download starts, instead of only after downloading the whole file.
fn resolve_youtube_video_id(id: Option<&str>, extractor: Option<&str>) -> Option<String> {
    let id = id.map(str::trim).filter(|value| !value.is_empty())?;
    let extractor = extractor.unwrap_or_default().to_lowercase();

    if extractor.contains("youtube") {
        Some(id.to_string())
    } else {
        None
    }
}

pub fn normalize_download_metadata(
    metadata: &YtDlpMetadata,
) -> AppResult<NormalizedDownloadMetadata> {
    let id = metadata
        .id
        .clone()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| {
            AppError::from_code(
                AppErrorCode::YtDlpInvalidMetadata,
                "yt-dlp did not return a media id",
            )
        })?;

    let extractor = metadata
        .extractor
        .clone()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "media".to_string());

    let suggested_title = metadata
        .title
        .clone()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "Untitled".to_string());

    let youtube_video_id = resolve_youtube_video_id(Some(&id), Some(&extractor));

    let published_at = normalize_yt_dlp_upload_date(metadata.upload_date.clone());

    Ok((
        id,
        extractor,
        suggested_title,
        youtube_video_id,
        published_at,
    ))
}

#[cfg(test)]
mod tests;
