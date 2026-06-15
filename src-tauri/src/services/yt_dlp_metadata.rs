use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tauri::AppHandle;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    time::timeout,
};

use crate::models::yt_dlp::{
    YtDlpComment, YtDlpCommentMetadata, YtDlpFormatOption, YtDlpFormatsResult, YtDlpMetadata,
};
use crate::services::binaries::resolve_yt_dlp_binary;
use crate::services::yt_dlp_cookies::normalize_cookies_browser;
use crate::utils::format::{
    build_format_display_name, codec_is_present, normalize_yt_dlp_upload_date, sort_yt_dlp_formats,
};
use crate::{AppError, AppErrorCode, AppResult};

const YT_DLP_METADATA_TIMEOUT_SECS: u64 = 60;
const YT_DLP_COMMENTS_TIMEOUT_SECS: u64 = 180;

type NormalizedDownloadMetadata = (String, String, String, Option<String>, Option<String>);

fn normalize_cookies_path(value: Option<&str>) -> Option<String> {
    let normalized = value?.trim();

    if normalized.is_empty() {
        return None;
    }

    let path = Path::new(normalized);

    if path.exists() && path.is_file() {
        Some(normalized.to_string())
    } else {
        None
    }
}

fn append_auth_args(
    args: &mut Vec<String>,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
) {
    if let Some(path) = normalize_cookies_path(cookies_path) {
        args.push("--cookies".to_string());
        args.push(path);
        return;
    }

    if let Some(browser) = normalize_cookies_browser(cookies_browser) {
        args.push("--cookies-from-browser".to_string());
        args.push(browser);
    }
}

pub fn sanitize_filename_component(value: &str) -> String {
    let sanitized: String = value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();

    let compact = sanitized
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_");

    if compact.is_empty() {
        "media".to_string()
    } else {
        compact
    }
}

fn is_json_payload_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with('{') || trimmed.starts_with('[')
}

fn should_keep_terminal_line(line: &str) -> bool {
    let trimmed = line.trim();

    if trimmed.is_empty() {
        return false;
    }

    if is_json_payload_line(trimmed) {
        return false;
    }

    true
}

fn is_age_restriction_error_line(line: &str) -> bool {
    let normalized = line.trim().to_lowercase();

    normalized.contains("sign in to confirm your age")
        || normalized.contains("this video is age-restricted")
        || normalized.contains("age-restricted")
        || normalized.contains("login_required")
        || normalized.contains("may be inappropriate for some users")
}

fn build_friendly_terminal_hints(stdout_logs: &[String], stderr_logs: &[String]) -> Vec<String> {
    let has_age_restriction = stdout_logs
        .iter()
        .chain(stderr_logs.iter())
        .any(|line| is_age_restriction_error_line(line));

    let mut hints = Vec::new();

    if has_age_restriction {
        hints.push("INFO: This YouTube video requires age verification.".to_string());
        hints.push(
            "INFO: Use cookies from a logged-in account that has already completed age verification."
                .to_string(),
        );
        hints.push(
            "INFO: In Authentication, choose a browser already logged into YouTube or provide a cookies.txt file from a verified account."
                .to_string(),
        );
    }

    hints
}

fn is_traceback_noise(line: &str) -> bool {
    let trimmed = line.trim();
    let normalized = trimmed.to_lowercase();

    trimmed.starts_with("File \"")
        || normalized.starts_with("traceback")
        || normalized.starts_with("during handling of the above exception")
        || normalized.contains(" in raise_no_formats")
}

fn is_preferred_error_detail(line: &str) -> bool {
    let normalized = line.trim().to_lowercase();

    normalized.contains("sign in to confirm your age")
        || normalized.contains("this video is age-restricted")
        || normalized.contains("age-restricted")
        || normalized.contains("login_required")
        || normalized.starts_with("error:")
}

fn select_best_error_detail(
    stdout_logs: &[String],
    stderr_logs: &[String],
    failed_message: &str,
) -> String {
    if let Some(line) = stderr_logs
        .iter()
        .rev()
        .find(|line| is_preferred_error_detail(line))
    {
        return line.clone();
    }

    if let Some(line) = stdout_logs
        .iter()
        .rev()
        .find(|line| is_preferred_error_detail(line))
    {
        return line.clone();
    }

    if let Some(line) = stderr_logs
        .iter()
        .rev()
        .find(|line| !line.trim().is_empty() && !is_traceback_noise(line))
    {
        return line.clone();
    }

    if let Some(line) = stdout_logs
        .iter()
        .rev()
        .find(|line| !line.trim().is_empty() && !is_traceback_noise(line))
    {
        return line.clone();
    }

    stderr_logs
        .iter()
        .rev()
        .find(|line| !line.trim().is_empty())
        .cloned()
        .or_else(|| {
            stdout_logs
                .iter()
                .rev()
                .find(|line| !line.trim().is_empty())
                .cloned()
        })
        .unwrap_or_else(|| failed_message.to_string())
}

