use std::fs;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use http::Uri;
use http_body_util::{BodyExt, Empty};
use hyper::body::Bytes;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use tauri::AppHandle;
use tokio::net::lookup_host;
use tokio::process::Command;
use tokio::time::timeout;

use crate::models::yt_dlp::YtDlpMetadata;
use crate::services::binaries::{
    ffmpeg_location_argument, resolve_ffmpeg_binary_async, resolve_yt_dlp_binary_async,
};
use crate::services::filesystem::{clean_matching_files_in_dir, find_best_matching_file};
use crate::services::library_paths::ensure_library_dir;
use crate::services::temp_paths::yt_dlp_thumb_temp_dir;
use crate::services::thumbnail_persist::persist_thumbnail_from_source;
use crate::services::yt_dlp::{fetch_yt_dlp_metadata, sanitize_filename_component};
use crate::services::yt_dlp_cookies::normalize_cookies_browser;
use crate::utils::process::hide_console_async;
use crate::{AppError, AppErrorCode, AppResult};

const THUMBNAIL_COMMAND_TIMEOUT_SECS: u64 = 60;
const DIRECT_THUMBNAIL_MAX_BYTES: usize = 10 * 1024 * 1024; // 10 MiB
const DIRECT_THUMBNAIL_MAX_REDIRECTS: usize = 10;

const ALLOWED_THUMBNAIL_CONTENT_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/bmp",
    "image/avif",
];

/// Resolves a redirect `location` header value against the `current` URI.
///
/// Accepts absolute http/https URLs and path-based relatives (`/...` or `path`).
/// Rejects any other scheme (`file://`, `ftp://`, etc.) with an explicit error.
fn resolve_redirect(current: &Uri, location: &str) -> AppResult<Uri> {
    let location_lc = location.to_ascii_lowercase();

    // Absolute http/https - scheme comparison is case-insensitive per RFC 3986
    if location_lc.starts_with("http://") || location_lc.starts_with("https://") {
        return location.parse().map_err(|e| {
            AppError::from_code(
                AppErrorCode::YtDlpThumbnailFailed,
                format!("invalid absolute redirect location: {e}"),
            )
        });
    }

    // Protocol-relative: //host/path - inherit current scheme
    if location.starts_with("//") {
        let scheme = current.scheme_str().unwrap_or("https");
        return format!("{scheme}:{location}").parse().map_err(|e| {
            AppError::from_code(
                AppErrorCode::YtDlpThumbnailFailed,
                format!("failed to resolve protocol-relative redirect: {e}"),
            )
        });
    }

    // Reject any other scheme (file://, ftp://, etc.)
    if location.contains("://") {
        return Err(AppError::from_code(
            AppErrorCode::YtDlpThumbnailFailed,
            format!("redirect to non-http scheme rejected: {location}"),
        ));
    }

    let scheme = current.scheme_str().unwrap_or("https");
    let authority = current.authority().map(|a| a.as_str()).unwrap_or_default();

    let path = if location.starts_with('/') {
        location.to_string()
    } else {
        let base = current
            .path()
            .rfind('/')
            .map(|i| &current.path()[..=i])
            .unwrap_or("/");
        format!("{base}{location}")
    };

    format!("{scheme}://{authority}{path}")
        .parse()
        .map_err(|e| {
            AppError::from_code(
                AppErrorCode::YtDlpThumbnailFailed,
                format!("failed to resolve redirect location: {e}"),
            )
        })
}

fn is_disallowed_ipv4(addr: &Ipv4Addr) -> bool {
    let octets = addr.octets();

    addr.is_loopback()
        || addr.is_private()
        || addr.is_link_local()
        || addr.is_broadcast()
        || addr.is_documentation()
        || addr.is_multicast()
        || addr.is_unspecified()
        || octets[0] == 0 // 0.0.0.0/8 "this host on this network"
        || (octets[0] == 100 && (64..=127).contains(&octets[1])) // 100.64.0.0/10 CGNAT
        || octets[0] >= 240 // 240.0.0.0/4 reserved
}

