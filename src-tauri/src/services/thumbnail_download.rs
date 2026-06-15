use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::AppHandle;
use tokio::process::Command;
use tokio::time::timeout;

use crate::models::yt_dlp::YtDlpMetadata;
use crate::services::binaries::{
    ffmpeg_location_argument, resolve_ffmpeg_binary, resolve_yt_dlp_binary,
};
use crate::services::filesystem::{clean_matching_files_in_dir, find_best_matching_file};
use crate::services::library_paths::ensure_library_dir;
use crate::services::temp_paths::yt_dlp_thumb_temp_dir;
use crate::services::thumbnail_persist::persist_thumbnail_from_source;
use crate::services::yt_dlp::{fetch_yt_dlp_metadata, sanitize_filename_component};
use crate::services::yt_dlp_cookies::normalize_cookies_browser;
use crate::{AppError, AppErrorCode, AppResult};

const THUMBNAIL_COMMAND_TIMEOUT_SECS: u64 = 60;

fn unique_temp_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);

    format!("{}-{}", std::process::id(), nanos)
}

fn read_process_error(
    output: &std::process::Output,
    default_code: AppErrorCode,
    default_message: &str,
) -> AppError {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();

    if !stderr.is_empty() {
        return AppError::from_code(default_code, format!("{default_message}: {stderr}"));
    }

    if !stdout.is_empty() {
        return AppError::from_code(default_code, format!("{default_message}: {stdout}"));
    }

    AppError::from_code(default_code, default_message)
}

fn normalize_channel_handle_to_url(youtube_handle: &str) -> AppResult<String> {
    let normalized = youtube_handle.trim();

    if normalized.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidUrl,
            "youtube handle is empty",
        ));
    }

    if normalized.starts_with("http://") || normalized.starts_with("https://") {
        return Ok(normalized.to_string());
    }

    if normalized.starts_with('@') {
        return Ok(format!("https://www.youtube.com/{normalized}"));
    }

    Ok(format!("https://www.youtube.com/@{normalized}"))
}

fn split_url_path(url: &str) -> &str {
    let without_query = url.split('?').next().unwrap_or(url);
    without_query.split('#').next().unwrap_or(without_query)
}

fn direct_image_extension(url: &str) -> Option<&'static str> {
    let normalized = split_url_path(url.trim()).to_lowercase();

    if !(normalized.starts_with("http://") || normalized.starts_with("https://")) {
        return None;
    }

    if normalized.ends_with(".png") {
        return Some("png");
    }

    if normalized.ends_with(".jpg") {
        return Some("jpg");
    }

    if normalized.ends_with(".jpeg") {
        return Some("jpeg");
    }

    if normalized.ends_with(".webp") {
        return Some("webp");
    }

    if normalized.ends_with(".bmp") {
        return Some("bmp");
    }

    if normalized.ends_with(".avif") {
        return Some("avif");
    }

    None
}

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

