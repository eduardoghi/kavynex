//! Reading child-process output without dropping lines on invalid UTF-8.

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

// Some callers (yt-dlp's `--dump-single-json`, optionally with `--write-comments`) legitimately
// emit a single line up to their own cap (128 MiB, see `MAX_YT_DLP_JSON_BYTES` in
// `yt_dlp_metadata.rs`). This stays comfortably above that so normal reading is never
// truncated, while still bounding the otherwise-unbounded growth of a line that never ends
// (e.g. a hung/misbehaving process writing to stdout/stderr with no newline).
const MAX_LINE_BYTES: usize = 256 * 1024 * 1024; // 256 MiB

/// Reads the next `\n`-terminated line from `reader`, decoding it lossily.
///
/// Unlike `AsyncBufReadExt::lines()` (whose `next_line` yields `Err` the moment a line holds
/// a byte that is not valid UTF-8, silently ending the common `while let Ok(Some(_))` loop),
/// this reads raw bytes and replaces invalid sequences with U+FFFD. A single garbled line
/// from yt-dlp/ffmpeg therefore no longer aborts progress parsing (which would starve the
/// stall watchdog) or truncate a JSON payload.
///
/// The trailing `\n`, and a `\r` before it, are stripped. Returns `None` at end of stream or
/// on a genuine I/O error. `buf` is reused across calls to avoid a per-line allocation.
///
/// A line longer than `MAX_LINE_BYTES` is truncated rather than buffered without limit: bytes
/// past the cap are still consumed from `reader` (so the next call resumes at the following
/// line) but are not appended to `buf`.
pub async fn read_lossy_line<R>(reader: &mut R, buf: &mut Vec<u8>) -> Option<String>
where
    R: AsyncBufRead + Unpin,
{
    read_lossy_line_capped(reader, buf, MAX_LINE_BYTES).await
}

async fn read_lossy_line_capped<R>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    max_bytes: usize,
) -> Option<String>
where
    R: AsyncBufRead + Unpin,
{
    buf.clear();
    let mut read_any = false;

    loop {
        let available = match reader.fill_buf().await {
            Ok(bytes) => bytes,
            Err(_) => return None,
        };

        if available.is_empty() {
            // End of stream.
            break;
        }

        read_any = true;

        match available.iter().position(|&byte| byte == b'\n') {
            Some(newline_pos) => {
                if buf.len() < max_bytes {
                    let take = newline_pos.min(max_bytes - buf.len());
                    buf.extend_from_slice(&available[..take]);
                }
                reader.consume(newline_pos + 1);
                break;
            }
            None => {
                if buf.len() < max_bytes {
                    let take = available.len().min(max_bytes - buf.len());
                    buf.extend_from_slice(&available[..take]);
                }
                let consumed = available.len();
                reader.consume(consumed);
            }
        }
    }

    if !read_any {
        return None;
    }

    while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
        buf.pop();
    }

    Some(String::from_utf8_lossy(buf).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn reads_sequential_lines_and_strips_crlf() {
        let data = b"first\r\nsecond\nthird".to_vec();
        let mut reader = BufReader::new(&data[..]);
        let mut buf = Vec::new();

        assert_eq!(
            read_lossy_line(&mut reader, &mut buf).await.as_deref(),
            Some("first")
        );
        assert_eq!(
            read_lossy_line(&mut reader, &mut buf).await.as_deref(),
            Some("second")
        );
        // A final line with no trailing newline is still returned.
        assert_eq!(
            read_lossy_line(&mut reader, &mut buf).await.as_deref(),
            Some("third")
        );
        assert_eq!(read_lossy_line(&mut reader, &mut buf).await, None);
    }

    #[tokio::test]
    async fn recovers_from_invalid_utf8_instead_of_stopping() {
        // A line with invalid UTF-8 bytes sits between two valid lines. The old
        // `lines().next_line()` loop would stop at the invalid line; this must decode it
        // lossily and keep reading the line after it.
        let mut data: Vec<u8> = b"before\n".to_vec();
        data.extend_from_slice(&[0xff, 0xfe]);
        data.extend_from_slice(b"\nafter\n");

        let mut reader = BufReader::new(&data[..]);
        let mut buf = Vec::new();

        assert_eq!(
            read_lossy_line(&mut reader, &mut buf).await.as_deref(),
            Some("before")
        );

        let garbled = read_lossy_line(&mut reader, &mut buf).await.unwrap();
        assert!(garbled.contains('\u{fffd}'));

        assert_eq!(
            read_lossy_line(&mut reader, &mut buf).await.as_deref(),
            Some("after")
        );
        assert_eq!(read_lossy_line(&mut reader, &mut buf).await, None);
    }

    #[tokio::test]
    async fn capped_line_reader_truncates_a_line_longer_than_the_cap() {
        // "01234567\n" - an 8-byte line capped at 4 bytes must not buffer the whole line.
        let data = b"01234567\nafter\n".to_vec();
        let mut reader = BufReader::new(&data[..]);
        let mut buf = Vec::new();

        let line = read_lossy_line_capped(&mut reader, &mut buf, 4)
            .await
            .unwrap();
        assert_eq!(line, "0123");

        // The stream stays in sync: the next line reads normally past the truncated one.
        let next = read_lossy_line_capped(&mut reader, &mut buf, 4)
            .await
            .unwrap();
        assert_eq!(next, "afte");
    }

    #[tokio::test]
    async fn capped_line_reader_truncates_a_line_with_no_terminator_at_all() {
        // A line that never ends (no trailing newline, e.g. a hung process) must still be
        // bounded rather than buffered without limit.
        let data = b"0123456789".to_vec();
        let mut reader = BufReader::new(&data[..]);
        let mut buf = Vec::new();

        let line = read_lossy_line_capped(&mut reader, &mut buf, 4)
            .await
            .unwrap();
        assert_eq!(line, "0123");
        assert_eq!(read_lossy_line_capped(&mut reader, &mut buf, 4).await, None);
    }

    #[tokio::test]
    async fn capped_line_reader_reads_normal_short_lines_unchanged() {
        let data = b"first\nsecond\n".to_vec();
        let mut reader = BufReader::new(&data[..]);
        let mut buf = Vec::new();

        assert_eq!(
            read_lossy_line_capped(&mut reader, &mut buf, 1024)
                .await
                .as_deref(),
            Some("first")
        );
        assert_eq!(
            read_lossy_line_capped(&mut reader, &mut buf, 1024)
                .await
                .as_deref(),
            Some("second")
        );
    }
}
