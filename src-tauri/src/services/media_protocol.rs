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
//! # Verified
//!
//! Against a `pnpm tauri dev` build on macOS 26.6.1 (M4), importing the same files the boundary
//! above was measured with. Both failure modes are gone and the case that already worked still
//! does, which is what would catch a regression in this path rather than only its absence:
//!
//! | `moov`  | before                         | after |
//! |---------|--------------------------------|-------|
//! | 2.5 MB  | plays                          | plays |
//! | 4.9 MB  | audio plays, video stays black | plays |
//! | 7.3 MB  | fails                          | plays |
//! | 9.0 MB  | fails                          | plays |
//!
//! Not yet exercised through a packaged `pnpm tauri build`, where the CSP is the one Tauri injects
//! rather than `devCsp`. Both list the scheme, so the difference is expected to be nil, but it is
//! untested. Linux is untested outright: WebKitGTK routes media through GStreamer rather than
//! AVFoundation, so nothing measured here transfers to it.
//!
//! # What guards it
//!
//! The permission is the asset protocol's own. The handler asks that scope whether the path is
//! allowed, which is the same set `commands::security::register_library_asset_scope` grants and
//! revokes, already verified against the library path persisted in the settings, so this module
//! widens no permission and serves what the asset protocol would already serve, without truncating
//! it. Before asking, it refuses what the scope check would only reach by resolving the path. A
//! component of `..` (`climbs_out_of_a_directory`), and a network path other than the library's
//! own share (`may_resolve`), since resolving one on Windows authenticates to the host. Reads are
//! capped per request and bounded in number (`MEDIA_READ_SEMAPHORE`).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

/// The scheme the renderer builds media URLs with. Reaches the webview as `kvxmedia://localhost/...`
/// on macOS and Linux and as `http://kvxmedia.localhost/...` on Windows, which is why the CSP in
/// `tauri.conf.json` lists both spellings under `media-src`.
pub const MEDIA_URI_SCHEME: &str = "kvxmedia";

/// The most one response may carry. See the module docs for the measurement behind the value.
const MAX_RANGE_BYTES: u64 = 16 * 1024 * 1024;

// The number is the whole point of this module, so the floor is enforced rather than remembered.
// Checked at compile time because both sides are constants, and a runtime assertion on them would
// be dead weight.
//
// The floor is the smallest cap measured to play (4 MiB), not the value measured to fail
// (`1000 * 1024`, Tauri's own). A floor at the failing value would admit caps a few percent above
// it, which still sit far below anything measured to work.
const _: () = assert!(MAX_RANGE_BYTES >= 4 * 1024 * 1024);

/// Decodes the `%XX` escapes `encodeURI` puts in the path.
///
/// Hand-rolled rather than pulling `percent-encoding` in as a direct dependency, since the whole
/// need is one loop over bytes and this project keeps its dependency surface deliberate. Invalid
/// escapes are passed through verbatim instead of dropped, so a filename containing a literal `%`
/// resolves to itself rather than to a different, possibly existing, path.
pub(crate) fn percent_decode(value: &str) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(value.len());
    let mut rest = value.as_bytes();

    // Walks the input by slicing rather than by index arithmetic, so every pass consumes at least
    // one byte by construction and nothing can stall the loop. That is the reason, not style. The
    // index version advanced with `+= 1` and `+= 3`, and mutated to `*= 1` or `-= 3` it pushed the
    // same bytes into `out` forever. The allocation outran the 300s mutation deadline and the OOM
    // took the CI runner down with it (#55), which read as infrastructure for weeks.
    while let [first, tail @ ..] = rest {
        if *first == b'%' {
            if let [high, low, after @ ..] = tail {
                if let (Some(high), Some(low)) = (hex_value(*high), hex_value(*low)) {
                    out.push(high * 16 + low);
                    rest = after;
                    continue;
                }
            }
        }

        out.push(*first);
        rest = tail;
    }

    String::from_utf8_lossy(&out).into_owned()
}

