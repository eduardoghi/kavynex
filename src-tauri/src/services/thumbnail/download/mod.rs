//! Downloading a thumbnail or a channel avatar into the library.
//!
//! This module orchestrates the three flows (a direct image URL, a media's thumbnail taken from
//! yt-dlp metadata, and a channel avatar) and owns what they share: resolving the library
//! directory, the temp directory each run writes into, and persisting the result. The two ways
//! bytes actually arrive live next to it, because they have nothing in common with each other:
//! `fetch` goes over the network and owns every check on where a request may go, and `process`
//! runs yt-dlp and owns the process tree that comes with it.

mod fetch;
mod process;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use http::Uri;
use tauri::AppHandle;
use tokio::process::Command;

use crate::constants::THUMBNAIL_OUTPUT_FORMAT;
use crate::models::yt_dlp::YtDlpMetadata;
use crate::services::binaries::{
    ffmpeg_location_argument, resolve_ffmpeg_binary_async, resolve_yt_dlp_binary_async,
};
use crate::services::filesystem::{clean_matching_files_in_dir, find_best_matching_file};
use crate::services::library::paths::ensure_library_dir;
use crate::services::temp_paths::yt_dlp_thumb_temp_dir;
use crate::services::thumbnail::persist::persist_thumbnail_from_source;
use crate::services::thumbnail::url::is_allowed_thumbnail_image_host;
use crate::services::yt_dlp::url::is_allowed_youtube_url;
use crate::services::yt_dlp::{fetch_yt_dlp_metadata, sanitize_filename_component};
use crate::utils::naming::unique_temp_suffix;
use crate::utils::process::read_process_error;
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

use self::fetch::{
    assert_url_host_is_public, direct_image_extension, http_get_image, looks_like_supported_image,
    ALLOWED_THUMBNAIL_CONTENT_TYPES,
};
use self::process::{
    build_thumbnail_command_args, run_thumbnail_yt_dlp_with_timeout, ThumbnailTarget,
    THUMBNAIL_COMMAND_TIMEOUT_SECS,
};

/// Runs `persist_thumbnail_from_source` (full-file SHA-256 hashing plus a copy) on the
/// blocking thread pool, so this heavy I/O never runs directly on an async task.
async fn persist_thumbnail_from_source_async(
    source: PathBuf,
    library_dir: PathBuf,
) -> AppResult<String> {
    run_blocking(move || persist_thumbnail_from_source(&source, &library_dir)).await
}

/// Shared tail for the yt-dlp thumbnail flows (generic fallback, pre-download media thumbnail,
/// channel avatar): fails on a non-zero exit, locates the PNG yt-dlp wrote under
/// `file_name_prefix`, and persists it into the library (content-addressed). `subject`
/// distinguishes a `"thumbnail"` from a `"channel avatar"` in the error text, keeping the exact
/// messages the three call sites used before they were unified.
async fn finalize_thumbnail_download(
    output: &std::process::Output,
    thumb_temp_dir: &Path,
    file_name_prefix: &str,
    library_dir: PathBuf,
    subject: &str,
) -> AppResult<String> {
    if !output.status.success() {
        return Err(read_process_error(
            output,
            AppErrorCode::YtDlpThumbnailFailed,
            &format!("yt-dlp {subject} download failed"),
        ));
    }

    let downloaded_thumb = find_best_matching_file(
        thumb_temp_dir,
        file_name_prefix,
        Some(THUMBNAIL_OUTPUT_FORMAT),
    )
    .map_err(|_| {
        AppError::from_code(
            AppErrorCode::YtDlpThumbnailNotFound,
            format!("yt-dlp did not produce a {subject} file"),
        )
    })?;

    persist_thumbnail_from_source_async(downloaded_thumb, library_dir).await
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
        // A pasted URL is handed straight to yt-dlp (with access to browser cookies),
        // so it must be restricted to YouTube. Without this a compromised frontend, or a
        // user pasting an arbitrary URL into the handle field, could point yt-dlp at an
        // internal/loopback host, bypassing the SSRF guard used elsewhere.
        if !is_allowed_youtube_url(normalized) {
            return Err(AppError::from_code(
                AppErrorCode::InvalidUrl,
                "channel handle URL must point to YouTube",
            ));
        }

        return Ok(normalized.to_string());
    }

    if normalized.starts_with('@') {
        return Ok(format!("https://www.youtube.com/{normalized}"));
    }

    // The frontend also accepts and stores the `channel/UC...`, `c/name` and `user/name` forms
    // (see `normalizeYoutubeHandle` in src/utils/youtube.ts). These are path prefixes, not
    // handles, so they must be appended as-is; prefixing them with `@` (the fallback below)
    // would build a broken URL such as `https://www.youtube.com/@channel/UC...`.
    if normalized.starts_with("channel/")
        || normalized.starts_with("c/")
        || normalized.starts_with("user/")
    {
        return Ok(format!("https://www.youtube.com/{normalized}"));
    }

    Ok(format!("https://www.youtube.com/@{normalized}"))
}

