//! Serves the library's media files to the `<video>`/`<audio>` element, without the range
//! truncation that makes long recordings unplayable on Apple platforms.
//!
//! # Why this exists rather than the asset protocol
//!
//! Tauri's own `asset:` handler caps every range response at `MAX_LEN = 1000 * 1024` bytes,
//! whatever the client asked for. That is legal HTTP (RFC 9110 lets a server return a subset and
//! makes the client responsible for reading `Content-Range` and asking for the rest), and Chromium
//! handles it, which is why Windows never showed this. WebKit's custom-scheme media path does not.
//! `WebCoreAVFResourceLoader` records how many bytes AVFoundation asked for, notices it received
//! fewer, and then the underlying resource completing calls `[m_avRequest finishLoading]` without
//! consulting that remainder. Apple documents `finishLoading` before the full range is delivered as
//! meaning the resource ends there, so the track is abandoned mid-metadata.
//!
//! What that costs is the app's core content. The failure tracks the size of the `moov` atom, whose
//! sample tables carry one entry per frame, not the size of the file. Measured on macOS 26.6.1
//! against real downloads:
//!
//! | `moov`  | file    | result                          |
//! |---------|---------|---------------------------------|
//! | 2.6 MB  | 571 MB  | plays                           |
//! | 5.2 MB  | 1110 MB | audio plays, video stays black  |
//! | 7.3 MB  | 47 MB   | fails                           |
//! | 9.4 MB  | 1810 MB | fails                           |
//!
//! A 47 MB file failing while a 571 MB one plays is what rules out any byte-volume explanation. In
//! practice the boundary sits around an hour at 60 fps, which is what an archived livestream is.
//!
//! # Why the cap is 16 MiB rather than removed
//!
//! It cannot simply be removed. wry hands the response body to `WKURLSchemeTask` as a single
//! `NSData` copy, so an unbounded `bytes=0-` on a multi-gigabyte file would materialize the whole
//! thing twice. The cap is what bounds one request; it just has to be large enough that the media
//! stack's tolerance for truncated responses is not exhausted.
//!
//! That tolerance was measured rather than guessed, serving the same 7.3 MB-`moov` file over plain
//! HTTP at several caps and watching Safari (same WebKit, same AVFoundation):
//!
//! | cap    | truncated round trips | result |
//! |--------|-----------------------|--------|
//! | 1 MiB  | ~8                    | fails  |
//! | 4 MiB  | ~2                    | plays  |
//! | 8 MiB  | 1                     | plays  |
//! | 16 MiB | 1                     | plays  |
//!
//! So the requirement is not "the cap must exceed the `moov`", which 4 MiB disproves. A couple of
//! round trips are tolerated and eight are not. 16 MiB is four times the smallest measured pass,
//! which leaves room for a longer recording's larger metadata without making one request able to
//! allocate much.
//!
//! **What should send someone back to re-measure**: a report of a recording that still will not
//! play, or a Tauri release that raises its own `MAX_LEN`, which would make this module removable.
//! The tolerance above is two data points and an extrapolation, not a documented contract.
//!
//! # What guards it
//!
//! Nothing new. The handler asks the asset-protocol scope whether the path is allowed, which is the
//! same set `commands::security::register_library_asset_scope` grants and revokes, already verified
//! against the library path persisted in the settings. This module widens no permission; it serves
//! what the asset protocol would already serve, without truncating it.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use http::{Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext};

/// The scheme the renderer builds media URLs with. Reaches the webview as `kvxmedia://localhost/...`
/// on macOS and Linux and as `http://kvxmedia.localhost/...` on Windows, which is why the CSP in
/// `tauri.conf.json` lists both spellings under `media-src`.
pub const MEDIA_URI_SCHEME: &str = "kvxmedia";

/// The most one response may carry. See the module docs for the measurement behind the value.
const MAX_RANGE_BYTES: u64 = 16 * 1024 * 1024;

