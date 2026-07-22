use std::fs;
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use http::Uri;
use http_body_util::{BodyExt, Empty};
use hyper::body::Bytes;
use hyper_util::client::legacy::connect::dns::Name;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use tauri::AppHandle;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::net::lookup_host;
use tokio::process::Command;
use tokio::time::timeout;
use tower_service::Service;

use crate::models::yt_dlp::YtDlpMetadata;
use crate::services::binaries::{
    ffmpeg_location_argument, resolve_ffmpeg_binary_async, resolve_yt_dlp_binary_async,
};
use crate::services::filesystem::{clean_matching_files_in_dir, find_best_matching_file};
use crate::services::library_paths::ensure_library_dir;
use crate::services::ssrf_guard::is_disallowed_ip;
use crate::services::temp_paths::yt_dlp_thumb_temp_dir;
use crate::services::thumbnail_persist::persist_thumbnail_from_source;
use crate::services::yt_dlp::{fetch_yt_dlp_metadata, sanitize_filename_component};
use crate::services::yt_dlp_cookies::append_auth_args;
use crate::services::yt_dlp_url::is_allowed_youtube_url;
use crate::utils::naming::unique_temp_suffix;
use crate::utils::process::{hide_console_async, read_process_error};
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

/// Cap on how much stdout/stderr is retained from a yt-dlp thumbnail/avatar run. These commands
/// are far less chatty than a full download, but `wait_with_output` would buffer their entire
/// output unbounded; this keeps memory (and the error detail built from it) bounded while still
/// draining the pipes fully so the child can exit - a cap that stopped reading would deadlock a
/// child that outran it.
const MAX_PROCESS_OUTPUT_BYTES: usize = 1024 * 1024; // 1 MiB per stream

/// Drains an async pipe to its end, retaining at most `max_bytes`. Bytes past the cap are read and
/// discarded rather than left unread, so the child never blocks on a full pipe.
async fn read_drain_capped_async(
    stream: Option<impl AsyncRead + Unpin>,
    max_bytes: usize,
) -> Vec<u8> {
    let mut buffer: Vec<u8> = Vec::new();

    let Some(mut stream) = stream else {
        return buffer;
    };

    let mut chunk = [0u8; 8192];

    loop {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if buffer.len() < max_bytes {
                    let take = (max_bytes - buffer.len()).min(read);
                    buffer.extend_from_slice(&chunk[..take]);
                }
            }
        }
    }

    buffer
}

/// `Child::wait_with_output` with each stream capped at `MAX_PROCESS_OUTPUT_BYTES`. Reads both
/// pipes concurrently with the wait so neither can deadlock the other (mirroring std's own
/// implementation), but bounded.
async fn wait_with_capped_output(
    mut child: tokio::process::Child,
) -> std::io::Result<std::process::Output> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let (status, stdout_buf, stderr_buf) = tokio::join!(
        child.wait(),
        read_drain_capped_async(stdout, MAX_PROCESS_OUTPUT_BYTES),
        read_drain_capped_async(stderr, MAX_PROCESS_OUTPUT_BYTES),
    );

    Ok(std::process::Output {
        status: status?,
        stdout: stdout_buf,
        stderr: stderr_buf,
    })
}

