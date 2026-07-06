//! Reading child-process output without dropping lines on invalid UTF-8.

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

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
pub async fn read_lossy_line<R>(reader: &mut R, buf: &mut Vec<u8>) -> Option<String>
where
    R: AsyncBufRead + Unpin,
{
    buf.clear();

    match reader.read_until(b'\n', buf).await {
        Ok(0) | Err(_) => None,
        Ok(_) => {
            while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
                buf.pop();
            }

            Some(String::from_utf8_lossy(buf).to_string())
        }
    }
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
}
