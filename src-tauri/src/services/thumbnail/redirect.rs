//! The per-hop decision behind the thumbnail downloader's manual redirect following.
//!
//! `services::thumbnail::download` uses a hand-rolled hyper client rather than the `reqwest`
//! already in the tree, and the reason is entirely this module: it follows redirects *manually* so
//! the SSRF guard (`assert_url_host_is_public`, backed by [`crate::services::ssrf_guard`]) re-runs
//! on the initial URL **and on every hop**. A client that follows redirects itself would let us vet
//! only the first one, so a public thumbnail URL that 302s to `http://169.254.169.254/...` would
//! walk straight past the check. The thumbnail URL comes from yt-dlp metadata, which the video
//! being downloaded influences, so that revalidation is the whole point of the client.
//!
//! Which made it awkward that the decision driving that loop was the one part of the downloader no
//! mutation gate could reach: the rest of `download.rs` is async network orchestration, so putting
//! the whole file under `examine_globs` would have reported dozens of unkillable mutants. Extracting
//! the pure decision into its own module is the resolution this codebase has now reached four times
//! ([`crate::services::ssrf_guard`], `thumbnail::url`, `yt_dlp::download::redaction`,
//! `thumbnail::picked`), and it applies here for the strongest reason of the four.
//!
//! [`next_hop`] is that decision, whole: the hop budget, the refusal of a redirect that names no
//! destination, and the resolution of the `Location` value against the URI it came from. The caller
//! keeps the loop, the request and the body; it makes no redirect decision of its own.

use http::Uri;

use crate::{AppError, AppErrorCode, AppResult};

/// How many redirects one thumbnail fetch may follow.
///
/// Counted in *hops taken*, not requests issued: at this value the initial URL plus ten redirect
/// targets have been requested, and the eleventh redirect is refused. Generous for a CDN chain
/// (ytimg and ggpht normally use one or two) while keeping a redirect cycle bounded independently of
/// the whole-operation deadline the caller also applies.
pub(crate) const MAX_REDIRECT_HOPS: usize = 10;

/// True once `hops_used` redirects have already been followed and no further hop may be taken.
///
/// Its own predicate so the boundary is one call from a test. Inside the loop it was reachable only
/// by standing up a server that redirects eleven times, which is why the comparison went untested
/// while being the thing that keeps a redirect cycle from being followed forever.
fn hop_budget_exhausted(hops_used: usize) -> bool {
    hops_used >= MAX_REDIRECT_HOPS
}