// The number is the whole point of this module, so the floor is enforced rather than remembered.
// Tauri's asset protocol caps at `1000 * 1024`, which is the value measured to fail, so anything at
// or below it reintroduces exactly the bug this exists to avoid. Checked at compile time because
// both sides are constants; a runtime assertion on them would be dead weight.
const _: () = assert!(MAX_RANGE_BYTES > 1000 * 1024);

/// Decodes the `%XX` escapes `encodeURI` puts in the path.
///
/// Hand-rolled rather than pulling `percent-encoding` in as a direct dependency, since the whole
/// need is one loop over bytes and this project keeps its dependency surface deliberate. Invalid
/// escapes are passed through verbatim instead of dropped, so a filename containing a literal `%`
/// resolves to itself rather than to a different, possibly existing, path.
pub(crate) fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);

            if let (Some(high), Some(low)) = (high, low) {
                out.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }

        out.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&out).to_string()
}

/// Parses a single-range `Range: bytes=<start>-<end>` header against a resource of `len` bytes.
///
/// Returns the inclusive pair, or `None` when the header names no range this can serve. Only the
/// single-range form is understood, which is what `<video>` and `<audio>` send. A multi-range
/// header falls to `None` and the caller answers with the whole resource, which is a correct if
/// unhelpful response rather than a wrong one.
///
/// The suffix form (`bytes=-<n>`, meaning the last n bytes) is handled because a media stack does
/// use it to read a trailing `moov`.
pub(crate) fn parse_byte_range(header: &str, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }

    let spec = header.trim().strip_prefix("bytes=")?.trim();

    // Multi-range is not served. See above.
    if spec.contains(',') {
        return None;
    }

    let (raw_start, raw_end) = spec.split_once('-')?;
    let raw_start = raw_start.trim();
    let raw_end = raw_end.trim();

    if raw_start.is_empty() {
        // Suffix form: the last `raw_end` bytes.
        let suffix: u64 = raw_end.parse().ok()?;

        if suffix == 0 {
            return None;
        }

        let start = len.saturating_sub(suffix);
        return Some((start, len - 1));
    }

    let start: u64 = raw_start.parse().ok()?;

    if start >= len {
        return None;
    }

    let end = if raw_end.is_empty() {
        len - 1
    } else {
        raw_end.parse::<u64>().ok()?.min(len - 1)
    };

    if end < start {
        return None;
    }

    Some((start, end))
}

/// Narrows an inclusive range to at most `cap` bytes, staying inside `len`.
///
/// Kept separate from the parsing and from the file I/O because this is where the truncation the
/// whole module exists to bound actually happens, and it is the one piece whose off-by-one has a
/// visible consequence: a `Content-Range` that disagrees with the body by a byte is a corrupt
/// response rather than a short one.
pub(crate) fn clamp_range(start: u64, end: u64, len: u64, cap: u64) -> (u64, u64) {
    if len == 0 {
        return (0, 0);
    }

    let last = len - 1;
    let start = start.min(last);
    let end = end.min(last).max(start);
    let span = end - start;
    let allowed = cap.saturating_sub(1);

    (start, start + span.min(allowed))
}

/// The `Content-Type` for a media file, by extension.
///
/// The library only ever holds what `library::media` accepted on import or what yt-dlp produced, so
/// this covers those and falls back to a generic binary type rather than guessing. A wrong specific
/// type is worse than an unspecific one: the media stack trusts it.
pub(crate) fn media_content_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match extension.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "m4a" => "audio/mp4",
        "mp3" => "audio/mpeg",
        "opus" | "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "aac" => "audio/aac",
        _ => "application/octet-stream",
    }
}