/// Resolves the library directory and creates the fresh temp subdirectory a thumbnail/avatar run
/// writes into. Both steps are blocking filesystem work (`ensure_library_dir` canonicalizes,
/// `create_dir_all` touches disk), so callers invoke this through `run_blocking` off the async
/// runtime, matching the convention the rest of the app follows for filesystem calls. Returns the
/// canonical library directory and the created temp directory.
fn prepare_thumbnail_dirs(
    app: AppHandle,
    library_path: String,
    temp_dir_name: String,
) -> AppResult<(PathBuf, PathBuf)> {
    let library_dir = ensure_library_dir(&library_path)?;
    let thumb_temp_root = yt_dlp_thumb_temp_dir(&app)?;
    let thumb_temp_dir = thumb_temp_root.join(temp_dir_name);

    fs::create_dir_all(&thumb_temp_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateTempThumbDirFailed,
            format!("failed to create temporary thumbnail directory: {e}"),
        )
    })?;

    Ok((library_dir, thumb_temp_dir))
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

    let (library_dir, thumb_temp_dir) = {
        let app = app.clone();
        let library_path = library_path.to_string();
        let temp_dir_name = unique_temp_suffix();
        run_blocking(move || prepare_thumbnail_dirs(app, library_path, temp_dir_name)).await?
    };

    let result = async {
        if let Some(ext) = direct_image_extension(&normalized_url) {
            // Restrict the fetch to the image CDNs before it goes out, matching the host gate the
            // yt-dlp fallback below has always applied. `http_get_image`'s SSRF guard keeps this
            // off internal addresses and its size/content-type/magic-byte checks bound what comes
            // back, but all three constrain the *response*. None of them stopped the request from
            // reaching an arbitrary public host in the first place. See
            // services::thumbnail::url for the list and why it is not the yt-dlp one.
            //
            // This gates where the fetch starts; the same predicate is applied to every redirect
            // destination inside `http_get_image` (through `redirect::next_hop`), because for a
            // while this check alone read as a gate on the whole operation and was not one.
            let direct_uri: Uri = normalized_url.parse().map_err(|e| {
                AppError::from_code(AppErrorCode::InvalidUrl, format!("invalid url: {e}"))
            })?;

            if !is_allowed_thumbnail_image_host(&direct_uri) {
                return Err(AppError::from_code(
                    AppErrorCode::InvalidUrl,
                    "direct thumbnail download is restricted to the youtube image cdns",
                ));
            }

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

            if content_type.is_empty() {
                return Err(AppError::from_code(
                    AppErrorCode::YtDlpThumbnailFailed,
                    "thumbnail response is missing a content type",
                ));
            }

            if !ALLOWED_THUMBNAIL_CONTENT_TYPES.contains(&content_type.as_str()) {
                return Err(AppError::from_code(
                    AppErrorCode::YtDlpThumbnailFailed,
                    format!("unexpected content type for thumbnail: {content_type}"),
                ));
            }

            // The Content-Type header is attacker-controlled (any server the URL points to),
            // so it is only a first filter. Sniff the actual bytes against known image file
            // signatures before writing them to disk as an "image".
            if !looks_like_supported_image(&buffer) {
                return Err(AppError::from_code(
                    AppErrorCode::YtDlpThumbnailFailed,
                    "downloaded thumbnail does not look like a supported image",
                ));
            }

            let write_destination = direct_file_path.clone();

            run_blocking(move || {
                fs::write(&write_destination, &buffer).map_err(|e| {
                    AppError::from_code(
                        AppErrorCode::YtDlpThumbnailFailed,
                        format!("failed to write downloaded thumbnail: {e}"),
                    )
                })
            })
            .await?;

            return persist_thumbnail_from_source_async(direct_file_path, library_dir).await;
        }

        // The direct-image path above runs through http_get_image's SSRF guard. This yt-dlp
        // fallback has none, so validate the host here too: reject URLs that resolve to
        // loopback/private/link-local/reserved addresses before handing the URL to yt-dlp.
        let fallback_uri: Uri = normalized_url.parse().map_err(|e| {
            AppError::from_code(AppErrorCode::InvalidUrl, format!("invalid url: {e}"))
        })?;
        assert_url_host_is_public(&fallback_uri).await?;

        // yt-dlp's generic extractor is handed the URL with access to the user's browser
        // cookies (indirectly, via the same yt-dlp binary used elsewhere), so (like every
        // other yt-dlp invocation in this app), it must be restricted to YouTube. Without
        // this, a non-image URL would fall through to yt-dlp's generic extractor for any
        // host, which is far broader than this app ever intends to support.
        if !is_allowed_youtube_url(&normalized_url) {
            return Err(AppError::from_code(
                AppErrorCode::InvalidUrl,
                "generic thumbnail extraction is restricted to youtube urls",
            ));
        }

        let yt_dlp = resolve_yt_dlp_binary_async(app).await?;
        let ffmpeg = resolve_ffmpeg_binary_async(app).await?;
        let ffmpeg_location = ffmpeg_location_argument(&ffmpeg);

        let metadata = fetch_yt_dlp_metadata(&yt_dlp, &normalized_url, None, None, None).await?;

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

        let args = build_thumbnail_command_args(
            &ffmpeg_location,
            &thumb_temp_dir,
            &file_prefix,
            normalized_url.as_str(),
            ThumbnailTarget::SingleMedia,
            None,
            None,
        );

        let mut command = Command::new(&yt_dlp);
        command.args(&args);
        let output = run_thumbnail_yt_dlp_with_timeout(
            command,
            "yt-dlp thumbnail download timed out",
            "failed to execute yt-dlp for thumbnail download",
            None,
        )
        .await?;

        finalize_thumbnail_download(
            &output,
            &thumb_temp_dir,
            &file_name_prefix,
            library_dir,
            "thumbnail",
        )
        .await
    }
    .await;

    // Small (an image or two), but still filesystem IO on a possibly slow disk: offload the
    // recursive removal to the blocking pool like the download temp-dir cleanup does.
    let _ = run_blocking(move || {
        let _ = fs::remove_dir_all(&thumb_temp_dir);
        Ok::<(), AppError>(())
    })
    .await;

    result
}