pub async fn download_thumbnail_from_url_async(
    app: &AppHandle,
    url: &str,
    library_path: &str,
) -> AppResult<String> {
    let normalized_url = url.trim().to_string();

    if normalized_url.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidUrl,
            "url is empty",
        ));
    }

    let library_dir = ensure_library_dir(library_path)?;
    let thumb_temp_root = yt_dlp_thumb_temp_dir(app)?;

    let temp_dir_name = unique_temp_suffix();
    let thumb_temp_dir = thumb_temp_root.join(temp_dir_name);

    fs::create_dir_all(&thumb_temp_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateTempThumbDirFailed,
            format!("failed to create temporary thumbnail directory: {e}"),
        )
    })?;

    let result = async {
        if let Some(ext) = direct_image_extension(&normalized_url) {
            let direct_file_path = thumb_temp_dir.join(format!("direct_thumbnail.{ext}"));

            let output = timeout(
                Duration::from_secs(THUMBNAIL_COMMAND_TIMEOUT_SECS),
                Command::new("curl")
                    .args([
                        "-L",
                        "-o",
                        direct_file_path.to_string_lossy().as_ref(),
                        normalized_url.as_str(),
                    ])
                    .output(),
            )
            .await
            .map_err(|_| {
                AppError::from_code(
                    AppErrorCode::YtDlpThumbnailTimeout,
                    "direct thumbnail download timed out",
                )
            })?
            .map_err(|e| {
                AppError::from_code(
                    AppErrorCode::YtDlpThumbnailExecFailed,
                    format!("failed to execute direct thumbnail download: {e}"),
                )
            })?;

            if !output.status.success() {
                return Err(read_process_error(
                    &output,
                    AppErrorCode::YtDlpThumbnailFailed,
                    "direct thumbnail download failed",
                ));
            }

            if !direct_file_path.is_file() {
                return Err(AppError::from_code(
                    AppErrorCode::YtDlpThumbnailNotFound,
                    "direct thumbnail download did not produce a file",
                ));
            }

            return persist_thumbnail_from_source(&direct_file_path, &library_dir);
        }

        let yt_dlp = resolve_yt_dlp_binary(app)?;
        let ffmpeg = resolve_ffmpeg_binary(app)?;
        let ffmpeg_location = ffmpeg_location_argument(&ffmpeg);

        let metadata = fetch_yt_dlp_metadata(&yt_dlp, &normalized_url, None, None).await?;

        let id = metadata
            .id
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| {
                AppError::from_code(
                    AppErrorCode::YtDlpInvalidMetadata,
                    "yt-dlp did not return a media id",
                )
            })?;

        let extractor = metadata
            .extractor
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "media".to_string());

        let safe_extractor = sanitize_filename_component(&extractor);
        let safe_id = sanitize_filename_component(&id);

        let file_prefix = format!("thumb_{}_{}", safe_extractor, safe_id);
        let file_name_prefix = format!("{file_prefix}.");

        clean_matching_files_in_dir(&thumb_temp_dir, &file_name_prefix)?;

        let output = timeout(
            Duration::from_secs(THUMBNAIL_COMMAND_TIMEOUT_SECS),
            Command::new(&yt_dlp)
                .args([
                    "--ignore-config",
                    "--no-playlist",
                    "--skip-download",
                    "--write-thumbnail",
                    "--convert-thumbnails",
                    "png",
                    "--restrict-filenames",
                    "--windows-filenames",
                    "--no-warnings",
                    "--ffmpeg-location",
                    ffmpeg_location.as_str(),
                    "--paths",
                    &format!("home:{}", thumb_temp_dir.to_string_lossy()),
                    "-o",
                    &format!("{}.%(ext)s", file_prefix),
                    normalized_url.as_str(),
                ])
                .output(),
        )
        .await
        .map_err(|_| {
            AppError::from_code(
                AppErrorCode::YtDlpThumbnailTimeout,
                "yt-dlp thumbnail download timed out",
            )
        })?
        .map_err(|e| {
            AppError::from_code(
                AppErrorCode::YtDlpThumbnailExecFailed,
                format!("failed to execute yt-dlp for thumbnail download: {e}"),
            )
        })?;

        if !output.status.success() {
            return Err(read_process_error(
                &output,
                AppErrorCode::YtDlpThumbnailFailed,
                "yt-dlp thumbnail download failed",
            ));
        }

        let downloaded_thumb =
            find_best_matching_file(&thumb_temp_dir, &file_name_prefix, Some("png")).map_err(
                |_| {
                    AppError::from_code(
                        AppErrorCode::YtDlpThumbnailNotFound,
                        "yt-dlp did not produce a thumbnail file",
                    )
                },
            )?;

        persist_thumbnail_from_source(&downloaded_thumb, &library_dir)
    }
    .await;

    let _ = fs::remove_dir_all(&thumb_temp_dir);

    result
}

pub async fn download_thumbnail_for_media_async(
    app: &AppHandle,
    media_url: &str,
    library_path: &str,
    metadata: &YtDlpMetadata,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
) -> AppResult<Option<String>> {
    let normalized_url = media_url.trim();

    if normalized_url.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidUrl,
            "url is empty",
        ));
    }

    let thumbnail_url = metadata
        .thumbnail
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if thumbnail_url.is_none() {
        return Ok(None);
    }

    let library_dir = ensure_library_dir(library_path)?;
    let thumb_temp_root = yt_dlp_thumb_temp_dir(app)?;

    let temp_dir_name = format!("media-thumb-{}", unique_temp_suffix());
    let thumb_temp_dir = thumb_temp_root.join(temp_dir_name);

    fs::create_dir_all(&thumb_temp_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateTempThumbDirFailed,
            format!("failed to create temporary thumbnail directory: {e}"),
        )
    })?;

    let result = async {
        let yt_dlp = resolve_yt_dlp_binary(app)?;
        let ffmpeg = resolve_ffmpeg_binary(app)?;
        let ffmpeg_location = ffmpeg_location_argument(&ffmpeg);

        let id = metadata
            .id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                AppError::from_code(
                    AppErrorCode::YtDlpInvalidMetadata,
                    "yt-dlp did not return a media id",
                )
            })?;

        let extractor = metadata
            .extractor
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("media");

        let safe_extractor = sanitize_filename_component(extractor);
        let safe_id = sanitize_filename_component(id);

        let file_prefix = format!("thumb_{}_{}", safe_extractor, safe_id);
        let file_name_prefix = format!("{file_prefix}.");

        clean_matching_files_in_dir(&thumb_temp_dir, &file_name_prefix)?;

        let mut args = vec![
            "--ignore-config".to_string(),
            "--no-playlist".to_string(),
            "--skip-download".to_string(),
            "--write-thumbnail".to_string(),
            "--convert-thumbnails".to_string(),
            "png".to_string(),
            "--restrict-filenames".to_string(),
            "--windows-filenames".to_string(),
            "--no-warnings".to_string(),
            "--ffmpeg-location".to_string(),
            ffmpeg_location,
            "--paths".to_string(),
            format!("home:{}", thumb_temp_dir.to_string_lossy()),
            "-o".to_string(),
            format!("{}.%(ext)s", file_prefix),
        ];

        append_auth_args(&mut args, cookies_browser, cookies_path);
        args.push(normalized_url.to_string());

        let output = timeout(
            Duration::from_secs(THUMBNAIL_COMMAND_TIMEOUT_SECS),
            Command::new(&yt_dlp).args(&args).output(),
        )
        .await
        .map_err(|_| {
            AppError::from_code(
                AppErrorCode::YtDlpThumbnailTimeout,
                "yt-dlp thumbnail download timed out",
            )
        })?
        .map_err(|e| {
            AppError::from_code(
                AppErrorCode::YtDlpThumbnailExecFailed,
                format!("failed to execute yt-dlp for thumbnail download: {e}"),
            )
        })?;

        if !output.status.success() {
            return Err(read_process_error(
                &output,
                AppErrorCode::YtDlpThumbnailFailed,
                "yt-dlp thumbnail download failed",
            ));
        }

        let downloaded_thumb =
            find_best_matching_file(&thumb_temp_dir, &file_name_prefix, Some("png")).map_err(
                |_| {
                    AppError::from_code(
                        AppErrorCode::YtDlpThumbnailNotFound,
                        "yt-dlp did not produce a thumbnail file",
                    )
                },
            )?;

        persist_thumbnail_from_source(&downloaded_thumb, &library_dir).map(Some)
    }
    .await;

    let _ = fs::remove_dir_all(&thumb_temp_dir);

    result
}