fn empty_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Serves one request for a media file.
///
/// Refuses anything the asset-protocol scope would refuse, which is what keeps this from being a
/// second, looser way to read the disk. See the module docs.
pub fn handle<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    // Skip the leading `/` the URI always carries, then undo the encoding the renderer applied.
    let raw_path = request.uri().path();
    let path = percent_decode(raw_path.strip_prefix('/').unwrap_or(raw_path));

    if path.is_empty() {
        return empty_response(StatusCode::BAD_REQUEST);
    }

    // The one authorization check, and deliberately the same one the asset protocol makes rather
    // than a second implementation of it. The scope holds exactly the four managed subdirectories
    // of the configured library (see commands::security), so a path outside them is refused here
    // without this module knowing anything about libraries.
    if !context
        .app_handle()
        .asset_protocol_scope()
        .is_allowed(&path)
    {
        crate::services::logger::warn(
            "media_protocol",
            format!(
                "refused a media request outside the authorized scope: {}",
                crate::services::logger::redact_path(&path)
            ),
        );

        return empty_response(StatusCode::FORBIDDEN);
    }

    let file_path = Path::new(&path);

    let mut file = match File::open(file_path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return empty_response(StatusCode::NOT_FOUND)
        }
        Err(_) => return empty_response(StatusCode::INTERNAL_SERVER_ERROR),
    };

    let len = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(_) => return empty_response(StatusCode::INTERNAL_SERVER_ERROR),
    };

    let content_type = media_content_type(file_path);

    let requested = request
        .headers()
        .get(http::header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_byte_range(value, len));

    // No range asked for. Answering with the whole file would be the one case that can still
    // allocate gigabytes, so the first window is served instead and the client asks for the rest,
    // which is what it does anyway once it sees `Accept-Ranges`.
    let (start, end) = match requested {
        Some((start, end)) => clamp_range(start, end, len, MAX_RANGE_BYTES),
        None => clamp_range(0, len.saturating_sub(1), len, MAX_RANGE_BYTES),
    };

    let count = end + 1 - start;

    let mut body = vec![0_u8; count as usize];

    if file.seek(SeekFrom::Start(start)).is_err() {
        return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
    }

    if file.read_exact(&mut body).is_err() {
        return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
    }

    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(http::header::CONTENT_TYPE, content_type)
        .header(http::header::ACCEPT_RANGES, "bytes")
        .header(http::header::CONTENT_LENGTH, count)
        .header(
            http::header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{len}"),
        )
        .body(body)
        .unwrap_or_else(|_| empty_response(StatusCode::INTERNAL_SERVER_ERROR))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_restores_the_characters_a_path_can_carry() {
        assert_eq!(percent_decode("video/a%20clip.mp4"), "video/a clip.mp4");
        assert_eq!(
            percent_decode("/Users/me/Kavynex%20Biblioteca/video/x.mp4"),
            "/Users/me/Kavynex Biblioteca/video/x.mp4"
        );
        // Accented names arrive as UTF-8 byte escapes.
        assert_eq!(
            percent_decode("video/can%C3%A7%C3%A3o.m4a"),
            "video/canção.m4a"
        );
        // Nothing to decode is returned untouched.
        assert_eq!(percent_decode("video/plain.mp4"), "video/plain.mp4");
    }

    #[test]
    fn percent_decode_passes_a_malformed_escape_through_rather_than_dropping_it() {
        // A literal `%` in a filename must resolve to itself. Dropping the escape would silently
        // rewrite the path, and a rewritten path can name a different file that exists.
        assert_eq!(percent_decode("video/100%.mp4"), "video/100%.mp4");
        assert_eq!(percent_decode("video/%zz.mp4"), "video/%zz.mp4");
        assert_eq!(percent_decode("%"), "%");
    }

    #[test]
    fn parse_byte_range_reads_the_forms_a_media_element_sends() {
        // Bounded, which is the common one.
        assert_eq!(parse_byte_range("bytes=0-1023", 4096), Some((0, 1023)));
        // Open ended, meaning "to the end".
        assert_eq!(parse_byte_range("bytes=2048-", 4096), Some((2048, 4095)));
        // Suffix, which is how a trailing moov gets read.
        assert_eq!(parse_byte_range("bytes=-512", 4096), Some((3584, 4095)));
        // An end past the resource is clamped rather than refused.
        assert_eq!(
            parse_byte_range("bytes=4000-99999", 4096),
            Some((4000, 4095))
        );
        // Whitespace around the spec is tolerated.
        assert_eq!(parse_byte_range("  bytes=0-9  ", 4096), Some((0, 9)));
    }

    #[test]
    fn parse_byte_range_declines_what_it_cannot_serve() {
        // A start past the end is unsatisfiable.
        assert_eq!(parse_byte_range("bytes=5000-", 4096), None);
        // An inverted range.
        assert_eq!(parse_byte_range("bytes=200-100", 4096), None);
        // Multi-range is deliberately not served, so the caller answers with a window instead of a
        // malformed multipart body.
        assert_eq!(parse_byte_range("bytes=0-99,200-299", 4096), None);
        // Not a byte range at all.
        assert_eq!(parse_byte_range("items=0-10", 4096), None);
        assert_eq!(parse_byte_range("bytes=abc-def", 4096), None);
        assert_eq!(parse_byte_range("", 4096), None);
        // An empty resource has no range to serve.
        assert_eq!(parse_byte_range("bytes=0-10", 0), None);
        // A zero-length suffix names nothing.
        assert_eq!(parse_byte_range("bytes=-0", 4096), None);
    }

    #[test]
    fn clamp_range_never_returns_more_than_the_cap() {
        // The property the whole module rests on. A cap of 4 yields 4 bytes (0..=3), not 5.
        assert_eq!(clamp_range(0, 999, 1000, 4), (0, 3));
        assert_eq!(clamp_range(10, 999, 1000, 4), (10, 13));

        // An already-small range is returned whole.
        assert_eq!(clamp_range(0, 2, 1000, 16), (0, 2));

        // The count implied by the pair must equal the cap exactly at the boundary, since a
        // Content-Range that disagrees with the body by one byte is a corrupt response.
        let (start, end) = clamp_range(0, 100_000, 1_000_000, 16 * 1024 * 1024);
        assert_eq!(end + 1 - start, 100_001);

        let (start, end) = clamp_range(0, 100_000_000, 200_000_000, 16 * 1024 * 1024);
        assert_eq!(end + 1 - start, 16 * 1024 * 1024);
    }

    #[test]
    fn clamp_range_stays_inside_the_resource() {
        // A pair that reaches past the end is pulled back rather than producing a read that fails.
        assert_eq!(clamp_range(0, 5000, 100, 16), (0, 15));
        assert_eq!(clamp_range(90, 5000, 100, 16), (90, 99));
        // A start past the end lands on the last byte instead of underflowing.
        assert_eq!(clamp_range(500, 600, 100, 16), (99, 99));
        // An empty resource has nothing to offer and must not underflow either.
        assert_eq!(clamp_range(0, 0, 0, 16), (0, 0));
    }

    #[test]
    fn media_content_type_covers_what_the_library_holds() {
        assert_eq!(media_content_type(Path::new("video/a.mp4")), "video/mp4");
        assert_eq!(media_content_type(Path::new("video/A.MP4")), "video/mp4");
        assert_eq!(media_content_type(Path::new("audio/a.m4a")), "audio/mp4");
        assert_eq!(media_content_type(Path::new("audio/a.opus")), "audio/ogg");
        assert_eq!(media_content_type(Path::new("video/a.webm")), "video/webm");
    }

    #[test]
    fn media_content_type_declines_to_guess_an_unknown_extension() {
        // The media stack trusts this header, so a confident wrong answer is worse than a vague
        // one. Nothing in the library should reach here, which is why it is a fallback rather than
        // a refusal.
        assert_eq!(
            media_content_type(Path::new("video/a.bin")),
            "application/octet-stream"
        );
        assert_eq!(
            media_content_type(Path::new("video/noextension")),
            "application/octet-stream"
        );
    }

    // The cap's floor is pinned at compile time next to the constant itself (`const _: () =
    // assert!(..)`), rather than by a test here. Both sides are constants, so a runtime assertion
    // would be dead weight and clippy says so.
}