fn is_disallowed_ipv6(addr: &Ipv6Addr) -> bool {
    if let Some(mapped) = addr.to_ipv4_mapped() {
        return is_disallowed_ipv4(&mapped);
    }

    let first_segment = addr.segments()[0];

    addr.is_loopback()
        || addr.is_unspecified()
        || addr.is_multicast()
        || (first_segment & 0xfe00) == 0xfc00 // fc00::/7 unique local
        || (first_segment & 0xffc0) == 0xfe80 // fe80::/10 link local
}

/// Rejects addresses that must never be fetched from a user-provided URL: loopback,
/// private, link-local (incl. cloud metadata 169.254.169.254), multicast and reserved.
fn is_disallowed_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(addr) => is_disallowed_ipv4(addr),
        IpAddr::V6(addr) => is_disallowed_ipv6(addr),
    }
}

/// Resolves the host of `uri` and rejects it if it maps to any private, loopback or
/// reserved address (SSRF guard). Applied to the initial URL and every redirect target.
///
/// This checks the resolved addresses before the request; it does not pin the connection
/// to a validated address, so a determined DNS-rebinding attacker could still race it.
/// That residual risk is acceptable for a local desktop app fetching image thumbnails.
async fn assert_url_host_is_public(uri: &Uri) -> AppResult<()> {
    let host = uri.host().ok_or_else(|| {
        AppError::from_code(AppErrorCode::InvalidUrl, "thumbnail url has no host")
    })?;

    let host = host.trim_start_matches('[').trim_end_matches(']');

    let port = uri.port_u16().unwrap_or_else(|| match uri.scheme_str() {
        Some("http") => 80,
        _ => 443,
    });

    let addresses = lookup_host((host, port)).await.map_err(|e| {
        AppError::from_code(
            AppErrorCode::YtDlpThumbnailFailed,
            format!("failed to resolve thumbnail host: {e}"),
        )
    })?;

    let mut resolved_any = false;

    for address in addresses {
        resolved_any = true;

        if is_disallowed_ip(&address.ip()) {
            return Err(AppError::from_code(
                AppErrorCode::InvalidUrl,
                "thumbnail url resolves to a private, loopback or reserved address",
            ));
        }
    }

    if !resolved_any {
        return Err(AppError::from_code(
            AppErrorCode::YtDlpThumbnailFailed,
            "thumbnail host did not resolve to any address",
        ));
    }

    Ok(())
}

