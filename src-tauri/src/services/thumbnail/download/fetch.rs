//! Fetching a thumbnail over HTTP, and everything that constrains what comes back.
//!
//! The outbound half of the thumbnail download. The SSRF guard, the DNS resolver the client dials
//! through, the manual redirect loop, and the checks on the response (size cap, content type,
//! magic bytes). It is separate from the yt-dlp process next to it in `process.rs` because the two
//! share no machinery, and separate from the orchestration in `super` because these are the checks
//! that decide where a request may go, which is the part worth reading on its own.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use http::Uri;
use http_body_util::{BodyExt, Empty};
use hyper::body::Bytes;
use hyper_util::client::legacy::connect::dns::Name;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use tokio::net::lookup_host;
use tokio::time::timeout;
use tower_service::Service;

use crate::services::ssrf_guard::is_disallowed_ip;
use crate::services::thumbnail::redirect::{next_hop, MAX_REDIRECT_HOPS};
use crate::services::thumbnail::url::is_allowed_thumbnail_image_host;
use crate::{AppError, AppErrorCode, AppResult};

const DIRECT_THUMBNAIL_MAX_BYTES: usize = 10 * 1024 * 1024; // 10 MiB

pub(super) const ALLOWED_THUMBNAIL_CONTENT_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/bmp",
    "image/avif",
    "image/gif",
];

fn split_url_path(url: &str) -> &str {
    let without_query = url.split('?').next().unwrap_or(url);
    without_query.split('#').next().unwrap_or(without_query)
}

pub(super) fn direct_image_extension(url: &str) -> Option<&'static str> {
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
pub(super) fn looks_like_supported_image(bytes: &[u8]) -> bool {
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

    // WEBP. A RIFF container with a "WEBP" fourCC at offset 8.
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return true;
    }

    // AVIF. An ISOBMFF `ftyp` box (offset 4) whose brand (offset 8) is avif/avis.
    if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis")
    {
        return true;
    }

    false
}

