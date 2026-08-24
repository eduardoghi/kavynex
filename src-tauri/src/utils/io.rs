//! Reading child-process output without dropping lines on invalid UTF-8.

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

// Some callers (yt-dlp's `--dump-single-json`, optionally with `--write-comments`) legitimately
// emit a single line up to their own cap (128 MiB, see `MAX_YT_DLP_JSON_BYTES` in
// `yt_dlp/metadata.rs`). This stays comfortably above that so normal reading is never
// truncated, while still bounding the otherwise-unbounded growth of a line that never ends
// (e.g. a hung/misbehaving process writing to stdout/stderr with no newline).
const MAX_LINE_BYTES: usize = 256 * 1024 * 1024; // 256 MiB

/// A cap for line-oriented output. Yt-dlp/ffmpeg progress lines and stderr messages, which are
/// always short. Fixed-size ring buffers keep the last N such lines for a failure message; without
/// a per-line bound a misbehaving process emitting one enormous unterminated line would let a
/// single buffered line (times N) balloon memory far past intent. Distinct from `MAX_LINE_BYTES`,
/// which is sized for the one multi-MiB JSON line `--dump-single-json` legitimately emits and must
/// not truncate.
pub const MAX_PROGRESS_LINE_BYTES: usize = 64 * 1024; // 64 KiB

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

/// Like [`read_lossy_line`] but with a caller-chosen byte cap, for line-oriented readers that
/// should bound each line tightly (see [`MAX_PROGRESS_LINE_BYTES`]).
pub async fn read_lossy_line_capped<R>(
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
        // "01234567\n". An 8-byte line capped at 4 bytes must not buffer the whole line.
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

    // The cap arithmetic is `max_bytes - buf.len()`, and every test above reads from a slice, whose
    // `fill_buf` hands back everything at once. The subtraction is therefore only ever evaluated
    // with an empty buffer, where `max_bytes - 0` and `max_bytes + 0` agree, so a `-` flipped to `+`
    // changes nothing observable and the bound goes unpinned. `with_capacity` is what forces the
    // second chunk to be measured against a buffer that already holds bytes, which is the only
    // arrangement where the two spellings disagree. The same gap, in the same shape, was found in
    // `thumbnail::download::process::read_drain_capped_async` and is recorded in
    // docs/MUTATION-TESTING.md as the lesson this test applies.
    #[tokio::test]
    async fn a_line_spanning_several_chunks_is_capped_at_the_cap_not_past_it() {
        // Four-byte chunks against a six-byte cap: the second chunk straddles it, so `take` is
        // computed with `buf.len() == 4` rather than 0.
        let data = b"0123456789ABCDEF\nafter\n".to_vec();
        let mut reader = BufReader::with_capacity(4, &data[..]);
        let mut buf = Vec::new();

        let line = read_lossy_line_capped(&mut reader, &mut buf, 6)
            .await
            .unwrap();

        // With the subtraction flipped to an addition the bound becomes `6 + 4`, so the straddling
        // chunk is copied whole and the line comes back as "01234567".
        assert_eq!(line, "012345");
        assert_eq!(
            line.len(),
            6,
            "a line assembled from several chunks must still stop at the cap"
        );

        // The stream stays in sync past the truncated line, as in the single-chunk case.
        let next = read_lossy_line_capped(&mut reader, &mut buf, 16)
            .await
            .unwrap();
        assert_eq!(next, "after");
    }

    #[tokio::test]
    async fn a_terminator_arriving_after_the_cap_is_reached_does_not_reopen_it() {
        // The sibling of the test above for the *newline* branch: the chunk carrying the `\n` is
        // the one measured against a non-empty buffer, so it pins the second copy of the same
        // arithmetic. Six-byte cap, and the newline lands in the second four-byte chunk.
        let data = b"0123456\n".to_vec();
        let mut reader = BufReader::with_capacity(4, &data[..]);
        let mut buf = Vec::new();

        let line = read_lossy_line_capped(&mut reader, &mut buf, 6)
            .await
            .unwrap();

        assert_eq!(line, "012345");
        assert_eq!(read_lossy_line_capped(&mut reader, &mut buf, 6).await, None);
    }

    // The two ceilings are load-bearing numbers rather than round decoration, and nothing else
    // reads them back: `MAX_LINE_BYTES` has to stay clear of the 128 MiB JSON payload
    // `--dump-single-json` legitimately emits (truncating that corrupts the parse), while
    // `MAX_PROGRESS_LINE_BYTES` is multiplied by a ring buffer's length, so an arithmetic slip
    // there is a memory bound moving by orders of magnitude. Same reasoning as
    // `the_live_chat_decompression_ceiling_is_512_mib`.
    #[test]
    fn the_line_ceilings_are_the_sizes_they_are_written_as() {
        assert_eq!(MAX_LINE_BYTES, 268_435_456);
        assert_eq!(MAX_PROGRESS_LINE_BYTES, 65_536);

        // A `const` block rather than a plain assert: both sides are constants, so this is decided
        // at compile time and fails the build rather than a test run, which is the earlier of the
        // two places to learn that the general cap dropped below the JSON payload yt-dlp may
        // legitimately emit. (A bare `assert!` over constants is what clippy refuses here.)
        const {
            assert!(MAX_LINE_BYTES > 128 * 1024 * 1024);
        }
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