/// Runs a yt-dlp thumbnail/avatar command under the shared timeout, capturing its output.
///
/// These invocations pass `--convert-thumbnails png`, which makes yt-dlp spawn an `ffmpeg`
/// child. Relying on `kill_on_drop` alone (as the previous `.output()` call did) only kills
/// the direct yt-dlp child on timeout, leaving that ffmpeg grandchild running and holding the
/// temp directory open. Spawning into its own process group and killing the whole tree on
/// timeout - the same mechanism the main download path uses - prevents the orphan.
async fn run_thumbnail_yt_dlp_with_timeout(
    mut command: Command,
    timeout_message: &str,
    exec_message: &str,
    cancel: Option<Arc<AtomicBool>>,
) -> AppResult<std::process::Output> {
    // Any early return still reaps the direct child; the tree kill below covers the ffmpeg
    // grandchild that `kill_on_drop` does not reach.
    command.kill_on_drop(true);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_console_async(&mut command);
    crate::utils::process::configure_process_group(&mut command);

    let child = command.spawn().map_err(|e| {
        AppError::from_code(
            AppErrorCode::YtDlpThumbnailExecFailed,
            format!("{exec_message}: {e}"),
        )
    })?;
    let child_pid = child.id();
    // Track this yt-dlp thumbnail/avatar child (and its ffmpeg grandchild via the tree kill)
    // globally so the app-exit handler terminates it too; these run outside the per-download
    // registry (the standalone thumbnail/avatar paths) or before its child pid is recorded
    // (the pre-download media thumbnail). Unregisters when this function returns.
    let _tracked_child = crate::services::process_registry::TrackedChildGuard::register(child_pid);

    tokio::select! {
        output_result = timeout(
            Duration::from_secs(THUMBNAIL_COMMAND_TIMEOUT_SECS),
            wait_with_capped_output(child),
        ) => match output_result {
            Ok(result) => result.map_err(|e| {
                AppError::from_code(
                    AppErrorCode::YtDlpThumbnailExecFailed,
                    format!("{exec_message}: {e}"),
                )
            }),
            Err(_) => {
                if let Some(pid) = child_pid {
                    crate::utils::process::kill_process_tree(pid).await;
                }

                Err(AppError::from_code(
                    AppErrorCode::YtDlpThumbnailTimeout,
                    timeout_message.to_string(),
                ))
            }
        },
        _ = crate::utils::process::wait_for_cancel(cancel.as_deref()) => {
            // The download was cancelled while this bounded thumbnail phase was still running:
            // kill the whole tree now rather than blocking cancellation until the timeout. Only
            // reached for the media-thumbnail path (which passes the run's cancel flag); the
            // standalone and avatar paths pass None, so this branch pends forever.
            if let Some(pid) = child_pid {
                crate::utils::process::kill_process_tree(pid).await;
            }

            Err(AppError::from_code(
                AppErrorCode::YtDlpDownloadCancelled,
                "yt-dlp download cancelled",
            ))
        }
    }
}

const THUMBNAIL_COMMAND_TIMEOUT_SECS: u64 = 60;
const DIRECT_THUMBNAIL_MAX_BYTES: usize = 10 * 1024 * 1024; // 10 MiB
const DIRECT_THUMBNAIL_MAX_REDIRECTS: usize = 10;

const ALLOWED_THUMBNAIL_CONTENT_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/bmp",
    "image/avif",
    "image/gif",
];

/// What a thumbnail fetch is pointed at, which decides how yt-dlp treats playlists.
#[derive(Clone, Copy)]
enum ThumbnailTarget {
    /// A single video or direct media URL: `--no-playlist`, so only that entry is considered.
    SingleMedia,
    /// A channel URL: `--playlist-items 0`, so no video is enumerated and only the
    /// channel-level thumbnail (the avatar) is written.
    ChannelAvatar,
}

/// Builds the yt-dlp argument vector for writing a thumbnail (converted to PNG) into
/// `temp_dir` under `file_prefix`.
///
/// Extracted as a pure function so the three thumbnail flows (direct-URL fallback,
/// pre-download media thumbnail, channel avatar) share one definition instead of three
/// near-identical inline vectors, and so the argv can be asserted in tests without spawning a
/// process. The URL is always last and always immediately preceded by `--`, so it can never be
/// reinterpreted as a flag.
fn build_thumbnail_command_args(
    ffmpeg_location: &str,
    temp_dir: &Path,
    file_prefix: &str,
    url: &str,
    target: ThumbnailTarget,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
) -> Vec<String> {
    let mut args = vec!["--ignore-config".to_string()];

    match target {
        ThumbnailTarget::SingleMedia => args.push("--no-playlist".to_string()),
        ThumbnailTarget::ChannelAvatar => {
            args.push("--playlist-items".to_string());
            args.push("0".to_string());
        }
    }

    args.extend([
        "--skip-download".to_string(),
        "--write-thumbnail".to_string(),
        "--convert-thumbnails".to_string(),
        "png".to_string(),
        "--restrict-filenames".to_string(),
        "--windows-filenames".to_string(),
        "--no-warnings".to_string(),
        "--ffmpeg-location".to_string(),
        ffmpeg_location.to_string(),
        "--paths".to_string(),
        format!("home:{}", temp_dir.to_string_lossy()),
        "-o".to_string(),
        format!("{}.%(ext)s", file_prefix),
    ]);

    append_auth_args(&mut args, cookies_browser, cookies_path);
    args.push("--".to_string());
    args.push(url.to_string());

    args
}

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

