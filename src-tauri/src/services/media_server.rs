//! Serves the library's media to the player over plain HTTP on the loopback address, on Linux.
//!
//! # Why this exists
//!
//! On Linux the webview is WebKitGTK, which plays media through GStreamer, and GStreamer opens only
//! the schemes it has a source element for (`http`, `https`, `file`, `blob` and a few others). A
//! custom scheme such as `kvxmedia://` (`services::media_protocol`) reaches the scheme handler but
//! never the media player, which gives up at once with `FormatError`, before reading a byte. So on
//! Linux the built-in player played nothing, whatever the file. WebKit tracks it as bug 146351, open
//! since 2015, and its media maintainer's answer there is that the media player has no support for
//! custom schemes. Measured on WebKitGTK 2.54.2 with GStreamer 1.28 and every plugin installed, the
//! same WebM failed through a custom scheme and played through `file://`.
//!
//! `file://` is not an option, since it would hand the renderer every file on the disk. A loopback
//! HTTP server is a scheme GStreamer opens, and it can apply the same guard as the custom scheme.
//! Windows and macOS keep `kvxmedia://`, which works there, and never start this server.
//!
//! # What guards it
//!
//! - It listens on `127.0.0.1` only, on a port the system picks at each launch.
//! - Every URL carries a 256-bit token drawn at launch from the operating system's random source
//!   (`MediaServer::origin`), and a request without it is refused. Another program on the machine,
//!   or a web page in a browser, can find the port but cannot read anything through it.
//! - The `Host` header must name the loopback address and the port, which turns away a page that
//!   points a domain of its own at `127.0.0.1` (DNS rebinding).
//! - Only `GET` and `HEAD` are answered.
//! - What passes all of that is opened by `media_protocol::open_media`, the custom scheme's own
//!   checks, so the asset-protocol scope check and the path refusals are the same ones and live in
//!   one place.
//!
//! # Why it streams the whole range
//!
//! The custom scheme answers at most 16 MiB per request, because wry hands its body to the webview
//! as one in-memory copy. Served the same way here, playback broke. WebKitGTK downloads a media
//! element's file through GStreamer's download buffer, which reads a response that stops short as
//! the end of the file, so seeking landed on the start or the end and playback stuttered. This
//! server answers the range that was asked for, in full, read from the disk in
//! [`STREAM_CHUNK_BYTES`] pieces as the connection takes them, so nothing larger than a piece is
//! ever held.

use std::convert::Infallible;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::net::{Ipv4Addr, SocketAddr, TcpListener as StdTcpListener};
use std::pin::Pin;
use std::sync::OnceLock;
use std::task::{Context, Poll};

use http::{Method, Request, Response, StatusCode};
use http_body_util::{Either, Full};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tauri::{AppHandle, Runtime};

/// How many random bytes the token carries. 32 is 256 bits, which no guessing over a socket reaches.
const TOKEN_BYTES: usize = 32;

/// How much of a range one read takes from the disk while it streams.
const STREAM_CHUNK_BYTES: u64 = 256 * 1024;

/// What a response carries, nothing (a refusal, a `HEAD`) or a range streamed from the disk.
type ResponseBody = Either<Full<Bytes>, FileRangeBody>;

/// The origin and token the running server answers to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MediaServer {
    /// `127.0.0.1:<port>`, which is also the only `Host` header accepted.
    host: String,
    token: String,
}

impl MediaServer {
    /// The prefix the renderer puts in front of an encoded path, `http://127.0.0.1:<port>/<token>`.
    pub(crate) fn origin(&self) -> String {
        format!("http://{}/{}", self.host, self.token)
    }
}

static SERVER: OnceLock<MediaServer> = OnceLock::new();

/// The running server, when one was started. Always `None` off Linux.
pub(crate) fn running() -> Option<&'static MediaServer> {
    SERVER.get()
}

/// What [`admit`] decided for one request.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Admission {
    /// Serve it, as a request for this path (the encoded file path after the token, with its `/`).
    Serve(String),
    Refuse(StatusCode),
}