/// Downloads `url` over HTTPS (or HTTP), follows up to DIRECT_THUMBNAIL_MAX_REDIRECTS
/// redirects, streams the body with a hard cap of DIRECT_THUMBNAIL_MAX_BYTES, and
/// validates Content-Type when present. Returns (status, headers, body).
async fn http_get_image(
    url: &str,
    timeout_secs: u64,
) -> AppResult<(http::StatusCode, http::HeaderMap, Vec<u8>)> {
    let connector = hyper_rustls::HttpsConnectorBuilder::new()
        .with_provider_and_platform_verifier(rustls::crypto::ring::default_provider())
        .map_err(|e| {
            AppError::from_code(
                AppErrorCode::YtDlpThumbnailExecFailed,
                format!("failed to initialize TLS: {e}"),
            )
        })?
        .https_or_http()
        .enable_http1()
        .build();

    let client: Client<_, Empty<Bytes>> = Client::builder(TokioExecutor::new()).build(connector);

    let mut uri: Uri = url
        .parse()
        .map_err(|e| AppError::from_code(AppErrorCode::InvalidUrl, format!("invalid url: {e}")))?;

    for _ in 0..=DIRECT_THUMBNAIL_MAX_REDIRECTS {
        assert_url_host_is_public(&uri).await?;

        let req = hyper::Request::get(uri.clone())
            .body(Empty::new())
            .map_err(|e| {
                AppError::from_code(
                    AppErrorCode::YtDlpThumbnailFailed,
                    format!("failed to build request: {e}"),
                )
            })?;

        let res = timeout(Duration::from_secs(timeout_secs), client.request(req))
            .await
            .map_err(|_| {
                AppError::from_code(
                    AppErrorCode::YtDlpThumbnailTimeout,
                    "thumbnail download timed out",
                )
            })?
            .map_err(|e| {
                AppError::from_code(
                    AppErrorCode::YtDlpThumbnailFailed,
                    format!("thumbnail request failed: {e}"),
                )
            })?;

        let status = res.status();

        if status.is_redirection() {
            match res
                .headers()
                .get(http::header::LOCATION)
                .and_then(|v| v.to_str().ok())
            {
                Some(loc) => {
                    uri = resolve_redirect(&uri, loc)?;
                    continue;
                }
                None => {
                    return Err(AppError::from_code(
                        AppErrorCode::YtDlpThumbnailFailed,
                        format!("redirect without valid Location header (status {status})"),
                    ));
                }
            }
        }

        let headers = res.headers().clone();
        let mut body = res.into_body();
        let mut buffer: Vec<u8> = Vec::new();

        while let Some(frame_result) = body.frame().await {
            let frame = frame_result.map_err(|e| {
                AppError::from_code(
                    AppErrorCode::YtDlpThumbnailFailed,
                    format!("failed to read response body: {e}"),
                )
            })?;
            if let Ok(data) = frame.into_data() {
                if buffer.len() + data.len() > DIRECT_THUMBNAIL_MAX_BYTES {
                    return Err(AppError::from_code(
                        AppErrorCode::YtDlpThumbnailFailed,
                        format!(
                            "thumbnail response exceeded {} MiB limit",
                            DIRECT_THUMBNAIL_MAX_BYTES / (1024 * 1024)
                        ),
                    ));
                }
                buffer.extend_from_slice(&data);
            }
        }

        return Ok((status, headers, buffer));
    }

    Err(AppError::from_code(
        AppErrorCode::YtDlpThumbnailFailed,
        "too many redirects downloading thumbnail",
    ))
}

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

    if !normalized_url.starts_with("http://") && !normalized_url.starts_with("https://") {
        return Err(AppError::from_code(
            AppErrorCode::InvalidUrl,
            "url scheme must be http or https",
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

            let (status, headers, buffer) =
                http_get_image(normalized_url.as_str(), THUMBNAIL_COMMAND_TIMEOUT_SECS).await?;

            if !status.is_success() {
                return Err(AppError::from_code(
                    AppErrorCode::YtDlpThumbnailFailed,
                    format!("direct thumbnail download failed with status: {status}"),
                ));
            }

            let content_type = headers
                .get(http::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(';').next())
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_default();

            if !content_type.is_empty()
                && !ALLOWED_THUMBNAIL_CONTENT_TYPES.contains(&content_type.as_str())
            {
                return Err(AppError::from_code(
                    AppErrorCode::YtDlpThumbnailFailed,
                    format!("unexpected content type for thumbnail: {content_type}"),
                ));
            }

            fs::write(&direct_file_path, &buffer).map_err(|e| {
                AppError::from_code(
                    AppErrorCode::YtDlpThumbnailFailed,
                    format!("failed to write downloaded thumbnail: {e}"),
                )
            })?;

            return persist_thumbnail_from_source(&direct_file_path, &library_dir);
        }

        let yt_dlp = resolve_yt_dlp_binary_async(app).await?;
        let ffmpeg = resolve_ffmpeg_binary_async(app).await?;
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

        let mut command = Command::new(&yt_dlp);
        command.args([
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
            "--",
            normalized_url.as_str(),
        ]);
        hide_console_async(&mut command);

        let output = timeout(
            Duration::from_secs(THUMBNAIL_COMMAND_TIMEOUT_SECS),
            command.output(),
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
        let yt_dlp = resolve_yt_dlp_binary_async(app).await?;
        let ffmpeg = resolve_ffmpeg_binary_async(app).await?;
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
        args.push("--".to_string());
        args.push(normalized_url.to_string());

        let mut command = Command::new(&yt_dlp);
        command.args(&args);
        hide_console_async(&mut command);

        let output = timeout(
            Duration::from_secs(THUMBNAIL_COMMAND_TIMEOUT_SECS),
            command.output(),
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

    let yt_dlp = resolve_yt_dlp_binary_async(app).await?;
    let ffmpeg = resolve_ffmpeg_binary_async(app).await?;
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

        let mut command = Command::new(&yt_dlp);
        command.args([
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
            "--",
            normalized_url.as_str(),
        ]);
        hide_console_async(&mut command);

        let output = timeout(
            Duration::from_secs(THUMBNAIL_COMMAND_TIMEOUT_SECS),
            command.output(),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn uri(s: &str) -> Uri {
        s.parse().unwrap()
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn is_disallowed_ip_blocks_private_and_reserved_ranges() {
        for blocked in [
            "127.0.0.1",        // loopback
            "10.1.2.3",         // private
            "172.16.5.4",       // private
            "192.168.0.10",     // private
            "169.254.169.254",  // link-local / cloud metadata
            "100.64.0.1",       // CGNAT
            "0.0.0.0",          // unspecified
            "240.0.0.1",        // reserved
            "224.0.0.1",        // multicast
            "::1",              // ipv6 loopback
            "fe80::1",          // ipv6 link local
            "fc00::1",          // ipv6 unique local
            "::ffff:127.0.0.1", // ipv4-mapped loopback
        ] {
            assert!(
                is_disallowed_ip(&ip(blocked)),
                "{blocked} should be blocked"
            );
        }
    }

    #[test]
    fn is_disallowed_ip_allows_public_addresses() {
        for allowed in [
            "8.8.8.8",
            "1.1.1.1",
            "142.250.72.238",
            "2606:4700:4700::1111",
        ] {
            assert!(
                !is_disallowed_ip(&ip(allowed)),
                "{allowed} should be allowed"
            );
        }
    }

    #[tokio::test]
    async fn assert_url_host_rejects_loopback_and_metadata_literals() {
        assert!(assert_url_host_is_public(&uri("http://127.0.0.1/x.png"))
            .await
            .is_err());
        assert!(
            assert_url_host_is_public(&uri("http://169.254.169.254/latest/meta-data"))
                .await
                .is_err()
        );
        assert!(assert_url_host_is_public(&uri("http://[::1]:8080/x.png"))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn assert_url_host_allows_public_literal() {
        assert!(assert_url_host_is_public(&uri("https://8.8.8.8/x.png"))
            .await
            .is_ok());
    }

    #[test]
    fn absolute_https_redirect_accepted() {
        let result = resolve_redirect(
            &uri("https://img.example.com/old.jpg"),
            "https://cdn.example.com/new.jpg",
        );
        assert_eq!(result.unwrap(), uri("https://cdn.example.com/new.jpg"));
    }

    #[test]
    fn absolute_http_redirect_accepted() {
        let result = resolve_redirect(
            &uri("http://img.example.com/old.jpg"),
            "http://img.example.com/other.jpg",
        );
        assert_eq!(result.unwrap(), uri("http://img.example.com/other.jpg"));
    }

    #[test]
    fn absolute_path_redirect_resolved_against_authority() {
        let result = resolve_redirect(
            &uri("https://img.example.com/path/old.jpg"),
            "/new/image.jpg",
        );
        assert_eq!(
            result.unwrap(),
            uri("https://img.example.com/new/image.jpg")
        );
    }

    #[test]
    fn relative_path_redirect_resolved_against_base() {
        let result = resolve_redirect(&uri("https://img.example.com/a/b/old.jpg"), "new.jpg");
        assert_eq!(result.unwrap(), uri("https://img.example.com/a/b/new.jpg"));
    }

    #[test]
    fn file_scheme_redirect_rejected() {
        let result = resolve_redirect(
            &uri("https://img.example.com/thumb.jpg"),
            "file:///etc/passwd",
        );
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("non-http scheme rejected"));
    }

    #[test]
    fn ftp_scheme_redirect_rejected() {
        let result = resolve_redirect(
            &uri("https://img.example.com/thumb.jpg"),
            "ftp://img.example.com/thumb.jpg",
        );
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("non-http scheme rejected"));
    }

    #[test]
    fn protocol_relative_redirect_resolved() {
        let result = resolve_redirect(
            &uri("https://img.example.com/old.jpg"),
            "//cdn.example.com/image.jpg",
        );
        assert_eq!(result.unwrap(), uri("https://cdn.example.com/image.jpg"));
    }

    #[test]
    fn uppercase_scheme_redirect_accepted() {
        let result = resolve_redirect(
            &uri("https://img.example.com/old.jpg"),
            "HTTPS://cdn.example.com/new.jpg",
        );
        assert_eq!(result.unwrap(), uri("HTTPS://cdn.example.com/new.jpg"));
    }
}
