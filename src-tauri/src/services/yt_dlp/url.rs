//! Validates that a user-provided URL targets YouTube before it is handed to yt-dlp with
//! access to the user's browser cookies.
//!
//! The app only backs up YouTube, so restricting the host closes a defense-in-depth gap:
//! without it, a compromised frontend could point yt-dlp (and the loaded cookies) at an
//! arbitrary site. The UI only ever sends YouTube URLs, so this loses no real functionality.

use http::Uri;

const YOUTUBE_DOMAINS: [&str; 3] = ["youtube.com", "youtube-nocookie.com", "youtu.be"];

fn is_allowed_youtube_host(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();

    YOUTUBE_DOMAINS
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

/// Builds a privacy-reduced reference to a YouTube URL for the file log: the canonical video id
/// when it can be extracted, otherwise the host and path alone. The full URL a user pastes can
/// carry extra query parameters (playlist ids, referral/tracking params, timestamps) beyond the
/// video itself; logging just `host?v=<id>` (or `youtu.be/<id>`) keeps the log useful for
/// diagnosis without recording those extras, which may end up in a public bug report.
pub fn youtube_ref_for_log(url: &str) -> String {
    let Ok(uri) = url.trim().parse::<Uri>() else {
        return "<youtube url>".to_string();
    };

    let host = uri.host().unwrap_or("").to_ascii_lowercase();

    // youtu.be/<id>: the id is the first path segment.
    if host == "youtu.be" || host.ends_with(".youtu.be") {
        if let Some(id) = uri.path().trim_start_matches('/').split('/').next() {
            if !id.is_empty() {
                return format!("youtu.be/{id}");
            }
        }
    }

    // youtube.com/watch?v=<id>: pull only the `v` parameter, dropping any other query params.
    if let Some(query) = uri.query() {
        for pair in query.split('&') {
            if let Some(value) = pair.strip_prefix("v=") {
                if !value.is_empty() {
                    return format!("{host}?v={value}");
                }
            }
        }
    }

    // Fallback (channel pages, other forms): host + path, never the query string.
    format!("{host}{}", uri.path())
}

/// True when `url` is an http(s) URL whose host is a YouTube domain (or a subdomain of one).
/// Look-alike hosts (`youtube.com.evil.com`, `notyoutube.com`, userinfo tricks) are rejected.
pub fn is_allowed_youtube_url(url: &str) -> bool {
    let Ok(uri) = url.trim().parse::<Uri>() else {
        return false;
    };

    if !matches!(uri.scheme_str(), Some("http") | Some("https")) {
        return false;
    }

    match uri.host() {
        Some(host) => is_allowed_youtube_host(host),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_youtube_domains() {
        for url in [
            "https://www.youtube.com/watch?v=abc",
            "https://youtube.com/watch?v=abc",
            "https://m.youtube.com/watch?v=abc",
            "https://music.youtube.com/watch?v=abc",
            "https://youtu.be/abc",
            "http://www.youtube.com/watch?v=abc",
            "https://www.youtube-nocookie.com/embed/abc",
            "  https://www.youtube.com/watch?v=abc  ",
        ] {
            assert!(is_allowed_youtube_url(url), "should accept: {url}");
        }
    }

    #[test]
    fn rejects_non_youtube_and_lookalike_hosts() {
        for url in [
            "https://attacker.example/watch?v=abc",
            "https://youtube.com.evil.com/watch?v=abc",
            "https://notyoutube.com/watch?v=abc",
            "https://evilyoutube.com/watch",
            "https://youtube.com@evil.com/",
            "ftp://youtube.com/x",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "not a url",
            "",
        ] {
            assert!(!is_allowed_youtube_url(url), "should reject: {url}");
        }
    }

    #[test]
    fn youtube_ref_for_log_reduces_a_url_to_its_video_id() {
        // watch URLs keep only the `v` param, dropping playlist/tracking params.
        assert_eq!(
            youtube_ref_for_log("https://www.youtube.com/watch?v=abc123&list=PLxyz&t=42s"),
            "www.youtube.com?v=abc123"
        );
        // youtu.be short links: the id is the path.
        assert_eq!(
            youtube_ref_for_log("https://youtu.be/xyz789?si=track"),
            "youtu.be/xyz789"
        );
        // Channel/other forms: host + path, never a query string.
        assert_eq!(
            youtube_ref_for_log("https://www.youtube.com/@channel"),
            "www.youtube.com/@channel"
        );
        // Unparseable input never leaks the raw value.
        assert_eq!(youtube_ref_for_log("not a url at all"), "<youtube url>");
    }

    #[test]
    fn youtube_ref_for_log_keeps_only_the_first_youtu_be_path_segment() {
        // A youtu.be link with extra path segments must reduce to just the video id (the first
        // segment), produced by the dedicated youtu.be branch - not the host+path fallback,
        // which would keep the trailing segments. This pins the branch to the value only it
        // yields, so dropping the branch (or its non-empty-id guard) changes the result.
        assert_eq!(
            youtube_ref_for_log("https://youtu.be/xyz789/extra?si=track"),
            "youtu.be/xyz789"
        );
        // A subdomain of youtu.be takes the same branch.
        assert_eq!(
            youtube_ref_for_log("https://www.youtu.be/abc123/more"),
            "youtu.be/abc123"
        );
    }
}