/// The DNS resolver the thumbnail HTTP client connects through. It resolves the host and drops
/// every private/loopback/reserved address before returning, so the connection can only ever dial
/// a public IP. Because HttpConnector dials exactly what this resolver returns, the address that is
/// validated *is* the address that is dialed - which is what `assert_url_host_is_public`, running as
/// a separate pre-connection check, cannot guarantee on its own: between that check and the
/// connector's own resolution an attacker controlling the host's DNS could rebind a public answer to
/// an internal one. Pinning resolution here closes that window. The pre-check is still run first for
/// a clear early error and because HttpConnector skips the resolver for an IP-literal host (which the
/// pre-check does cover).
#[derive(Clone)]
struct PublicOnlyResolver;

impl Service<Name> for PublicOnlyResolver {
    type Response = std::vec::IntoIter<SocketAddr>;
    type Error = io::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, io::Error>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), io::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, name: Name) -> Self::Future {
        let host = name.as_str().to_string();

        Box::pin(async move {
            // Port 0: HttpConnector overrides it with the request URI's port (set_port).
            let allowed: Vec<SocketAddr> = lookup_host((host.as_str(), 0))
                .await?
                .filter(|addr| !is_disallowed_ip(&addr.ip()))
                .collect();

            if allowed.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "host resolves only to private, loopback or reserved addresses",
                ));
            }

            Ok(allowed.into_iter())
        })
    }
}

/// Downloads `url` over HTTPS (or HTTP), follows up to DIRECT_THUMBNAIL_MAX_REDIRECTS
/// redirects, streams the body with a hard cap of DIRECT_THUMBNAIL_MAX_BYTES, and
/// validates Content-Type when present. Returns (status, headers, body). The entire
/// operation (DNS revalidation, headers, redirects and the body stream) runs under a
/// single `timeout_secs` deadline, so a slow-drip server cannot stall it under the size cap.
///
/// This uses a hand-rolled hyper client on purpose, rather than `reqwest` (which is already in
/// the tree transitively via the updater plugin). The reason is the redirect loop below: it
/// follows redirects *manually* so it can re-run the SSRF guard - `assert_url_host_is_public`,
/// which rejects a host resolving to a private/loopback/link-local/reserved address - on the
/// initial URL **and on every redirect target**. A client that follows redirects automatically
/// (reqwest's default) would only let us vet the first hop, so a public thumbnail URL that
/// 302-redirects to, say, `http://169.254.169.254/...` or an internal host would slip past the
/// check. The thumbnail URL comes from yt-dlp metadata (attacker-influenced), so that per-hop
/// revalidation is the whole point; keeping this on a minimal hyper stack also avoids pulling
/// reqwest's cookie jar and automatic-redirect behavior into a request that must stay dumb.
async fn http_get_image(
    url: &str,
    timeout_secs: u64,
) -> AppResult<(http::StatusCode, http::HeaderMap, Vec<u8>)> {
    let mut http_connector = HttpConnector::new_with_resolver(PublicOnlyResolver);
    // Required so the connector accepts the `https` scheme. hyper-rustls sets this on the default
    // connector its own `build()` produces; a wrapped connector must set it explicitly.
    http_connector.enforce_http(false);

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
        .wrap_connector(http_connector);

    let client: Client<_, Empty<Bytes>> = Client::builder(TokioExecutor::new()).build(connector);

    let mut uri: Uri = url
        .parse()
        .map_err(|e| AppError::from_code(AppErrorCode::InvalidUrl, format!("invalid url: {e}")))?;

    // Bound the whole operation - DNS revalidation, header exchange, every redirect hop and the
    // body stream - under a single deadline. The earlier per-request timeout only covered the
    // header phase, so a server that dribbled the body out slowly could hold the read loop open
    // indefinitely while staying under the DIRECT_THUMBNAIL_MAX_BYTES cap. This command carries no
    // cancel flag, so this deadline is the only thing that can end such a stall.
    timeout(Duration::from_secs(timeout_secs), async move {
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

            let res = client.request(req).await.map_err(|e| {
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
    })
    .await
    .map_err(|_| {
        AppError::from_code(
            AppErrorCode::YtDlpThumbnailTimeout,
            "thumbnail download timed out",
        )
    })?
}

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

    let downloaded_thumb = find_best_matching_file(thumb_temp_dir, file_name_prefix, Some("png"))
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

    if normalized.ends_with(".gif") {
        return Some("gif");
    }

    None
}

/// Sniffs `bytes` against the magic numbers of the image formats this app accepts. The
/// Content-Type header on a direct thumbnail download is attacker-controlled (any server the
/// URL points to), so it is not sufficient on its own to prove the bytes are actually an
/// image before they are written to disk and later served from the library.
fn looks_like_supported_image(bytes: &[u8]) -> bool {
    const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    const JPEG_SIGNATURE: &[u8] = b"\xFF\xD8\xFF";
    const GIF_SIGNATURE: &[u8] = b"GIF8";
    const BMP_SIGNATURE: &[u8] = b"BM";

    if bytes.starts_with(PNG_SIGNATURE)
        || bytes.starts_with(JPEG_SIGNATURE)
        || bytes.starts_with(GIF_SIGNATURE)
        || bytes.starts_with(BMP_SIGNATURE)
    {
        return true;
    }

    // WEBP: a RIFF container with a "WEBP" fourCC at offset 8.
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return true;
    }

    // AVIF: an ISOBMFF `ftyp` box (offset 4) whose brand (offset 8) is avif/avis.
    if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis")
    {
        return true;
    }

    false
}