pub async fn download_thumbnail_for_media_async(
    app: &AppHandle,
    media_url: &str,
    library_path: &str,
    metadata: &YtDlpMetadata,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
    cancel: Option<Arc<AtomicBool>>,
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

    let (library_dir, thumb_temp_dir) = {
        let app = app.clone();
        let library_path = library_path.to_string();
        let temp_dir_name = format!("media-thumb-{}", unique_temp_suffix());
        run_blocking(move || prepare_thumbnail_dirs(app, library_path, temp_dir_name)).await?
    };

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

        let args = build_thumbnail_command_args(
            &ffmpeg_location,
            &thumb_temp_dir,
            &file_prefix,
            normalized_url,
            ThumbnailTarget::SingleMedia,
            cookies_browser,
            cookies_path,
        );

        let mut command = Command::new(&yt_dlp);
        command.args(&args);

        let output = run_thumbnail_yt_dlp_with_timeout(
            command,
            "yt-dlp thumbnail download timed out",
            "failed to execute yt-dlp for thumbnail download",
            cancel.clone(),
        )
        .await?;

        finalize_thumbnail_download(
            &output,
            &thumb_temp_dir,
            &file_name_prefix,
            library_dir,
            "thumbnail",
        )
        .await
        .map(Some)
    }
    .await;

    // Small (an image or two), but still filesystem IO on a possibly slow disk: offload the
    // recursive removal to the blocking pool like the download temp-dir cleanup does.
    let _ = run_blocking(move || {
        let _ = fs::remove_dir_all(&thumb_temp_dir);
        Ok::<(), AppError>(())
    })
    .await;

    result
}

