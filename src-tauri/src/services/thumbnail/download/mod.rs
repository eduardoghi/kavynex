//! Downloading a thumbnail or a channel avatar into the library.
//!
//! This module orchestrates the three flows (a direct image URL, a media's thumbnail taken from
//! yt-dlp metadata, and a channel avatar) and owns what they share. Resolving the library
//! directory, the temp directory each run writes into, and persisting the result. The two ways
//! bytes actually arrive live next to it, because they have nothing in common with each other.
//! `fetch` goes over the network and owns every check on where a request may go, and `process`
//! runs yt-dlp and owns the process tree that comes with it.

mod fetch;
mod process;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use http::Uri;
use tauri::{AppHandle, Runtime};
use tokio::process::Command;

use crate::constants::THUMBNAIL_OUTPUT_FORMAT;
use crate::models::yt_dlp::{YtDlpMetadata, YtDlpThumbnailMetadata};
use crate::services::binaries::{
    ffmpeg_location_argument, resolve_ffmpeg_binary_async, resolve_yt_dlp_binary_async,
};
use crate::services::filesystem::{clean_matching_files_in_dir, find_best_matching_file};
use crate::services::library::paths::resolve_existing_library_dir;
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
    assert_url_host_is_public, direct_image_extension, http_get_image,
    ALLOWED_THUMBNAIL_CONTENT_TYPES,
};
use self::process::{
    build_thumbnail_command_args, run_thumbnail_yt_dlp_with_timeout, ThumbnailTarget,
    THUMBNAIL_COMMAND_TIMEOUT_SECS,
};
use crate::utils::format::looks_like_supported_image;

/// Runs `persist_thumbnail_from_source` (full-file SHA-256 hashing plus a copy) on the
/// blocking thread pool, so this heavy I/O never runs directly on an async task.
async fn persist_thumbnail_from_source_async(
    source: PathBuf,
    library_dir: PathBuf,
) -> AppResult<String> {
    run_blocking(move || persist_thumbnail_from_source(&source, &library_dir)).await
}

/// Shared tail for the yt-dlp thumbnail flows (generic fallback, pre-download media thumbnail,
/// channel avatar). Fails on a non-zero exit, locates the PNG yt-dlp wrote under
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
            // Neither flow passes cookies, and the URL is a public one the user entered.
            str::to_string,
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

/// Turns a stored/typed channel handle into the URL yt-dlp is asked to extract from.
///
/// Every exit goes through `is_allowed_youtube_url`, including the branches that *build* the URL
/// rather than receive one. That single gate is the point rather than a formality. The pasted-URL
/// branch was checked and the four constructed branches were not, on the reasonable grounds that a
/// literal `https://www.youtube.com/` prefix fixes the authority. It does, but that is a property of
/// string formatting rather than a check, nothing asserted it, and the value reaching this function
/// is not always a validated handle. `download_channel_avatar_from_handle` takes it straight from
/// IPC without running `utils::validation::ensure_valid_youtube_handle` at all, so this is the only
/// gate on that path. The rule the rest of the backend states, that every URL handed to yt-dlp
/// passes the host allow-list, now holds here by construction instead of by argument.
///
/// One consequence worth naming. A handle that cannot be parsed as a URI at all (an embedded space,
/// a control character, a stray `[`) is now refused here instead of being handed to yt-dlp to fail
/// on. Real handles are unaffected. YouTube's own `@name`, `c/` and `user/` forms carry none of
/// those, and the refusal is the clearer of the two failures.
fn normalize_channel_handle_to_url(youtube_handle: &str) -> AppResult<String> {
    let normalized = youtube_handle.trim();

    if normalized.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidUrl,
            "youtube handle is empty",
        ));
    }

    let candidate = if normalized.starts_with("http://") || normalized.starts_with("https://") {
        // A pasted URL is handed straight to yt-dlp (with access to browser cookies), so it must be
        // restricted to YouTube. Without this a compromised frontend, or a user pasting an arbitrary
        // URL into the handle field, could point yt-dlp at an internal/loopback host, bypassing the
        // SSRF guard used elsewhere. Passed through unchanged for the gate below to judge.
        normalized.to_string()
    } else if normalized.starts_with('@')
        // The frontend also accepts and stores the `channel/UC...`, `c/name` and `user/name` forms
        // (see `normalizeYoutubeHandle` in src/utils/youtube.ts). These are path prefixes, not
        // handles, so they must be appended as-is; prefixing them with `@` (the fallback below)
        // would build a broken URL such as `https://www.youtube.com/@channel/UC...`.
        || normalized.starts_with("channel/")
        || normalized.starts_with("c/")
        || normalized.starts_with("user/")
    {
        format!("https://www.youtube.com/{normalized}")
    } else {
        format!("https://www.youtube.com/@{normalized}")
    };

    if !is_allowed_youtube_url(&candidate) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidUrl,
            "channel handle must resolve to a YouTube URL",
        ));
    }

    Ok(candidate)
}