/// Resolves the library directory and creates the fresh temp subdirectory a thumbnail/avatar run
/// writes into. Both steps are blocking filesystem work (`ensure_library_dir` canonicalizes,
/// `create_dir_all` touches disk), so callers invoke this through `run_blocking` off the async
/// runtime - matching the convention the rest of the app follows for filesystem calls. Returns the
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
        // cookies (indirectly, via the same yt-dlp binary used elsewhere), so - like every
        // other yt-dlp invocation in this app - it must be restricted to YouTube. Without
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

    fn uri(s: &str) -> Uri {
        s.parse().unwrap()
    }

    #[test]
    fn looks_like_supported_image_accepts_known_signatures() {
        assert!(looks_like_supported_image(b"\x89PNG\r\n\x1a\nrest-of-file"));
        assert!(looks_like_supported_image(b"\xFF\xD8\xFFrest-of-file"));
        assert!(looks_like_supported_image(b"GIF89arest-of-file"));
        assert!(looks_like_supported_image(b"BMrest-of-file"));
        assert!(looks_like_supported_image(b"RIFF\x00\x00\x00\x00WEBPrest"));
        assert!(looks_like_supported_image(b"\x00\x00\x00\x18ftypavifrest"));
        assert!(looks_like_supported_image(b"\x00\x00\x00\x18ftypavisrest"));
    }

    #[test]
    fn looks_like_supported_image_rejects_arbitrary_bytes() {
        assert!(!looks_like_supported_image(b"not an image, just text"));
        assert!(!looks_like_supported_image(b"<html><body>evil</body>"));
        assert!(!looks_like_supported_image(b"RIFF\x00\x00\x00\x00WAVEfmt "));
    }

    #[test]
    fn looks_like_supported_image_rejects_empty_slice() {
        assert!(!looks_like_supported_image(&[]));
    }

    #[test]
    fn split_url_path_strips_query_and_fragment() {
        // The direct-image extension check reads the path only, so a `.png` before a `?query` or
        // `#fragment` must still be seen. Pins that both are stripped (and that the whole value is
        // not replaced with a constant).
        assert_eq!(split_url_path("a/b.png"), "a/b.png");
        assert_eq!(split_url_path("a/b.png?w=200&h=200"), "a/b.png");
        assert_eq!(split_url_path("a/b.png#frag"), "a/b.png");
        assert_eq!(split_url_path("a/b.png?w=200#frag"), "a/b.png");
        assert_eq!(
            split_url_path("no-query-or-fragment"),
            "no-query-or-fragment"
        );
    }

    #[test]
    fn direct_image_extension_maps_each_supported_extension() {
        // Every branch returns the matching extension for an http(s) URL, case-insensitively and
        // through a query string. A non-image path and a non-http(s) URL both return None.
        for (url, expected) in [
            ("https://cdn.example/pic.png", Some("png")),
            ("http://cdn.example/pic.jpg", Some("jpg")),
            ("https://cdn.example/pic.jpeg", Some("jpeg")),
            ("https://cdn.example/pic.WEBP", Some("webp")),
            ("https://cdn.example/pic.bmp", Some("bmp")),
            ("https://cdn.example/pic.avif", Some("avif")),
            ("https://cdn.example/pic.gif", Some("gif")),
            // The extension is read from the path, so a trailing query does not hide it.
            ("https://cdn.example/pic.png?width=200", Some("png")),
            // Not an image path.
            ("https://cdn.example/document.txt", None),
            ("https://cdn.example/no-extension", None),
            // Not http(s): the scheme gate returns None before any extension is considered, so the
            // yt-dlp fallback (which re-validates the host) handles it instead of the direct fetch.
            ("ftp://cdn.example/pic.png", None),
            ("file:///pic.png", None),
        ] {
            assert_eq!(direct_image_extension(url), expected, "url: {url}");
        }
    }

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

    #[tokio::test]
    async fn public_only_resolver_rejects_a_host_that_resolves_to_loopback() {
        // localhost resolves to 127.0.0.1/::1 on every platform, so the resolver must return an
        // error rather than any address - this is what pins the connection away from a rebind to an
        // internal target. Exercises the real resolve+filter path offline.
        let mut resolver = PublicOnlyResolver;
        let name = "localhost".parse::<Name>().expect("valid dns name");

        let result = Service::call(&mut resolver, name).await;

        assert!(
            result.is_err(),
            "localhost resolves only to loopback and must be rejected"
        );
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

    fn sample_temp_dir() -> PathBuf {
        PathBuf::from(if cfg!(windows) {
            "C:\\tmp\\thumb"
        } else {
            "/tmp/thumb"
        })
    }

    #[test]
    fn build_thumbnail_command_args_single_media_uses_no_playlist_and_no_cookies() {
        let temp = sample_temp_dir();

        let args = build_thumbnail_command_args(
            "/opt/ffmpeg",
            &temp,
            "thumb_youtube_abc",
            "https://www.youtube.com/watch?v=abc",
            ThumbnailTarget::SingleMedia,
            None,
            None,
        );

        // Single media constrains yt-dlp to the one entry and never enumerates a playlist.
        assert!(args.iter().any(|arg| arg == "--no-playlist"));
        assert!(!args.iter().any(|arg| arg == "--playlist-items"));

        // The shared skeleton is present: skip download, write and convert the thumbnail to png,
        // pin ffmpeg, sandbox writes to the temp dir, and template the output name.
        assert!(args.iter().any(|arg| arg == "--skip-download"));
        assert!(args.iter().any(|arg| arg == "--write-thumbnail"));
        let convert = args
            .iter()
            .position(|arg| arg == "--convert-thumbnails")
            .unwrap();
        assert_eq!(args[convert + 1], "png");
        let ffmpeg = args
            .iter()
            .position(|arg| arg == "--ffmpeg-location")
            .unwrap();
        assert_eq!(args[ffmpeg + 1], "/opt/ffmpeg");
        assert!(args.iter().any(|arg| arg == "thumb_youtube_abc.%(ext)s"));
        assert!(args
            .iter()
            .any(|arg| arg == &format!("home:{}", temp.to_string_lossy())));

        // No auth flags are added without cookies.
        assert!(!args.iter().any(|arg| arg == "--cookies"));
        assert!(!args.iter().any(|arg| arg == "--cookies-from-browser"));

        // The URL is last and immediately preceded by `--`.
        assert_eq!(args.last().unwrap(), "https://www.youtube.com/watch?v=abc");
        assert_eq!(args[args.len() - 2], "--");
    }

    #[test]
    fn build_thumbnail_command_args_channel_avatar_uses_playlist_items_zero() {
        let temp = sample_temp_dir();

        let args = build_thumbnail_command_args(
            "ffmpeg",
            &temp,
            "channel_avatar",
            "https://www.youtube.com/@handle",
            ThumbnailTarget::ChannelAvatar,
            None,
            None,
        );

        // A channel page enumerates zero videos, so only the avatar thumbnail is written.
        let items = args
            .iter()
            .position(|arg| arg == "--playlist-items")
            .unwrap();
        assert_eq!(args[items + 1], "0");
        assert!(!args.iter().any(|arg| arg == "--no-playlist"));

        assert_eq!(args.last().unwrap(), "https://www.youtube.com/@handle");
        assert_eq!(args[args.len() - 2], "--");
    }

    #[test]
    fn build_thumbnail_command_args_passes_browser_cookies_through() {
        let temp = sample_temp_dir();

        let args = build_thumbnail_command_args(
            "ffmpeg",
            &temp,
            "thumb_youtube_abc",
            "https://youtu.be/abc",
            ThumbnailTarget::SingleMedia,
            Some("firefox"),
            None,
        );

        let cookies = args
            .iter()
            .position(|arg| arg == "--cookies-from-browser")
            .unwrap();
        assert_eq!(args[cookies + 1], "firefox");

        // The `--` + URL invariant still holds with the cookie flags present.
        assert_eq!(args.last().unwrap(), "https://youtu.be/abc");
        assert_eq!(args[args.len() - 2], "--");
    }
}