/// Decides whether a request may reach the media handler, from its method, `Host` header and path.
/// Pure, so every refusal is tested without a socket.
pub(crate) fn admit(
    server: &MediaServer,
    method: &Method,
    host: Option<&str>,
    path: &str,
) -> Admission {
    if method != Method::GET && method != Method::HEAD {
        return Admission::Refuse(StatusCode::METHOD_NOT_ALLOWED);
    }

    if host != Some(server.host.as_str()) {
        return Admission::Refuse(StatusCode::FORBIDDEN);
    }

    let Some(rest) = path.strip_prefix('/') else {
        return Admission::Refuse(StatusCode::NOT_FOUND);
    };

    let (token, file) = match rest.split_once('/') {
        Some((token, file)) => (token, file),
        None => (rest, ""),
    };

    if !tokens_match(token, &server.token) || file.is_empty() {
        return Admission::Refuse(StatusCode::NOT_FOUND);
    }

    Admission::Serve(format!("/{file}"))
}

/// Compares the token without returning at the first differing byte, so the time a refusal takes
/// does not say how much of a guess was right.
fn tokens_match(candidate: &str, token: &str) -> bool {
    if candidate.len() != token.len() {
        return false;
    }

    candidate
        .bytes()
        .zip(token.bytes())
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

/// A fresh token, as lowercase hex.
fn draw_token() -> std::io::Result<String> {
    let mut bytes = [0_u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| std::io::Error::other(error.to_string()))?;

    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

// Called from `lib.rs` on Linux only, and by the tests everywhere.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
/// Binds the server and starts answering. The socket is bound here, synchronously, so the origin
/// is known before the window can ask for it (`commands::media::media_server_origin`), and the
/// connections are served on the async runtime.
pub(crate) fn start<R: Runtime>(app: AppHandle<R>) -> std::io::Result<()> {
    let listener = StdTcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
    listener.set_nonblocking(true)?;

    let server = MediaServer {
        host: format!("127.0.0.1:{}", listener.local_addr()?.port()),
        token: draw_token()?,
    };

    if SERVER.set(server.clone()).is_err() {
        return Err(std::io::Error::other(
            "the media server was already started",
        ));
    }

    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                crate::services::logger::error(
                    "media_server",
                    format!("failed to start serving media: {error}"),
                );
                return;
            }
        };

        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };

            let app = app.clone();
            let server = server.clone();

            tauri::async_runtime::spawn(async move {
                let service =
                    service_fn(move |request| answer(app.clone(), server.clone(), request));

                // A connection that ends badly (the player dropping a range it no longer wants
                // after a seek) is ordinary and logs nothing.
                let _ = http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });

    Ok(())
}

/// Answers one request, through [`admit`] and the custom scheme's checks, streaming the range.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
async fn answer<R: Runtime>(
    app: AppHandle<R>,
    server: MediaServer,
    request: Request<Incoming>,
) -> Result<Response<ResponseBody>, Infallible> {
    use crate::services::media_protocol::{open_media, plan_range, RangePlan};

    let host = request
        .headers()
        .get(http::header::HOST)
        .and_then(|value| value.to_str().ok());

    let path = match admit(&server, request.method(), host, request.uri().path()) {
        Admission::Serve(path) => path,
        Admission::Refuse(status) => return Ok(empty(status)),
    };

    // A header that is not valid text names nothing servable, as in the custom scheme.
    let range_header = request
        .headers()
        .get(http::header::RANGE)
        .map(|value| value.to_str().unwrap_or("").to_string());
    let is_head = request.method() == Method::HEAD;

    // The checks take the request the custom scheme would have received, the path after the token.
    let Ok(forwarded) = Request::builder().uri(path).body(Vec::new()) else {
        return Ok(empty(StatusCode::BAD_REQUEST));
    };

    let opened = tauri::async_runtime::spawn_blocking(move || open_media(&app, &forwarded)).await;

    let media = match opened {
        Ok(Ok(media)) => media,
        Ok(Err(status)) => return Ok(empty(status)),
        Err(_) => return Ok(empty(StatusCode::INTERNAL_SERVER_ERROR)),
    };

    let headers = Response::builder()
        .header(http::header::CONTENT_TYPE, media.content_type)
        .header(http::header::ACCEPT_RANGES, "bytes");

    let response = match plan_range(range_header.as_deref(), media.len, u64::MAX) {
        RangePlan::Empty => headers
            .status(StatusCode::OK)
            .header(http::header::CONTENT_LENGTH, 0)
            .body(Either::Left(Full::new(Bytes::new()))),
        RangePlan::Unsatisfiable => headers
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(
                http::header::CONTENT_RANGE,
                format!("bytes */{}", media.len),
            )
            .body(Either::Left(Full::new(Bytes::new()))),
        RangePlan::Window(start, end) => {
            // No `Range` is the whole file as a 200, the plain answer to a plain request.
            let headers = match range_header {
                Some(_) => headers.status(StatusCode::PARTIAL_CONTENT).header(
                    http::header::CONTENT_RANGE,
                    format!("bytes {start}-{end}/{}", media.len),
                ),
                None => headers.status(StatusCode::OK),
            };

            let body = if is_head {
                Either::Left(Full::new(Bytes::new()))
            } else {
                Either::Right(stream_range(media.file, start, end))
            };

            headers
                .header(http::header::CONTENT_LENGTH, end - start + 1)
                .body(body)
        }
    };

    Ok(response.unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR)))
}