/// Resolves the library directory and creates the fresh temp subdirectory a thumbnail/avatar run
/// writes into. Both steps are blocking filesystem work (`resolve_existing_library_dir` canonicalizes,
/// `create_dir_all` touches disk), so callers invoke this through `run_blocking` off the async
/// runtime, matching the convention the rest of the app follows for filesystem calls. Returns the
/// canonical library directory and the created temp directory.
fn prepare_thumbnail_dirs<R: Runtime>(
    app: AppHandle<R>,
    library_path: String,
    temp_dir_name: String,
) -> AppResult<(PathBuf, PathBuf)> {
    let library_dir = resolve_existing_library_dir(&library_path)?;
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

pub async fn download_thumbnail_from_url_async<R: Runtime>(
    app: &AppHandle<R>,
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

            // Cleartext is refused here rather than by `direct_image_extension` returning None,
            // which is the tempting place for it and the wrong one. That function decides which of
            // the two branches handles a URL, so a None would route `http://cdn/x.jpg` into the
            // yt-dlp fallback, which refuses it for a different reason ("must be a YouTube URL")
            // and points whoever reads the error at the wrong list. The scheme is a policy about
            // this branch, so it is refused on this branch, beside the host gate that answers the
            // other half of "may this fetch start at all".
            //
            // `http_get_image`'s connector is `https_only()` regardless, so this is the message
            // rather than the enforcement. Redirect hops are gated separately, on the resolved
            // destination, in `thumbnail::redirect::next_hop`.
            if direct_uri.scheme_str() != Some("https") {
                return Err(AppError::from_code(
                    AppErrorCode::InvalidUrl,
                    "direct thumbnail download requires https",
                ));
            }

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
        // fallback has none, so validate the host here too. Reject URLs that resolve to
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
        // Starts in the thumbnail scratch directory the output goes to rather than wherever the
        // app was launched from (see utils::process::pin_working_dir_async).
        crate::utils::process::pin_working_dir_async(&mut command, &thumb_temp_dir);
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

    // Small (an image or two), but still filesystem IO on a possibly slow disk. Offload the
    // recursive removal to the blocking pool like the download temp-dir cleanup does.
    let _ = run_blocking(move || {
        let _ = fs::remove_dir_all(&thumb_temp_dir);
        Ok::<(), AppError>(())
    })
    .await;

    result
}

/// How many of a media's thumbnail candidates are tried before it is saved without one. Each try is
/// one HTTP request, and the list is ordered so the first normally succeeds.
pub(crate) const MAX_MEDIA_THUMBNAIL_ATTEMPTS: usize = 4;

/// The URLs to try for a media's thumbnail, best first.
///
/// Only thumbnails YouTube declared (the ones yt-dlp reports a width for) and the metadata's own
/// `thumbnail` are tried. The others are yt-dlp's guesses, and on an older video every guess above
/// the declared size is a 404. Within that, JPEG comes first because it is the format the library
/// stores (`THUMBNAIL_OUTPUT_FORMAT`), and YouTube serves every declared image as JPEG as well as
/// WebP. The JPEG of the largest size is usually smaller than the WebP above it (1280x720 against
/// 1920x1080 on a recent upload), which a card drawn a few hundred pixels wide never shows.
///
/// URLs are deduplicated by path, ignoring the query. YouTube declares the same `hqdefault.jpg` at
/// five sizes that differ only in their query string, and spending the fallbacks on one image would
/// leave none for a different one. The first spelling kept is the largest.
///
/// Pure, so the ordering can be pinned against the shape real yt-dlp output has. Every URL that
/// survives is one the direct fetch accepts (https, an image extension, an allowed CDN host), so a
/// candidate can never fall through to a yt-dlp run.
pub(crate) fn media_thumbnail_candidates(
    thumbnail: Option<&str>,
    thumbnails: &[YtDlpThumbnailMetadata],
) -> Vec<String> {
    let declared: Vec<&str> = thumbnails
        .iter()
        .rev()
        .filter(|entry| entry.width.is_some())
        .filter_map(|entry| entry.url.as_deref())
        .collect();

    let is_jpeg = |url: &&str| matches!(direct_image_extension(url), Some("jpg" | "jpeg"));

    let ordered = declared
        .iter()
        .copied()
        .filter(is_jpeg)
        .chain(thumbnail)
        .chain(declared.iter().copied().filter(|url| !is_jpeg(url)));

    let without_query = |url: &str| url.split(['?', '#']).next().unwrap_or(url).to_string();
    let mut candidates: Vec<String> = Vec::new();

    for url in ordered.map(str::trim) {
        let resource = without_query(url);

        if !is_direct_thumbnail_url(url)
            || candidates
                .iter()
                .any(|seen| without_query(seen) == resource)
        {
            continue;
        }

        candidates.push(url.to_string());
    }

    candidates.truncate(MAX_MEDIA_THUMBNAIL_ATTEMPTS);
    candidates
}

/// True for a URL the direct fetch in [`download_thumbnail_from_url_async`] accepts without falling
/// back to yt-dlp. https, an image extension, and one of the allowed image CDNs.
fn is_direct_thumbnail_url(url: &str) -> bool {
    let Ok(uri) = url.parse::<Uri>() else {
        return false;
    };

    uri.scheme_str() == Some("https")
        && direct_image_extension(url).is_some()
        && is_allowed_thumbnail_image_host(&uri)
}

/// Downloads a media's thumbnail straight from YouTube's image CDN, trying
/// [`media_thumbnail_candidates`] in order until one is stored.
///
/// A direct request rather than a yt-dlp run. yt-dlp has already reported the URLs, so asking it
/// again meant one more full extraction of the video, with the user's cookies, for an image the CDN
/// serves to anyone. `Ok(None)` when there is nothing to try or the run was cancelled before a try;
/// otherwise the last failure.
pub async fn download_media_thumbnail_async<R: Runtime>(
    app: &AppHandle<R>,
    library_path: &str,
    metadata: &YtDlpMetadata,
    cancel: Option<&AtomicBool>,
) -> AppResult<Option<String>> {
    let candidates =
        media_thumbnail_candidates(metadata.thumbnail.as_deref(), &metadata.thumbnails);
    let mut last_error = None;

    for url in candidates {
        if cancel.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::SeqCst)) {
            break;
        }

        match download_thumbnail_from_url_async(app, &url, library_path).await {
            Ok(path) => return Ok(Some(path)),
            Err(error) => last_error = Some(error),
        }
    }

    match last_error {
        Some(error) => Err(error),
        None => Ok(None),
    }
}

