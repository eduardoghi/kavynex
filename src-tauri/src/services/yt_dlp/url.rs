//! Validates that a user-provided URL targets YouTube before it is handed to yt-dlp with
//! access to the user's browser cookies.
//!
//! The app only backs up YouTube, so restricting the host closes a defense-in-depth gap.
//! Without it, a compromised frontend could point yt-dlp (and the loaded cookies) at an
//! arbitrary site. The UI only ever sends YouTube URLs, so this loses no real functionality.

use http::Uri;

const YOUTUBE_DOMAINS: [&str; 3] = ["youtube.com", "youtube-nocookie.com", "youtu.be"];

fn is_allowed_youtube_host(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();

    YOUTUBE_DOMAINS
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

/// Builds a privacy-reduced reference to a YouTube URL for the file log. The canonical video id
/// when it can be extracted, otherwise the host and path alone. The full URL a user pastes can
/// carry extra query parameters (playlist ids, referral/tracking params, timestamps) beyond the
/// video itself; logging just `host/watch?v=<id>` (or `youtu.be/<id>`) keeps the log useful for
/// diagnosis without recording those extras, which may end up in a public bug report.
pub fn youtube_ref_for_log(url: &str) -> String {
    let Ok(uri) = url.trim().parse::<Uri>() else {
        return "<youtube url>".to_string();
    };

    let host = uri.host().unwrap_or("").to_ascii_lowercase();

    // youtu.be/<id>. The id is the first path segment.
    if host == "youtu.be" || host.ends_with(".youtu.be") {
        if let Some(id) = uri.path().trim_start_matches('/').split('/').next() {
            if !id.is_empty() {
                return format!("youtu.be/{id}");
            }
        }
    }

    // youtube.com/watch?v=<id>. Pull only the `v` parameter, dropping any other query params.
    if let Some(query) = uri.query() {
        for pair in query.split('&') {
            if let Some(value) = pair.strip_prefix("v=") {
                if !value.is_empty() {
                    return format!("{host}{}?v={value}", uri.path());
                }
            }
        }
    }

    // Fallback (channel pages, other forms). Host + path, never the query string.
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

/// Whether a path segment can be a video or clip id. Only the characters YouTube uses, and short
/// enough that no listing or channel name gets through as one.
fn is_media_id(segment: &str) -> bool {
    (1..=64).contains(&segment.len())
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// True when `url` names one video (or one clip) rather than anything else on YouTube.
///
/// The format probe and the download expect one video. Given a playlist, a channel, a feed or a
/// search, yt-dlp extracts every entry first, many requests to YouTube for something the app then
/// cannot use, and with browser cookies a feed is the signed-in account's. The run then ends in a
/// timeout or a parse error that says nothing about the link. So the shapes that are one video are
/// listed, and everything else is refused, rather than the other way round. A watch URL that also
/// carries a `list=` is still one video (the app passes `--no-playlist`).
pub fn names_one_video(url: &str) -> bool {
    let Ok(uri) = url.trim().parse::<Uri>() else {
        return false;
    };

    let host = uri.host().unwrap_or("").to_ascii_lowercase();
    let segments: Vec<&str> = uri
        .path()
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();

    if host == "youtu.be" || host.ends_with(".youtu.be") {
        return matches!(segments.as_slice(), [id] if is_media_id(id));
    }

    match segments.as_slice() {
        [watch] if watch.eq_ignore_ascii_case("watch") => uri.query().is_some_and(|query| {
            query
                .split('&')
                .filter_map(|pair| pair.strip_prefix("v="))
                .any(is_media_id)
        }),
        [kind, id] => {
            let kind = kind.to_ascii_lowercase();

            matches!(kind.as_str(), "shorts" | "live" | "embed" | "v" | "clip")
                && is_media_id(id)
                && !id.eq_ignore_ascii_case("videoseries")
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anything_but_one_video_is_refused() {
        for url in [
            "https://www.youtube.com/playlist?list=PL123",
            "https://www.youtube.com/@somechannel",
            "https://www.youtube.com/@somechannel/videos",
            "https://www.youtube.com/channel/UC123",
            "https://www.youtube.com/c/Name",
            "https://www.youtube.com/user/Name",
            // The shapes a list of what to refuse let through.
            "https://www.youtube.com/watch?list=PL123",
            "https://www.youtube.com/watch?v=&list=PL123",
            "https://www.youtube.com/",
            "https://www.youtube.com/feed/subscriptions",
            "https://www.youtube.com/results?search_query=x",
            "https://www.youtube.com/hashtag/music",
            "https://www.youtube.com/embed/videoseries?list=PL123",
            "https://youtu.be/",
            "https://youtu.be/abc/extra",
            "https://www.youtube.com/shorts/abc/extra",
            "https://www.youtube.com/watch?v=a%20b",
        ] {
            assert!(!names_one_video(url), "{url}");
        }
    }

    #[test]
    fn a_video_link_names_one_video() {
        for url in [
            "https://www.youtube.com/watch?v=abc",
            "https://www.youtube.com/watch?v=abc&list=PL123",
            "https://www.youtube.com/watch?feature=share&v=abc",
            "https://music.youtube.com/watch?v=abc",
            "https://youtu.be/abc",
            "https://youtu.be/abc?t=42",
            "https://www.youtube.com/shorts/abc",
            "https://www.youtube.com/live/abc",
            "https://www.youtube.com/embed/abc",
            "https://www.youtube-nocookie.com/embed/abc",
            "https://www.youtube.com/clip/UgkxAbC-dEf_123",
        ] {
            assert!(names_one_video(url), "{url}");
        }
    }

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
            "www.youtube.com/watch?v=abc123"
        );
        // youtu.be short links. The id is the path.
        assert_eq!(
            youtube_ref_for_log("https://youtu.be/xyz789?si=track"),
            "youtu.be/xyz789"
        );
        // Channel/other forms. Host + path, never a query string.
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
        // segment), produced by the dedicated youtu.be branch, not the host+path fallback,
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