/// Resolves the host of `uri` and rejects it if it maps to any private, loopback or
/// reserved address (SSRF guard). Applied to the initial URL and every redirect target.
///
/// This checks the resolved addresses before the request; it does not pin the connection
/// to a validated address, so a determined DNS-rebinding attacker could still race it.
/// That residual risk is acceptable for a local desktop app fetching image thumbnails.
pub(super) async fn assert_url_host_is_public(uri: &Uri) -> AppResult<()> {
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
/// validated *is* the address that is dialed, which is what `assert_url_host_is_public`, running as
/// a separate pre-connection check, cannot guarantee on its own. Between that check and the
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

/// Downloads `url` over HTTPS (or HTTP), follows up to [`MAX_REDIRECT_HOPS`]
/// redirects, streams the body with a hard cap of DIRECT_THUMBNAIL_MAX_BYTES, and
/// validates Content-Type when present. Returns (status, headers, body). The entire
/// operation (DNS revalidation, headers, redirects and the body stream) runs under a
/// single `timeout_secs` deadline, so a slow-drip server cannot stall it under the size cap.
///
/// This uses a hand-rolled hyper client on purpose, rather than `reqwest` (which is already in
/// the tree transitively via the updater plugin). The reason is the redirect loop below. It
/// follows redirects *manually* so it can re-run the SSRF guard (`assert_url_host_is_public`,
/// which rejects a host resolving to a private/loopback/link-local/reserved address), on the
/// initial URL **and on every redirect target**. A client that follows redirects automatically
/// (reqwest's default) would only let us vet the first hop, so a public thumbnail URL that
/// 302-redirects to, say, `http://169.254.169.254/...` or an internal host would slip past the
/// check. The thumbnail URL comes from yt-dlp metadata (attacker-influenced), so that per-hop
/// revalidation is the whole point; keeping this on a minimal hyper stack also avoids pulling
/// reqwest's cookie jar and automatic-redirect behavior into a request that must stay dumb.
///
/// The decision each hop makes (the budget, the refusal of a redirect naming no destination, the
/// resolution of `Location` against the URI it arrived on, and the image-CDN host gate on the
/// destination), lives in [`super::redirect::next_hop`], not here. This function owns the loop, the
/// request and the body; it makes no redirect decision of its own, which is what lets that decision
/// be mutation-tested while the network code around it cannot be.
///
/// That host gate is per hop and not only per fetch, which it was not at first. The caller checks
/// where the fetch *starts*, so a `302` out of an allowed CDN used to be followed anywhere public.
/// Everything else here constrains the *response* (the size cap, the content type, the magic-byte
/// sniff) and the SSRF guard constrains the *address*; none of the four stops the request itself
/// from reaching a host of the redirecting server's choosing, which is the outbound channel
/// [`super::url`] exists to close.
pub(super) async fn http_get_image(
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
        // `https_only()`, not `https_or_http()`. Every other control here constrains the
        // destination or the response, none of them the transport, so a cleartext hop out of an
        // allowed CDN satisfied all of them (see `redirect::next_hop` for what that let through).
        //
        // This is the backstop, not the message. The caller and `next_hop` both refuse cleartext
        // with a reason; a caller added later that skips them still fails here, at connect time,
        // with hyper's own error. Worse to read, and still a refusal.
        .https_only()
        .enable_http1()
        .wrap_connector(http_connector);

    let client: Client<_, Empty<Bytes>> = Client::builder(TokioExecutor::new()).build(connector);

    let mut uri: Uri = url
        .parse()
        .map_err(|e| AppError::from_code(AppErrorCode::InvalidUrl, format!("invalid url: {e}")))?;

    // Bound the whole operation (DNS revalidation, header exchange, every redirect hop and the
    // body stream), under a single deadline. The earlier per-request timeout only covered the
    // header phase, so a server that dribbled the body out slowly could hold the read loop open
    // indefinitely while staying under the DIRECT_THUMBNAIL_MAX_BYTES cap. This command carries no
    // cancel flag, so this deadline is the only thing that can end such a stall.
    timeout(Duration::from_secs(timeout_secs), async move {
        // `hops_used` is what `next_hop` decides against; the range is a structural backstop that
        // cannot be reached, since `next_hop` refuses at MAX_REDIRECT_HOPS on the last iteration.
        // Keeping it means a bug in that predicate costs a bounded loop rather than one the outer
        // deadline is the only thing ending.
        for hops_used in 0..=MAX_REDIRECT_HOPS {
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
                let location = res
                    .headers()
                    .get(http::header::LOCATION)
                    .and_then(|value| value.to_str().ok());

                // The host gate travels with the hop, not only with the initial URL. The caller
                // gates where the fetch *starts*, and without this a single 302 out of an allowed
                // CDN carried it to any public host. `next_hop` owns that decision so it can be
                // mutation-tested; see its doc comment.
                uri = next_hop(&uri, location, hops_used, is_allowed_thumbnail_image_host)?;
                continue;
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

        // Unreachable. The loop's last iteration passes `hops_used == MAX_REDIRECT_HOPS`, which
        // `next_hop` refuses with this same message before it can fall through here. It stays
        // because the `for` above is a backstop rather than the bound, and a backstop needs a value
        // to return if it ever does fire.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

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
            // Not http(s). The scheme gate returns None before any extension is considered, so the
            // yt-dlp fallback (which re-validates the host) handles it instead of the direct fetch.
            ("ftp://cdn.example/pic.png", None),
            ("file:///pic.png", None),
        ] {
            assert_eq!(direct_image_extension(url), expected, "url: {url}");
        }
    }

    #[tokio::test]
    async fn public_only_resolver_rejects_a_host_that_resolves_to_loopback() {
        // localhost resolves to 127.0.0.1/::1 on every platform, so the resolver must return an
        // error rather than any address. This is what pins the connection away from a rebind to an
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

    // The redirect resolution these tests used to cover moved with the decision, to
    // `services::thumbnail::redirect`, which is under the mutation gate, unlike this file. See that
    // module's header for why the extraction was worth making.

    #[tokio::test]
    async fn http_get_image_refuses_an_internal_address_without_dialing_it() {
        // The composition, not the pieces. The guard and the resolver each have their own test
        // above, and this is the only one that proves `http_get_image` actually runs them. A
        // refactor that dropped the call from the loop would leave both of those passing.
        //
        // It asserts on the request that was never made rather than only on the error, because a
        // fetch that connected and then failed for some unrelated reason would still be an error.
        // A real listener is what makes that observable.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a local listener");
        let port = listener.local_addr().expect("local addr").port();

        let connections = Arc::new(AtomicUsize::new(0));
        let accepted = Arc::clone(&connections);

        tokio::spawn(async move {
            while listener.accept().await.is_ok() {
                accepted.fetch_add(1, Ordering::SeqCst);
            }
        });

        // Both spellings of the same destination. The IP literal is refused by the pre-connection
        // guard (HttpConnector skips the resolver for a literal), the hostname by both it and the
        // resolver, so between them every way in is covered.
        for url in [
            format!("http://127.0.0.1:{port}/thumb.png"),
            format!("http://localhost:{port}/thumb.png"),
        ] {
            let error = http_get_image(&url, 5)
                .await
                .expect_err("a loopback thumbnail url must be refused");

            assert_eq!(
                error.code,
                AppErrorCode::InvalidUrl.as_str(),
                "refused for the wrong reason: {}",
                error.message
            );
        }

        assert_eq!(
            connections.load(Ordering::SeqCst),
            0,
            "the refusal must happen before anything is dialed"
        );
    }
}