/// The value of one hex digit, or `None` for anything else. At most 15, so `high * 16 + low`
/// above stays inside a byte.
fn hex_value(byte: u8) -> Option<u8> {
    (byte as char).to_digit(16).map(|digit| digit as u8)
}

/// Parses a single-range `Range: bytes=<start>-<end>` header against a resource of `len` bytes.
///
/// Returns the inclusive pair, or `None` when the header names no range this can serve. Only the
/// single-range form is understood, which is what `<video>` and `<audio>` send. A multi-range
/// header falls to `None`, which the caller answers with `416` (see [`plan_range`]).
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

/// What a request for a resource of `len` bytes is answered with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RangePlan {
    /// An empty resource, answered with an empty `200`. There is no byte to put in a range.
    Empty,
    /// A `Range` header this cannot serve (past the end, reversed, several ranges), answered with
    /// `416` and the resource's length so the client can ask again.
    Unsatisfiable,
    /// The inclusive window to read, already narrowed to the cap.
    Window(u64, u64),
}

/// Decides how to answer a request for a resource of `len` bytes carrying `range_header`.
///
/// No header is answered with the first window, since the whole file is the one answer that could
/// allocate gigabytes, and a media element asks for the rest once it sees `Accept-Ranges`. A header
/// that names nothing servable is `416`. Answering it with the first window as well told the client
/// the bytes it asked for were bytes `0-`, which a decoder then read as the wrong part of the file.
pub(crate) fn plan_range(range_header: Option<&str>, len: u64, cap: u64) -> RangePlan {
    if len == 0 {
        return RangePlan::Empty;
    }

    let (start, end) = match range_header {
        None => (0, len - 1),
        Some(header) => match parse_byte_range(header, len) {
            Some(range) => range,
            None => return RangePlan::Unsatisfiable,
        },
    };

    let (start, end) = clamp_range(start, end, len, cap);
    RangePlan::Window(start, end)
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

/// The status a failed `File::open` should answer with.
///
/// A missing file and an unreadable one are different answers to the caller. The library can name
/// a file that was deleted outside the app, which is a 404 the player reports as such, while a
/// permission or I/O error is this process failing and belongs in the 500 band. Its own function
/// rather than a match arm inside `handle`, which needs a `UriSchemeContext` no unit test can
/// build, so the decision is asserted on its own return value.
fn status_for_open_error(kind: std::io::ErrorKind) -> StatusCode {
    if kind == std::io::ErrorKind::NotFound {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

/// How many bytes an inclusive `start..=end` pair covers.
///
/// Separated for the same reason as the status above, and it carries the arithmetic the module docs
/// single out. This number sizes the body while `start` and `end` go into `Content-Range`, so an
/// off-by-one here is a response whose header and body disagree, which a media stack reads as
/// corrupt rather than short. Callers pass a pair `clamp_range` produced, where `end >= start`
/// always holds.
fn byte_count(start: u64, end: u64) -> u64 {
    end + 1 - start
}

fn empty_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// True when the decoded path climbs out of a directory anywhere along it.
///
/// Refused before the scope is asked, as Tauri's own `asset:` handler does through `SafePathBuf`.
/// The scope canonicalizes only a path that exists, and on Windows its globs let a `..` component
/// match, so a path that climbs out of the library and names nothing would pass the check and
/// answer 404 where one naming a real file answers 403. That difference says whether a file exists.
pub(crate) fn climbs_out_of_a_directory(path: &str) -> bool {
    Path::new(path)
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
}

/// The protocol's entry point. Hands the request to the blocking pool and answers from there.
///
/// Registered as an asynchronous protocol because a response is a read of up to
/// [`MAX_RANGE_BYTES`], and a synchronous handler runs it on the thread the webview calls it from,
/// which on Windows is the UI thread. Every seek in a long recording on a slow disk or a network
/// share then froze the window for the length of the read.
pub fn handle<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = context.app_handle().clone();

    tauri::async_runtime::spawn(async move {
        // At most MAX_CONCURRENT_MEDIA_READS reads at once, and a burst past MAX_MEDIA_READS_IN_FLIGHT
        // is refused rather than queued. Each read holds a blocking thread and a buffer of up to the
        // response window, and the blocking pool is the one every other command offloads to.
        let Ok(_permit) = MEDIA_READ_SEMAPHORE
            .acquire(crate::AppErrorCode::TooManyConcurrentYtDlpRuns)
            .await
        else {
            responder.respond(empty_response(StatusCode::SERVICE_UNAVAILABLE));
            return;
        };

        let response = tauri::async_runtime::spawn_blocking(move || serve(&app, &request)).await;

        responder.respond(
            response.unwrap_or_else(|_| empty_response(StatusCode::INTERNAL_SERVER_ERROR)),
        );
    });
}

/// How many media reads run at once. A player seeking issues a few range requests in quick
/// succession, and a handful is all one window needs.
const MAX_CONCURRENT_MEDIA_READS: usize = 4;

/// How many may wait behind them before further requests are refused.
const MAX_MEDIA_READS_IN_FLIGHT: usize = 32;

static MEDIA_READ_SEMAPHORE: crate::utils::bounded_semaphore::BoundedSemaphore =
    crate::utils::bounded_semaphore::BoundedSemaphore::new(
        MAX_CONCURRENT_MEDIA_READS,
        MAX_MEDIA_READS_IN_FLIGHT,
    );

/// The network share the configured library lives on, when it lives on one. Recorded when the
/// library's asset scope is registered (commands::security), which is the only time it changes.
fn library_share() -> &'static std::sync::Mutex<Option<String>> {
    static SHARE: std::sync::OnceLock<std::sync::Mutex<Option<String>>> =
        std::sync::OnceLock::new();
    SHARE.get_or_init(|| std::sync::Mutex::new(None))
}

/// Records the share of the library folder now being served, or clears it for a local library.
pub(crate) fn set_library_share(library_path: &str) {
    *library_share()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) =
        crate::utils::path::network_share_prefix(library_path);
}