async fn run_yt_dlp_and_capture_json(
    yt_dlp: &str,
    args: &[String],
    timeout_secs: u64,
    timeout_code: AppErrorCode,
    exec_code: AppErrorCode,
    failed_code: AppErrorCode,
    timeout_message: &str,
    exec_message: &str,
    failed_message: &str,
) -> AppResult<(String, Vec<String>, Vec<String>)> {
    let mut child = Command::new(yt_dlp)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::from_code(exec_code, format!("{exec_message}: {e}")))?;

    let stdout = child.stdout.take().ok_or_else(|| {
        AppError::from_code(
            AppErrorCode::YtDlpStdoutCaptureFailed,
            "failed to capture yt-dlp stdout",
        )
    })?;

    let stderr = child.stderr.take().ok_or_else(|| {
        AppError::from_code(
            AppErrorCode::YtDlpStderrCaptureFailed,
            "failed to capture yt-dlp stderr",
        )
    })?;

    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut json_payload = String::new();
        let mut log_lines: Vec<String> = Vec::new();

        while let Ok(Some(line_value)) = lines.next_line().await {
            let line = line_value.trim_end().to_string();

            if line.trim().is_empty() {
                continue;
            }

            if is_json_payload_line(&line) {
                json_payload = line;
            } else if should_keep_terminal_line(&line) {
                log_lines.push(line);
            }
        }

        (json_payload, log_lines)
    });

    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut log_lines: Vec<String> = Vec::new();

        while let Ok(Some(line_value)) = lines.next_line().await {
            let line = line_value.trim_end().to_string();

            if should_keep_terminal_line(&line) {
                log_lines.push(line);
            }
        }

        log_lines
    });

    let status = timeout(Duration::from_secs(timeout_secs), child.wait())
        .await
        .map_err(|_| AppError::from_code(timeout_code, timeout_message))?
        .map_err(|e| AppError::from_code(exec_code, format!("{exec_message}: {e}")))?;

    let (json_payload, stdout_logs) = stdout_task.await.map_err(|e| {
        AppError::from_code(
            AppErrorCode::YtDlpStdoutCaptureFailed,
            format!("failed to read yt-dlp stdout: {e}"),
        )
    })?;

    let stderr_logs = stderr_task.await.map_err(|e| {
        AppError::from_code(
            AppErrorCode::YtDlpStderrCaptureFailed,
            format!("failed to read yt-dlp stderr: {e}"),
        )
    })?;

    if !status.success() {
        let detail = select_best_error_detail(&stdout_logs, &stderr_logs, failed_message);

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

pub async fn fetch_yt_dlp_metadata(
    yt_dlp: &str,
    url: &str,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
) -> AppResult<YtDlpMetadata> {
    let mut args = vec![
        "-v".to_string(),
        "--ignore-config".to_string(),
        "--no-playlist".to_string(),
        "--dump-single-json".to_string(),
        "--no-warnings".to_string(),
    ];

    append_auth_args(&mut args, cookies_browser, cookies_path);
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

async fn fetch_yt_dlp_metadata_with_comments(
    yt_dlp: &str,
    url: &str,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
) -> AppResult<YtDlpMetadata> {
    let mut args = vec![
        "-v".to_string(),
        "--ignore-config".to_string(),
        "--no-playlist".to_string(),
        "--skip-download".to_string(),
        "--dump-single-json".to_string(),
        "--write-comments".to_string(),
        "--no-warnings".to_string(),
        "--extractor-args".to_string(),
        "youtube:comment_sort=top".to_string(),
    ];

    append_auth_args(&mut args, cookies_browser, cookies_path);
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

    let author_handle = author_name
        .strip_prefix('@')
        .map(|_| author_name.clone())
        .or_else(|| None);

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

pub async fn fetch_youtube_comments_async(
    app: &AppHandle,
    video_id: &str,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
) -> AppResult<Vec<YtDlpComment>> {
    let normalized_video_id = video_id.trim();

    if normalized_video_id.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidUrl,
            "youtube video id is empty",
        ));
    }

    let yt_dlp = resolve_yt_dlp_binary(app)?;
    let url = format!("https://www.youtube.com/watch?v={}", normalized_video_id);

    let metadata =
        fetch_yt_dlp_metadata_with_comments(&yt_dlp, &url, cookies_browser, cookies_path).await?;

    let comments = metadata
        .comments
        .into_iter()
        .filter_map(normalize_comment_metadata)
        .collect::<Vec<_>>();

    Ok(comments)
}

pub async fn list_yt_dlp_formats_async(
    app: &AppHandle,
    url: &str,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
) -> AppResult<YtDlpFormatsResult> {
    let normalized_url = url.trim().to_string();

    if normalized_url.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidUrl,
            "url is empty",
        ));
    }

    let yt_dlp = resolve_yt_dlp_binary(app)?;

    let mut args = vec![
        "-v".to_string(),
        "--ignore-config".to_string(),
        "--no-playlist".to_string(),
        "--dump-single-json".to_string(),
        "--no-warnings".to_string(),
    ];

    append_auth_args(&mut args, cookies_browser, cookies_path);
    args.push(normalized_url.clone());

    let (json_payload, mut stdout_logs, stderr_logs) = run_yt_dlp_and_capture_json(
        &yt_dlp,
        &args,
        YT_DLP_METADATA_TIMEOUT_SECS,
        AppErrorCode::YtDlpMetadataTimeout,
        AppErrorCode::YtDlpMetadataExecFailed,
        AppErrorCode::YtDlpMetadataFailed,
        "yt-dlp metadata request timed out",
        "failed to execute yt-dlp metadata command",
        "yt-dlp could not load media information for this URL.",
    )
    .await?;

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

    let mut formats: Vec<YtDlpFormatOption> = metadata
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
                display_name: build_format_display_name(&format, &media_type),
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
            })
        })
        .collect();

    sort_yt_dlp_formats(&mut formats);

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
        formats,
        terminal_logs,
    })
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

    let youtube_video_id = if extractor.to_lowercase().contains("youtube") {
        Some(id.clone())
    } else {
        None
    };

    let published_at = normalize_yt_dlp_upload_date(metadata.upload_date.clone());

    Ok((
        id,
        extractor,
        suggested_title,
        youtube_video_id,
        published_at,
    ))
}