pub async fn download_channel_avatar_from_handle_async<R: Runtime>(
    app: &AppHandle<R>,
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
        // Starts in the thumbnail scratch directory the output goes to rather than wherever the
        // app was launched from (see utils::process::pin_working_dir_async).
        crate::utils::process::pin_working_dir_async(&mut command, &thumb_temp_dir);
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

    // Small (an image or two), but still filesystem IO on a possibly slow disk. Offload the
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

    #[test]
    fn every_built_url_passes_the_host_allow_list() {
        // The gate this function's exit now goes through, asserted over the four branches that
        // *construct* a URL rather than receive one. Those were unchecked, on the grounds that the
        // literal prefix fixes the authority, and nothing said so. This is what says so. Whatever a
        // branch builds, the host allow-list is what lets it out. Covers the shapes a caller could
        // use to try to steer the authority (a leading slash, a userinfo `@`, a protocol-relative
        // prefix, a backslash), all of which stay on www.youtube.com as path or query.
        for handle in [
            "@Hardwareunboxed",
            "Hardwareunboxed",
            "channel/UCabcdEFGH1234567890xyzA",
            "c/SomeChannel",
            "user/LegacyName",
            "channel/UC/with/slashes",
            "//evil.example/x",
            "@evil.example",
            "/evil.example",
            "c//evil.example/",
            "@x?redirect=https://evil.example",
            "@x#evil.example",
            // Brackets are only special in the authority (an IPv6 literal), so in a path they
            // parse and stay on-host. Kept here rather than among the refusals because that is
            // the safe outcome, and because it is the near-miss most likely to be assumed hostile.
            "channel/UC[brackets]",
        ] {
            let url = normalize_channel_handle_to_url(handle)
                .unwrap_or_else(|error| panic!("{handle} should build a url, got {error:?}"));

            assert!(
                is_allowed_youtube_url(&url),
                "{handle} built {url}, which the host allow-list must accept"
            );
            assert!(
                url.starts_with("https://www.youtube.com/"),
                "{handle} built {url}, which must stay on the youtube host"
            );
        }
    }

    #[test]
    fn normalize_channel_handle_refuses_a_handle_that_cannot_form_a_uri() {
        // The behavior change the single gate brings. A handle carrying a character no URI may hold
        // fails to parse, so the allow-list refuses it here rather than yt-dlp failing on it later.
        // No real YouTube handle looks like this, and a clear refusal beats a confusing extractor
        // error. Named so the trade is visible if a legitimate handle ever lands in this class.
        for handle in [
            "user/legacy name",
            "c/name\nwith-newline",
            "@name\twith-tab",
        ] {
            assert!(
                normalize_channel_handle_to_url(handle).is_err(),
                "{handle} should be refused: it cannot form a URI"
            );
        }
    }

    /// A `thumbnails` entry as yt-dlp reports it. `width` is present only on the ones YouTube
    /// declared, absent on the URLs yt-dlp guesses at.
    fn entry(url: &str, width: Option<u64>) -> YtDlpThumbnailMetadata {
        YtDlpThumbnailMetadata {
            url: Some(url.to_string()),
            width,
        }
    }

    #[test]
    fn an_older_video_is_never_asked_for_the_sizes_youtube_did_not_declare() {
        // The shape of `yt-dlp -J` for a 2005 upload, captured in October 2026. Every guessed
        // URL above the declared 480x360 answered 404 when probed, including both maxresdefault
        // spellings, so trying them first would spend every attempt on a miss.
        let declared = "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?sqp=480";
        let thumbnails = [
            entry(
                "https://i.ytimg.com/vi/jNQXAC9IVRw/mqdefault.jpg?sqp=320",
                Some(320),
            ),
            entry(
                "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?sqp=168",
                Some(168),
            ),
            entry(
                "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?sqp=336",
                Some(336),
            ),
            entry(declared, Some(480)),
            entry(
                "https://i.ytimg.com/vi_webp/jNQXAC9IVRw/hqdefault.webp",
                None,
            ),
            entry("https://i.ytimg.com/vi/jNQXAC9IVRw/sddefault.jpg", None),
            entry("https://i.ytimg.com/vi/jNQXAC9IVRw/maxresdefault.jpg", None),
            entry(
                "https://i.ytimg.com/vi_webp/jNQXAC9IVRw/maxresdefault.webp",
                None,
            ),
        ];

        let candidates = media_thumbnail_candidates(Some(declared), &thumbnails);

        // The two smaller spellings of hqdefault are the same image, so the fallback after the
        // largest one is a different image rather than a smaller copy of the one that just failed.
        assert_eq!(
            candidates,
            vec![
                declared.to_string(),
                "https://i.ytimg.com/vi/jNQXAC9IVRw/mqdefault.jpg?sqp=320".to_string(),
            ]
        );
    }

    #[test]
    fn a_recent_video_tries_the_largest_jpeg_before_the_webp_the_metadata_names() {
        // Also captured shape. The metadata's `thumbnail` is the 1920x1080 WebP, and YouTube
        // declares the same image as a 1280x720 JPEG. The library stores JPEG, so the JPEG is
        // tried first and the WebP stays as the fallback.
        let webp = "https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/maxresdefault.webp";
        let thumbnails = [
            entry(
                "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
                Some(480),
            ),
            entry("https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg", Some(1280)),
            entry(
                "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
                Some(1280),
            ),
            entry(webp, Some(1920)),
        ];

        let candidates = media_thumbnail_candidates(Some(webp), &thumbnails);

        assert_eq!(
            candidates,
            vec![
                "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg".to_string(),
                "https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg".to_string(),
                "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg".to_string(),
                webp.to_string(),
            ]
        );
    }

    #[test]
    fn the_metadata_thumbnail_alone_is_still_tried() {
        // Metadata without a `thumbnails` list (older yt-dlp, a trimmed fixture) still has the one
        // URL the previous flow relied on.
        let url = "https://i.ytimg.com/vi/abc/hqdefault.jpg";

        assert_eq!(
            media_thumbnail_candidates(Some(url), &[]),
            vec![url.to_string()]
        );
        assert!(media_thumbnail_candidates(None, &[]).is_empty());
    }

    #[test]
    fn only_urls_the_direct_fetch_accepts_become_candidates() {
        // Anything else would reach the yt-dlp fallback in download_thumbnail_from_url_async, which
        // is the extra extraction this exists to avoid, or be refused there anyway.
        let thumbnails = [
            entry("http://i.ytimg.com/vi/abc/plain-http.jpg", Some(1)),
            entry("https://attacker.example/vi/abc/elsewhere.jpg", Some(1)),
            entry("https://i.ytimg.com/vi/abc/no-extension", Some(1)),
            entry("not a url", Some(1)),
            entry("https://i.ytimg.com/vi/abc/kept.jpg", Some(1)),
        ];

        assert_eq!(
            media_thumbnail_candidates(None, &thumbnails),
            vec!["https://i.ytimg.com/vi/abc/kept.jpg".to_string()]
        );
    }

    #[test]
    fn a_url_listed_twice_is_tried_once_and_the_list_is_capped() {
        let thumbnails: Vec<YtDlpThumbnailMetadata> = (0..10)
            .map(|index| {
                entry(
                    &format!("https://i.ytimg.com/vi/abc/{index}.jpg"),
                    Some(index),
                )
            })
            .collect();

        let candidates =
            media_thumbnail_candidates(Some("https://i.ytimg.com/vi/abc/9.jpg"), &thumbnails);

        assert_eq!(candidates.len(), MAX_MEDIA_THUMBNAIL_ATTEMPTS);
        assert_eq!(candidates[0], "https://i.ytimg.com/vi/abc/9.jpg");
        assert_eq!(
            candidates
                .iter()
                .filter(|url| url.ends_with("/9.jpg"))
                .count(),
            1
        );
    }

    #[test]
    fn the_attempt_cap_is_four() {
        // Pinned by value. Every attempt is a request, and an older video's list holds dozens of
        // URLs, so a slip here is either a wasted burst at the CDN or no fallback at all.
        assert_eq!(MAX_MEDIA_THUMBNAIL_ATTEMPTS, 4);
    }

    #[test]
    fn a_media_with_no_candidate_or_a_cancelled_run_asks_the_network_for_nothing() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();

        let empty = YtDlpMetadata::default();
        let none = tauri::async_runtime::block_on(download_media_thumbnail_async(
            app.handle(),
            "/library",
            &empty,
            None,
        ));
        assert!(matches!(none, Ok(None)));

        let with_a_candidate = YtDlpMetadata {
            thumbnail: Some("https://i.ytimg.com/vi/abc/hqdefault.jpg".to_string()),
            ..YtDlpMetadata::default()
        };
        let cancelled = AtomicBool::new(true);
        let skipped = tauri::async_runtime::block_on(download_media_thumbnail_async(
            app.handle(),
            "/library",
            &with_a_candidate,
            Some(&cancelled),
        ));
        assert!(matches!(skipped, Ok(None)));
    }
}
