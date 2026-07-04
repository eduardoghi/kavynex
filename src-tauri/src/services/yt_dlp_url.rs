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
}