/// Resolves a redirect `location` header value against the `current` URI.
///
/// Accepts absolute http/https URLs and path-based relatives (`/...` or `path`).
/// Rejects any other scheme (`file://`, `ftp://`, etc.) with an explicit error.
fn resolve_redirect(current: &Uri, location: &str) -> AppResult<Uri> {
    let location_lc = location.to_ascii_lowercase();

    // Absolute http/https. Scheme comparison is case-insensitive per RFC 3986
    if location_lc.starts_with("http://") || location_lc.starts_with("https://") {
        return location.parse().map_err(|e| {
            AppError::from_code(
                AppErrorCode::YtDlpThumbnailFailed,
                format!("invalid absolute redirect location: {e}"),
            )
        });
    }

    // Protocol-relative: //host/path. Inherit current scheme
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

/// Where a redirect response sends the fetch next, or why it is refused.
///
/// `location` is `None` when the response carried no `Location` header, or one whose bytes are not
/// valid header text. Both mean the same thing to this decision (a redirect naming no destination),
/// so they arrive as one case rather than two.
///
/// `host_is_allowed` is the caller's host gate, applied to the *resolved* destination. It is a
/// parameter rather than a direct call to `super::url::is_allowed_thumbnail_image_host` so this
/// module stays free of the allow-list it enforces, and so a test can drive both answers without
/// naming a real CDN. See the note on the check order below for why it is here at all.
///
/// The order of the four checks is not interchangeable. The budget comes first so a chain that has
/// already gone too far is refused as a chain rather than being reported as whatever happens to be
/// wrong with its next `Location`; the missing-destination refusal comes before the resolution so
/// `resolve_redirect` never has to describe an absence; and the host gate comes last because it is
/// the only one of the four that needs the destination already resolved. A relative `Location`
/// carries no host of its own.
///
/// That last check is the one worth explaining, because for a while it was not here and the loop
/// did not have it either. The caller gates the *initial* URL against the image CDNs before the
/// fetch starts, which reads as a gate on the whole operation and is not one: only
/// `assert_url_host_is_public` re-ran per hop, so a `302` out of an allowed CDN was followed to any
/// public host. The SSRF guard kept that off internal addresses, and the response was still capped,
/// content-type checked and magic-byte sniffed, but none of that stops the *request*, which is the
/// outbound channel `super::url` exists to close. Deciding it here rather than in the loop is what
/// puts it under the mutation gate, like every other decision this module holds.
pub(crate) fn next_hop(
    current: &Uri,
    location: Option<&str>,
    hops_used: usize,
    host_is_allowed: fn(&Uri) -> bool,
) -> AppResult<Uri> {
    if hop_budget_exhausted(hops_used) {
        return Err(AppError::from_code(
            AppErrorCode::YtDlpThumbnailFailed,
            "too many redirects downloading thumbnail",
        ));
    }

    let Some(location) = location else {
        return Err(AppError::from_code(
            AppErrorCode::YtDlpThumbnailFailed,
            "redirect without valid Location header",
        ));
    };

    let destination = resolve_redirect(current, location)?;

    if !host_is_allowed(&destination) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidUrl,
            "thumbnail redirect left the allowed image cdns",
        ));
    }

    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uri(value: &str) -> Uri {
        value.parse().unwrap()
    }

    /// A host gate that admits everything, for the tests about the other three decisions.
    fn any_host(_uri: &Uri) -> bool {
        true
    }

    /// A host gate standing in for the real allow-list, so these tests pin the *wiring* of the gate
    /// rather than the contents of `super::url`'s list, which has its own tests, and which this
    /// module deliberately does not import.
    fn only_cdn_example(uri: &Uri) -> bool {
        uri.host() == Some("cdn.example.com")
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

    #[test]
    fn the_hop_budget_is_exhausted_exactly_at_its_ceiling() {
        // Both sides of the `>=`, on the exact boundary. A `>` here follows one redirect more than
        // the constant says, and an inverted comparison refuses the first hop of every fetch, which
        // reads as "thumbnails stopped loading" with nothing pointing at the redirect logic.
        for hops_used in 0..MAX_REDIRECT_HOPS {
            assert!(
                !hop_budget_exhausted(hops_used),
                "{hops_used} hops should still leave budget"
            );
        }

        assert!(hop_budget_exhausted(MAX_REDIRECT_HOPS));
        // Past the ceiling stays exhausted, so a caller that ever over-counted cannot fall back
        // through into an unbounded chain.
        assert!(hop_budget_exhausted(MAX_REDIRECT_HOPS + 1));
    }

    #[test]
    fn a_hop_within_budget_resolves_its_location() {
        let followed = next_hop(
            &uri("https://img.example.com/old.jpg"),
            Some("https://cdn.example.com/new.jpg"),
            MAX_REDIRECT_HOPS - 1,
            any_host,
        )
        .unwrap();

        assert_eq!(followed, uri("https://cdn.example.com/new.jpg"));
    }

    #[test]
    fn a_hop_at_the_ceiling_is_refused_even_with_a_valid_location() {
        // The budget is checked before the location, so a chain that has gone too far is refused as
        // a chain. Asserting it with a *valid* destination is what pins the ordering: if the two
        // checks were swapped this would succeed and the loop would never terminate on its own.
        let error = next_hop(
            &uri("https://img.example.com/old.jpg"),
            Some("https://cdn.example.com/new.jpg"),
            MAX_REDIRECT_HOPS,
            any_host,
        )
        .unwrap_err();

        assert_eq!(error.code, AppErrorCode::YtDlpThumbnailFailed.as_str());
        assert!(error.to_string().contains("too many redirects"));
    }

    #[test]
    fn a_redirect_naming_no_destination_is_refused_rather_than_followed() {
        // A 3xx with no usable Location has nowhere to go. Refusing is what stops the loop from
        // re-requesting the same URI forever, which is what "keep the current uri and continue"
        // would have done.
        let error =
            next_hop(&uri("https://img.example.com/old.jpg"), None, 0, any_host).unwrap_err();

        assert_eq!(error.code, AppErrorCode::YtDlpThumbnailFailed.as_str());
        assert!(error.to_string().contains("Location header"));
    }

    #[test]
    fn a_hop_leaving_the_allowed_hosts_is_refused() {
        // The gap this parameter closes. The caller gates the initial URL, so a fetch *starts* on an
        // allowed CDN; without this check a single 302 carried it to any public host, which is the
        // outbound channel the allow-list exists to close. The SSRF guard does not cover it. The
        // destination here is perfectly public.
        let error = next_hop(
            &uri("https://cdn.example.com/thumb.jpg"),
            Some("https://attacker.example/ZXhmaWx0cmF0ZWQ.jpg"),
            0,
            only_cdn_example,
        )
        .unwrap_err();

        assert_eq!(error.code, AppErrorCode::InvalidUrl.as_str());
        assert!(error.to_string().contains("allowed image cdns"));
    }

    #[test]
    fn a_relative_hop_is_gated_on_the_host_it_resolves_to() {
        // A relative Location carries no host of its own, which is why the gate runs *after* the
        // resolution rather than on the raw header value: the destination inherits the current
        // authority, so this one is allowed while the same path on another origin would not be.
        let followed = next_hop(
            &uri("https://cdn.example.com/a/b/old.jpg"),
            Some("/new/image.jpg"),
            0,
            only_cdn_example,
        )
        .unwrap();

        assert_eq!(followed, uri("https://cdn.example.com/new/image.jpg"));
    }

    #[test]
    fn a_protocol_relative_hop_is_gated_on_its_new_host() {
        // The one relative form that *does* change host. Reading it as "relative, therefore same
        // origin" would let `//attacker.example/x.jpg` through the gate entirely.
        let error = next_hop(
            &uri("https://cdn.example.com/old.jpg"),
            Some("//attacker.example/x.jpg"),
            0,
            only_cdn_example,
        )
        .unwrap_err();

        assert_eq!(error.code, AppErrorCode::InvalidUrl.as_str());
    }

    #[test]
    fn the_budget_is_still_what_refuses_a_hop_that_would_also_pass_the_host_gate() {
        // Both refusals apply to the same hop, and the budget has to win: reporting an over-long
        // chain as a host problem would send whoever reads the log looking at the allow-list.
        let error = next_hop(
            &uri("https://cdn.example.com/old.jpg"),
            Some("https://cdn.example.com/new.jpg"),
            MAX_REDIRECT_HOPS,
            only_cdn_example,
        )
        .unwrap_err();

        assert_eq!(error.code, AppErrorCode::YtDlpThumbnailFailed.as_str());
    }

    #[test]
    fn a_hop_to_a_non_http_scheme_is_refused_at_any_budget() {
        // The SSRF guard only ever sees a URI this function returned, so a scheme it cannot resolve
        // a host for must be refused here rather than handed on.
        let error = next_hop(
            &uri("https://img.example.com/thumb.jpg"),
            Some("file:///etc/passwd"),
            0,
            any_host,
        )
        .unwrap_err();

        assert!(error.to_string().contains("non-http scheme rejected"));
    }
}