/// A range of a file, read from the disk as the connection takes it.
pub(crate) struct FileRangeBody {
    chunks: tokio::sync::mpsc::Receiver<std::io::Result<Bytes>>,
}

impl hyper::body::Body for FileRangeBody {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, std::io::Error>>> {
        self.chunks
            .poll_recv(context)
            .map(|chunk| chunk.map(|read| read.map(Frame::data)))
    }
}

/// Starts reading bytes `start..=end` of `file` on the blocking pool, a piece at a time.
///
/// The channel holds a couple of pieces, so the read waits on the connection rather than running
/// ahead of it, and stops as soon as the player drops the connection (after a seek, typically),
/// which closes the channel.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn stream_range(mut file: File, start: u64, end: u64) -> FileRangeBody {
    let (sender, chunks) = tokio::sync::mpsc::channel(2);

    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = file.seek(SeekFrom::Start(start)) {
            let _ = sender.blocking_send(Err(error));
            return;
        }

        let mut left = end - start + 1;

        while left > 0 {
            let mut piece = vec![0_u8; left.min(STREAM_CHUNK_BYTES) as usize];

            if let Err(error) = file.read_exact(&mut piece) {
                let _ = sender.blocking_send(Err(error));
                return;
            }

            left -= piece.len() as u64;

            if sender.blocking_send(Ok(Bytes::from(piece))).is_err() {
                return;
            }
        }
    });

    FileRangeBody { chunks }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn empty(status: StatusCode) -> Response<ResponseBody> {
    let mut response = Response::new(Either::Left(Full::new(Bytes::new())));
    *response.status_mut() = status;
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> MediaServer {
        MediaServer {
            host: "127.0.0.1:4242".to_string(),
            token: "a".repeat(TOKEN_BYTES * 2),
        }
    }

    fn path(file: &str) -> String {
        format!("/{}/{file}", "a".repeat(TOKEN_BYTES * 2))
    }

    #[test]
    fn a_request_with_the_token_and_the_loopback_host_is_served_as_the_file_path() {
        assert_eq!(
            admit(
                &server(),
                &Method::GET,
                Some("127.0.0.1:4242"),
                &path("%2Flib%2Fvideo%2Fa.mp4")
            ),
            Admission::Serve("/%2Flib%2Fvideo%2Fa.mp4".to_string())
        );
        assert_eq!(
            admit(&server(), &Method::HEAD, Some("127.0.0.1:4242"), &path("x")),
            Admission::Serve("/x".to_string())
        );
    }

    #[test]
    fn a_method_other_than_get_or_head_is_refused() {
        for method in [Method::POST, Method::PUT, Method::DELETE, Method::OPTIONS] {
            assert_eq!(
                admit(&server(), &method, Some("127.0.0.1:4242"), &path("x")),
                Admission::Refuse(StatusCode::METHOD_NOT_ALLOWED),
                "{method}"
            );
        }
    }

    #[test]
    fn a_host_other_than_the_loopback_address_and_port_is_refused() {
        // A page that points a domain of its own at 127.0.0.1 sends that domain as the Host.
        for host in [
            None,
            Some("evil.example:4242"),
            Some("localhost:4242"),
            Some("127.0.0.1:4243"),
        ] {
            assert_eq!(
                admit(&server(), &Method::GET, host, &path("x")),
                Admission::Refuse(StatusCode::FORBIDDEN),
                "{host:?}"
            );
        }
    }

    #[test]
    fn a_missing_or_wrong_token_is_refused_as_not_found() {
        let wrong = format!("/{}/x", "b".repeat(TOKEN_BYTES * 2));
        let short = format!("/{}/x", "a".repeat(TOKEN_BYTES * 2 - 1));

        for request_path in ["/", "/x", "", wrong.as_str(), short.as_str(), &path("")] {
            assert_eq!(
                admit(
                    &server(),
                    &Method::GET,
                    Some("127.0.0.1:4242"),
                    request_path
                ),
                Admission::Refuse(StatusCode::NOT_FOUND),
                "{request_path}"
            );
        }
    }

    #[test]
    fn the_origin_names_the_host_and_the_token() {
        assert_eq!(
            server().origin(),
            format!("http://127.0.0.1:4242/{}", "a".repeat(TOKEN_BYTES * 2))
        );
    }

    #[test]
    fn a_drawn_token_is_hex_of_the_full_length_and_differs_each_time() {
        let first = draw_token().unwrap();
        let second = draw_token().unwrap();

        assert_eq!(first.len(), TOKEN_BYTES * 2);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    /// Sends one raw HTTP/1.1 request to the running server and returns the whole answer.
    async fn send(host: &str, request_line: &str, extra_headers: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let mut stream = tokio::net::TcpStream::connect(host).await.unwrap();
        stream
            .write_all(
                format!(
                    "{request_line}\r\nHost: {host}\r\n{extra_headers}Connection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();

        let mut answer = Vec::new();
        stream.read_to_end(&mut answer).await.unwrap();
        String::from_utf8_lossy(&answer).into_owned()
    }

    // The one test that starts the real server, since it can be started once per process.
    #[tokio::test]
    async fn the_running_server_serves_a_granted_file_by_range_and_refuses_without_the_token() {
        let library = std::env::temp_dir().join(format!(
            "kavynex-media-server-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&library).unwrap();
        let inside = library.join("clip.mp4");
        std::fs::write(&inside, b"media bytes").unwrap();

        let app = crate::services::media_protocol::tests::app_granting(&library);
        start(app.handle().clone()).unwrap();
        let server = running().expect("the server is running").clone();

        let encoded: String = inside
            .to_string_lossy()
            .bytes()
            .map(|byte| format!("%{byte:02X}"))
            .collect();
        let get = format!("GET /{}/{encoded} HTTP/1.1", server.token);

        let whole = send(&server.host, &get, "").await;
        assert!(whole.starts_with("HTTP/1.1 200"), "{whole}");
        assert!(whole.ends_with("media bytes"), "{whole}");

        let ranged = send(&server.host, &get, "Range: bytes=6-\r\n").await;
        assert!(ranged.contains("content-range: bytes 6-10/11"), "{ranged}");
        assert!(ranged.ends_with("bytes"), "{ranged}");

        let head = send(
            &server.host,
            &format!("HEAD /{}/{encoded} HTTP/1.1", server.token),
            "",
        )
        .await;
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert!(head.contains("content-length: 11"), "{head}");
        assert!(!head.contains("media bytes"), "{head}");

        // A range is answered in full, past the custom scheme's 16 MiB window, since GStreamer's
        // download buffer reads a short answer as the end of the file.
        let large = library.join("large.mp4");
        let large_len: usize = 16 * 1024 * 1024 + 1000;
        std::fs::write(&large, vec![7_u8; large_len]).unwrap();
        let large_encoded: String = large
            .to_string_lossy()
            .bytes()
            .map(|byte| format!("%{byte:02X}"))
            .collect();
        let past_window = send(
            &server.host,
            &format!("GET /{}/{large_encoded} HTTP/1.1", server.token),
            "Range: bytes=10-\r\n",
        )
        .await;
        let header_end = past_window.find("\r\n\r\n").unwrap() + 4;
        assert!(
            past_window.starts_with("HTTP/1.1 206"),
            "{}",
            &past_window[..header_end]
        );
        assert!(
            past_window.contains(&format!(
                "content-range: bytes 10-{}/{large_len}",
                large_len - 1
            )),
            "{}",
            &past_window[..header_end]
        );
        assert_eq!(past_window.len() - header_end, large_len - 10);

        let refused_range = send(&server.host, &get, "Range: bytes=500-\r\n").await;
        assert!(refused_range.starts_with("HTTP/1.1 416"), "{refused_range}");

        let no_token = send(&server.host, &format!("GET /{encoded} HTTP/1.1"), "").await;
        assert!(no_token.starts_with("HTTP/1.1 404"), "{no_token}");

        let _ = std::fs::remove_dir_all(&library);
    }

    #[test]
    fn tokens_match_only_when_equal() {
        assert!(tokens_match("abc", "abc"));
        assert!(!tokens_match("abd", "abc"));
        assert!(!tokens_match("ab", "abc"));
        assert!(!tokens_match("", "abc"));
    }
}