pub async fn download_channel_avatar_from_handle_async(
    app: &AppHandle,
    youtube_handle: &str,
    library_path: &str,
) -> AppResult<String> {
    let normalized_url = normalize_channel_handle_to_url(youtube_handle)?;
    let library_dir = ensure_library_dir(library_path)?;

    let yt_dlp = resolve_yt_dlp_binary(app)?;
    let ffmpeg = resolve_ffmpeg_binary(app)?;
    let ffmpeg_location = ffmpeg_location_argument(&ffmpeg);

    let thumb_temp_root = yt_dlp_thumb_temp_dir(app)?;
    let temp_dir_name = format!("channel-avatar-{}", unique_temp_suffix());
    let thumb_temp_dir = thumb_temp_root.join(temp_dir_name);

    fs::create_dir_all(&thumb_temp_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateTempThumbDirFailed,
            format!("failed to create temporary channel avatar directory: {e}"),
        )
    })?;

    let result = async {
        let file_prefix = "channel_avatar";
        let file_name_prefix = "channel_avatar.";

        clean_matching_files_in_dir(&thumb_temp_dir, file_name_prefix)?;

        let output = timeout(
            Duration::from_secs(THUMBNAIL_COMMAND_TIMEOUT_SECS),
            Command::new(&yt_dlp)
                .args([
                    "--ignore-config",
                    "--skip-download",
                    "--write-thumbnail",
                    "--convert-thumbnails",
                    "png",
                    "--playlist-items",
                    "0",
                    "--restrict-filenames",
                    "--windows-filenames",
                    "--no-warnings",
                    "--ffmpeg-location",
                    ffmpeg_location.as_str(),
                    "--paths",
                    &format!("home:{}", thumb_temp_dir.to_string_lossy()),
                    "-o",
                    &format!("{}.%(ext)s", file_prefix),
                    normalized_url.as_str(),
                ])
                .output(),
        )
        .await
        .map_err(|_| {
            AppError::from_code(
                AppErrorCode::YtDlpThumbnailTimeout,
                "yt-dlp channel avatar download timed out",
            )
        })?
        .map_err(|e| {
            AppError::from_code(
                AppErrorCode::YtDlpThumbnailExecFailed,
                format!("failed to execute yt-dlp for channel avatar download: {e}"),
            )
        })?;

        if !output.status.success() {
            return Err(read_process_error(
                &output,
                AppErrorCode::YtDlpThumbnailFailed,
                "yt-dlp channel avatar download failed",
            ));
        }

        let downloaded_thumb =
            find_best_matching_file(&thumb_temp_dir, file_name_prefix, Some("png")).map_err(
                |_| {
                    AppError::from_code(
                        AppErrorCode::YtDlpThumbnailNotFound,
                        "yt-dlp did not produce a channel avatar file",
                    )
                },
            )?;

        persist_thumbnail_from_source(&downloaded_thumb, &library_dir)
    }
    .await;

    let _ = fs::remove_dir_all(&thumb_temp_dir);

    result
}