/// Whether a request for `path` may reach the scope check at all.
///
/// The scope check resolves the path (it follows links and canonicalizes), and on Windows resolving
/// `\\host\share\...` authenticates to that host over SMB before any answer comes back. So a
/// network path is refused here, before that, unless it is on the very share the library is on,
/// which is the one case where serving one is the point.
fn may_resolve(path: &str, library_share: Option<&str>) -> bool {
    if !crate::utils::path::is_network_path(path) {
        return true;
    }

    match (
        crate::utils::path::network_share_prefix(path),
        library_share,
    ) {
        (Some(share), Some(library)) => share.eq_ignore_ascii_case(library),
        _ => false,
    }
}

/// Serves one request for a media file.
///
/// Refuses anything the asset-protocol scope would refuse, which is what keeps this from being a
/// second, looser way to read the disk. See the module docs.
pub(crate) fn serve<R: Runtime>(
    app: &AppHandle<R>,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    // Skip the leading `/` the URI always carries, then undo the encoding the renderer applied.
    let raw_path = request.uri().path();
    let path = percent_decode(raw_path.strip_prefix('/').unwrap_or(raw_path));

    if path.is_empty() || climbs_out_of_a_directory(&path) {
        return empty_response(StatusCode::BAD_REQUEST);
    }

    let share = library_share()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();

    if !may_resolve(&path, share.as_deref()) {
        return empty_response(StatusCode::FORBIDDEN);
    }

    // The one authorization check, and deliberately the same one the asset protocol makes rather
    // than a second implementation of it. The scope holds the media and thumbnail subdirectories of the
    // configured library and the two cache directories the webview renders from (see
    // commands::security), so a path outside them is refused here without this module knowing
    // anything about libraries.
    if !app.asset_protocol_scope().is_allowed(&path) {
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

    // Only a regular file is served. Opening a FIFO blocks until something writes to it, which
    // would hold one of the few read slots for good, and on Windows a device name such as `CON`
    // opens a device rather than a file. Neither is anything the app wrote.
    match std::fs::metadata(file_path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return empty_response(StatusCode::NOT_FOUND),
        Err(error) => return empty_response(status_for_open_error(error.kind())),
    }

    let mut file = match File::open(file_path) {
        Ok(file) => file,
        Err(error) => return empty_response(status_for_open_error(error.kind())),
    };

    let len = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(_) => return empty_response(StatusCode::INTERNAL_SERVER_ERROR),
    };

    let content_type = media_content_type(file_path);

    // A header that is not valid text is treated as one that names nothing servable.
    let range_header = request
        .headers()
        .get(http::header::RANGE)
        .map(|value| value.to_str().unwrap_or(""));

    let (start, end) = match plan_range(range_header, len, MAX_RANGE_BYTES) {
        RangePlan::Window(start, end) => (start, end),
        RangePlan::Empty => {
            return Response::builder()
                .status(StatusCode::OK)
                .header(http::header::CONTENT_TYPE, content_type)
                .header(http::header::ACCEPT_RANGES, "bytes")
                .header(http::header::CONTENT_LENGTH, 0)
                .body(Vec::new())
                .unwrap_or_else(|_| empty_response(StatusCode::INTERNAL_SERVER_ERROR));
        }
        RangePlan::Unsatisfiable => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(http::header::CONTENT_RANGE, format!("bytes */{len}"))
                .body(Vec::new())
                .unwrap_or_else(|_| empty_response(StatusCode::INTERNAL_SERVER_ERROR));
        }
    };

    let count = byte_count(start, end);

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
    fn a_local_path_may_always_reach_the_scope_check() {
        assert!(may_resolve(r"C:\Library\video\a.mp4", None));
        assert!(may_resolve(
            "/home/me/Library/video/a.mp4",
            Some(r"\\nas\media")
        ));
    }

    #[test]
    fn a_network_path_is_refused_before_it_is_resolved() {
        // Resolving it is what would authenticate to the host, so it never gets that far.
        assert!(!may_resolve(r"\\attacker\share\a.mp4", None));
        assert!(!may_resolve(
            r"\\attacker\share\a.mp4",
            Some(r"\\nas\media")
        ));
        assert!(!may_resolve("//attacker/share/a.mp4", None));
    }

    #[test]
    fn a_path_on_the_librarys_own_share_may_be_resolved() {
        let share = crate::utils::path::network_share_prefix(r"\\nas\media\Library");

        assert!(may_resolve(
            r"\\NAS\media\Library\video\a.mp4",
            share.as_deref()
        ));
    }

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

        // A `%` with only one byte behind it, ending the string. It has to pass through as-is
        // rather than be read past the end or swallowed. The renderer will not produce this, which
        // is the reason to test it. The path arrives from the webview and nothing on the way
        // promises it is well formed.
        assert_eq!(percent_decode("%4"), "%4");
        assert_eq!(percent_decode("video/100%4"), "video/100%4");
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
        // One byte, where start and end name the same offset. Legal per RFC 9110 and the boundary
        // the inverted-range check sits on, so refusing it would be a plausible off-by-one.
        assert_eq!(parse_byte_range("bytes=100-100", 4096), Some((100, 100)));
        assert_eq!(parse_byte_range("bytes=0-0", 4096), Some((0, 0)));
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

        // The rest of the table. Each arm is its own decision and an absent one falls through to
        // the octet-stream default, which the media stack reads as "do not try", so a dropped arm
        // is a file that stops playing rather than a wrong guess.
        assert_eq!(
            media_content_type(Path::new("video/a.mkv")),
            "video/x-matroska"
        );
        assert_eq!(
            media_content_type(Path::new("video/a.mov")),
            "video/quicktime"
        );
        assert_eq!(media_content_type(Path::new("video/a.m4v")), "video/mp4");
        assert_eq!(media_content_type(Path::new("audio/a.mp3")), "audio/mpeg");
        assert_eq!(media_content_type(Path::new("audio/a.ogg")), "audio/ogg");
        assert_eq!(media_content_type(Path::new("audio/a.flac")), "audio/flac");
        assert_eq!(media_content_type(Path::new("audio/a.wav")), "audio/wav");
        assert_eq!(media_content_type(Path::new("audio/a.aac")), "audio/aac");
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

    #[test]
    fn empty_response_carries_the_status_and_no_body() {
        // Every refusal in `handle` goes out through this, and the status is the entire message.
        // A body-less 200 would read to the media element as a zero-length file that loaded fine,
        // which is the one answer worse than any of these.
        for status in [
            StatusCode::BAD_REQUEST,
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
            StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            let response = empty_response(status);

            assert_eq!(response.status(), status);
            assert!(response.body().is_empty());
        }
    }

    #[test]
    fn status_for_open_error_separates_a_missing_file_from_a_broken_one() {
        // The library can name a file deleted outside the app, and the player reports that
        // honestly. Everything else is this process failing, and answering 404 for it would send
        // the user looking for a file that is sitting right there.
        assert_eq!(
            status_for_open_error(std::io::ErrorKind::NotFound),
            StatusCode::NOT_FOUND
        );

        for kind in [
            std::io::ErrorKind::PermissionDenied,
            std::io::ErrorKind::InvalidInput,
            std::io::ErrorKind::Other,
        ] {
            assert_eq!(
                status_for_open_error(kind),
                StatusCode::INTERNAL_SERVER_ERROR,
                "{kind:?} is this process failing, not a missing file"
            );
        }
    }

    #[test]
    fn byte_count_matches_the_pair_content_range_will_advertise() {
        // The count sizes the body and the pair goes in the header, so these two have to agree
        // exactly. A response whose header and body disagree by one byte reads as corrupt, not as
        // short, which is a worse failure than serving less.
        assert_eq!(byte_count(0, 0), 1);
        assert_eq!(byte_count(0, 1023), 1024);
        assert_eq!(byte_count(100, 100), 1);
        assert_eq!(byte_count(4096, 8191), 4096);

        // Against what clamp_range actually hands it, which is the only caller.
        let (start, end) = clamp_range(0, 100_000_000, 200_000_000, 16 * 1024 * 1024);
        assert_eq!(byte_count(start, end), 16 * 1024 * 1024);

        let (start, end) = clamp_range(10, 13, 1000, 16);
        assert_eq!(byte_count(start, end), 4);
    }

    // The cap's floor is pinned at compile time next to the constant itself (`const _: () =
    // assert!(..)`), rather than by a test here. Both sides are constants, so a runtime assertion
    // would be dead weight and clippy says so.

    #[test]
    fn plan_range_answers_each_kind_of_request() {
        assert_eq!(plan_range(None, 0, 16), RangePlan::Empty);
        assert_eq!(plan_range(Some("bytes=0-"), 0, 16), RangePlan::Empty);

        // No header: the first window, never the whole file.
        assert_eq!(plan_range(None, 100, 16), RangePlan::Window(0, 15));
        assert_eq!(plan_range(None, 10, 16), RangePlan::Window(0, 9));

        assert_eq!(
            plan_range(Some("bytes=40-49"), 100, 16),
            RangePlan::Window(40, 49)
        );
        assert_eq!(
            plan_range(Some("bytes=-5"), 100, 16),
            RangePlan::Window(95, 99)
        );

        // A header naming nothing servable is 416, not the first window.
        assert_eq!(
            plan_range(Some("bytes=100-"), 100, 16),
            RangePlan::Unsatisfiable
        );
        assert_eq!(
            plan_range(Some("bytes=9-3"), 100, 16),
            RangePlan::Unsatisfiable
        );
        assert_eq!(
            plan_range(Some("bytes=0-1,5-6"), 100, 16),
            RangePlan::Unsatisfiable
        );
        assert_eq!(plan_range(Some(""), 100, 16), RangePlan::Unsatisfiable);
    }

    #[test]
    fn a_path_that_climbs_out_of_a_directory_is_recognized() {
        assert!(climbs_out_of_a_directory("/lib/video/../../secret.txt"));
        assert!(climbs_out_of_a_directory("../x.mp4"));
        assert!(!climbs_out_of_a_directory("/lib/video/clip.mp4"));
        // A name that merely contains dots is not a parent component.
        assert!(!climbs_out_of_a_directory("/lib/video/clip..final.mp4"));
        assert!(!climbs_out_of_a_directory("/lib/video/..hidden.mp4"));
    }

    #[cfg(windows)]
    #[test]
    fn a_backslash_spelling_of_the_climb_is_recognized_on_windows() {
        // What `%5C..%5C` in a request decodes to. The case the existence oracle needed.
        assert!(climbs_out_of_a_directory(
            r"C:\lib\video\..\..\Users\me\secret.txt"
        ));
    }

    /// A request for `path` the way the renderer builds one, with the characters `convertFileSrc`
    /// escapes that a test path can contain.
    fn request_for(path: &Path) -> Request<Vec<u8>> {
        let encoded = path
            .to_string_lossy()
            .replace('%', "%25")
            .replace('\\', "%5C")
            .replace(':', "%3A")
            .replace(' ', "%20");

        Request::builder()
            .uri(format!("http://kvxmedia.localhost/{encoded}"))
            .body(Vec::new())
            .unwrap()
    }

    /// A mock app whose asset scope grants `dir`, in both spellings, the way
    /// `register_library_asset_scope` does.
    fn app_granting(dir: &Path) -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let scope = app.asset_protocol_scope();
        scope.allow_directory(dir, true).unwrap();
        scope
            .allow_directory(dir.canonicalize().unwrap(), true)
            .unwrap();
        app
    }

    #[test]
    fn serve_answers_a_file_inside_the_scope_and_refuses_everything_else() {
        let root = std::env::temp_dir().join(format!(
            "kavynex-media-protocol-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        let library = root.join("library");
        std::fs::create_dir_all(&library).unwrap();
        let outside = root.join("outside.mp4");
        std::fs::write(&outside, b"not the library's").unwrap();
        let inside = library.join("clip.mp4");
        std::fs::write(&inside, b"media bytes").unwrap();

        let app = app_granting(&library);

        let ok = serve(app.handle(), &request_for(&inside));
        assert_eq!(ok.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(ok.body(), b"media bytes");

        // The authorization check itself. A path the scope never granted is refused.
        let refused = serve(app.handle(), &request_for(&outside));
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        assert!(refused.body().is_empty());

        // Granted directory, file gone. The player reports this as missing.
        let missing = serve(app.handle(), &request_for(&library.join("gone.mp4")));
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);

        // Something inside the scope that is not a regular file is not opened.
        let folder = library.join("folder.mp4");
        std::fs::create_dir_all(&folder).unwrap();
        let not_a_file = serve(app.handle(), &request_for(&folder));
        assert_eq!(not_a_file.status(), StatusCode::NOT_FOUND);

        // An empty file is an empty 200, not a failed read.
        let empty = library.join("empty.mp4");
        std::fs::write(&empty, b"").unwrap();
        let answered = serve(app.handle(), &request_for(&empty));
        assert_eq!(answered.status(), StatusCode::OK);
        assert!(answered.body().is_empty());

        // A range past the end is 416 with the length to ask again with.
        let mut past_the_end = request_for(&inside);
        past_the_end
            .headers_mut()
            .insert(http::header::RANGE, "bytes=500-".parse().unwrap());
        let refused_range = serve(app.handle(), &past_the_end);
        assert_eq!(refused_range.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            refused_range.headers()[http::header::CONTENT_RANGE],
            "bytes */11"
        );

        // A climb out of the granted directory is refused before the scope is asked, whether or
        // not the file it names exists, so the two answers cannot be told apart.
        for name in ["outside.mp4", "nothing-here.mp4"] {
            let climbing = library.join("..").join(name);
            let answer = serve(app.handle(), &request_for(&climbing));
            assert_eq!(answer.status(), StatusCode::BAD_REQUEST);
        }

        let _ = std::fs::remove_dir_all(&root);
    }
}
