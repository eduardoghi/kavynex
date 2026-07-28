//! Restricts the *direct* thumbnail fetch to the image CDNs YouTube actually serves from.
//!
//! The sibling of `yt_dlp_url` on the other branch of the same command: that module gates the URL
//! handed to yt-dlp's generic extractor, this one gates the URL the backend fetches over HTTP
//! itself (`services::thumbnail_download::download_thumbnail_from_url_async`). Both are host
//! allow-lists, and the lists deliberately differ - see [`ALLOWED_THUMBNAIL_IMAGE_HOSTS`].
//!
//! Kept in its own module - pure, no network, no filesystem - so the whole classifier can sit under
//! the mutation gate (`.cargo/mutants.toml`) without dragging in `thumbnail_download`'s async
//! process orchestration, which a unit test cannot drive and which would report dozens of
//! unkillable mutants. Same reasoning, and the same shape, as the `ssrf_guard` and
//! `yt_dlp_download::redaction` extractions before it.

use http::Uri;

/// The image CDNs the direct thumbnail fetch may reach. These mirror the `img-src` hosts in
/// `tauri.conf.json`'s CSP: the webview is already only permitted to *render* images from them, so
/// letting the backend *fetch* one from anywhere else served no flow this app has. The parity is
/// pinned by `allowed_thumbnail_hosts_match_the_csp_img_src` below, in both directions, so the two
/// lists cannot drift.
///
/// This exists because the two halves of `download_thumbnail_from_url_async` used to treat the host
/// differently: the yt-dlp fallback has always refused a non-YouTube URL (it hands the value to
/// yt-dlp's generic extractor, which runs with access to the user's browser cookies), while the
/// direct-image branch accepted any *public* host. The SSRF guard kept that branch off internal
/// addresses, but nothing kept it off the open internet - so a compromised frontend could use it as
/// an outbound channel, encoding data in a path that still ends in `.jpg`. No legitimate flow ever
/// supplied such a URL: the manual thumbnail control is a file picker (`utils/pick-image-file.ts`),
/// and the only remote value that reaches the command is yt-dlp's own `thumbnail` metadata.
///
/// Deliberately **not** `yt_dlp_url`'s `YOUTUBE_DOMAINS`, which gates the fallback. The thumbnails
/// yt-dlp reports live on ytimg/ggpht/googleusercontent, none of which is a `youtube.com` host, so
/// reusing that list here would reject every real thumbnail the app downloads.
pub(crate) const ALLOWED_THUMBNAIL_IMAGE_HOSTS: [&str; 4] = [
    "ytimg.com",
    "ggpht.com",
    "googleusercontent.com",
    "youtube.com",
];

/// True when `uri`'s host is one of [`ALLOWED_THUMBNAIL_IMAGE_HOSTS`] or a subdomain of one.
///
/// Suffix-matched on a leading `.` exactly like `yt_dlp_url::is_allowed_youtube_host`, so a
/// look-alike (`ytimg.com.evil.example`, `notytimg.com`) is rejected rather than matched by a bare
/// `contains`. A trailing root dot is stripped first, since `ytimg.com.` resolves to the same host.
pub(crate) fn is_allowed_thumbnail_image_host(uri: &Uri) -> bool {
    let Some(host) = uri.host() else {
        return false;
    };

    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();

    ALLOWED_THUMBNAIL_IMAGE_HOSTS
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uri(value: &str) -> Uri {
        value.parse().expect("test uri must parse")
    }

    #[test]
    fn is_allowed_thumbnail_image_host_accepts_the_cdns_youtube_actually_serves() {
        // The real hosts yt-dlp reports a thumbnail on. None of them is a `youtube.com` host,
        // which is exactly why this gate cannot reuse the yt-dlp allow-list.
        for value in [
            "https://i.ytimg.com/vi/abc/maxresdefault.jpg",
            "https://i9.ytimg.com/vi/abc/hq720.jpg",
            "https://yt3.ggpht.com/ytc/abc.jpg",
            "https://lh3.googleusercontent.com/abc.jpg",
            "https://yt3.googleusercontent.com/abc.jpg",
            "https://www.youtube.com/img/abc.png",
            // The bare apex of each allowed domain, and a trailing root dot, both resolve here.
            "https://ytimg.com/abc.jpg",
            "https://ggpht.com./abc.jpg",
            // Host matching is case-insensitive.
            "https://I.YTIMG.COM/vi/abc/default.jpg",
        ] {
            assert!(
                is_allowed_thumbnail_image_host(&uri(value)),
                "should accept: {value}"
            );
        }
    }

    #[test]
    fn is_allowed_thumbnail_image_host_rejects_look_alikes_and_arbitrary_hosts() {
        // The suffix match requires a leading `.`, so a domain that merely *contains* or *ends
        // with the letters of* an allowed one is refused. The last two are the exfiltration shape
        // this gate exists to close: a path that still ends in `.jpg` on a host of the caller's
        // choosing.
        for value in [
            "https://ytimg.com.evil.example/abc.jpg",
            "https://notytimg.com/abc.jpg",
            "https://evilggpht.com/abc.jpg",
            "https://googleusercontent.com.attacker.test/abc.jpg",
            "https://ytimg.evil.example/abc.jpg",
            "https://attacker.example/ZXhmaWx0cmF0ZWQ.jpg",
            "https://attacker.example/pic.jpg?leak=secret",
        ] {
            assert!(
                !is_allowed_thumbnail_image_host(&uri(value)),
                "should reject: {value}"
            );
        }
    }

    #[test]
    fn allowed_thumbnail_hosts_match_the_csp_img_src() {
        // The backend fetches an image only from hosts the webview is allowed to render one from,
        // so this list is a copy of the CSP's `img-src` hosts. A copy drifts, and the drift would
        // be silent in both directions: a host added here but not to the CSP downloads a thumbnail
        // the grid then refuses to display, and one added to the CSP but not here is renderable and
        // undownloadable. Read the CSP as the source and assert every entry is covered.
        let raw = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"));
        let config: serde_json::Value =
            serde_json::from_str(raw).expect("tauri.conf.json must be valid JSON");

        let csp = config["app"]["security"]["csp"]
            .as_str()
            .expect("the CSP must be a string");

        let img_src = csp
            .split(';')
            .map(str::trim)
            .find(|directive| directive.starts_with("img-src"))
            .expect("the CSP must declare img-src");

        for domain in ALLOWED_THUMBNAIL_IMAGE_HOSTS {
            assert!(
                img_src.contains(domain),
                "img-src does not cover {domain}, which the direct thumbnail fetch allows: {img_src}"
            );
        }

        // And the other direction: every https host the CSP names must be fetchable here, so a
        // host added to the CSP alone fails this test instead of silently never downloading.
        for token in img_src.split_whitespace() {
            let Some(host) = token.strip_prefix("https://") else {
                continue;
            };

            let host = host.trim_start_matches("*.");

            assert!(
                ALLOWED_THUMBNAIL_IMAGE_HOSTS.contains(&host),
                "img-src names {host}, which the direct thumbnail fetch would refuse"
            );
        }
    }
}