pub async fn download_channel_avatar_from_handle_async(
    app: &AppHandle,
    youtube_handle: &str,
    library_path: &str,
) -> AppResult<String> {
    let normalized_url = normalize_channel_handle_to_url(youtube_handle)?;

    let (library_dir, thumb_temp_dir) = {
        let app = app.clone();
        let library_path = library_path.to_string();
        let temp_dir_name = format!("channel-avatar-{}", unique_temp_suffix());
        run_blocking(move || prepare_thumbnail_dirs(app, library_path, temp_dir_name)).await?
    };

    let yt_dlp = resolve_yt_dlp_binary_async(app).await?;
    let ffmpeg = resolve_ffmpeg_binary_async(app).await?;
    let ffmpeg_location = ffmpeg_location_argument(&ffmpeg);

    let result = async {
        let file_prefix = "channel_avatar";
        let file_name_prefix = "channel_avatar.";

        clean_matching_files_in_dir(&thumb_temp_dir, file_name_prefix)?;

        let args = build_thumbnail_command_args(
            &ffmpeg_location,
            &thumb_temp_dir,
            file_prefix,
            normalized_url.as_str(),
            ThumbnailTarget::ChannelAvatar,
            None,
            None,
        );

        let mut command = Command::new(&yt_dlp);
        command.args(&args);
        let output = run_thumbnail_yt_dlp_with_timeout(
            command,
            "yt-dlp channel avatar download timed out",
            "failed to execute yt-dlp for channel avatar download",
            None,
        )
        .await?;

        finalize_thumbnail_download(
            &output,
            &thumb_temp_dir,
            file_name_prefix,
            library_dir,
            "channel avatar",
        )
        .await
    }
    .await;

    // Small (an image or two), but still filesystem IO on a possibly slow disk: offload the
    // recursive removal to the blocking pool like the download temp-dir cleanup does.
    let _ = run_blocking(move || {
        let _ = fs::remove_dir_all(&thumb_temp_dir);
        Ok::<(), AppError>(())
    })
    .await;

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_channel_handle_builds_youtube_url_from_handle() {
        assert_eq!(
            normalize_channel_handle_to_url("@Hardwareunboxed").unwrap(),
            "https://www.youtube.com/@Hardwareunboxed"
        );
        assert_eq!(
            normalize_channel_handle_to_url("Hardwareunboxed").unwrap(),
            "https://www.youtube.com/@Hardwareunboxed"
        );
    }

    #[test]
    fn normalize_channel_handle_builds_url_from_channel_c_and_user_prefixes() {
        // These prefixed forms are accepted and stored by the frontend
        // (normalizeYoutubeHandle); the backend must turn them into the matching path URL
        // instead of prefixing them with `@`.
        assert_eq!(
            normalize_channel_handle_to_url("channel/UCabcdEFGH1234567890xyzA").unwrap(),
            "https://www.youtube.com/channel/UCabcdEFGH1234567890xyzA"
        );
        assert_eq!(
            normalize_channel_handle_to_url("c/SomeChannel").unwrap(),
            "https://www.youtube.com/c/SomeChannel"
        );
        assert_eq!(
            normalize_channel_handle_to_url("user/LegacyName").unwrap(),
            "https://www.youtube.com/user/LegacyName"
        );
    }

    #[test]
    fn normalize_channel_handle_accepts_youtube_urls() {
        assert_eq!(
            normalize_channel_handle_to_url("https://www.youtube.com/@Hardwareunboxed").unwrap(),
            "https://www.youtube.com/@Hardwareunboxed"
        );
    }

    #[test]
    fn normalize_channel_handle_rejects_non_youtube_urls() {
        for url in [
            "http://127.0.0.1/x.png",
            "http://169.254.169.254/latest/meta-data",
            "http://192.168.1.1/admin",
            "https://attacker.example/@handle",
            "https://youtube.com.evil.com/@handle",
            "https://youtube.com@evil.com/",
        ] {
            assert!(
                normalize_channel_handle_to_url(url).is_err(),
                "{url} should be rejected"
            );
        }
    }
}
