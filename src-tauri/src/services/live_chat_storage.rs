use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, Write};
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;

use crate::services::filesystem::{fsync_file, replace_file_safely};
use crate::{AppError, AppErrorCode, AppResult};

#[derive(Debug, Default, Clone)]
pub struct LiveChatCompressionSummary {
    pub scanned: usize,
    pub compressed: usize,
    pub already_compressed: usize,
    pub failed: usize,
}

// Ceiling on the decompressed size of a live chat file. Generous enough for even a very dense
// multi-hour stream, but bounded so a crafted tiny gzip (a decompression bomb dropped into the
// library folder) cannot expand without limit and exhaust memory when the file is opened.
const MAX_LIVE_CHAT_DECOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;

fn compress_error(context: &str, error: impl std::fmt::Display) -> AppError {
    AppError::from_code(
        AppErrorCode::LiveChatCompressFailed,
        format!("{context}: {error}"),
    )
}

/// gzip files start with the magic bytes 0x1f 0x8b.
pub fn is_gzip(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b
}

pub fn gzip_compress(data: &[u8]) -> AppResult<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(data)
        .map_err(|e| compress_error("failed to gzip live chat data", e))?;
    encoder
        .finish()
        .map_err(|e| compress_error("failed to finish gzip stream", e))
}

fn gzip_decompress_with_limit(data: &[u8], max_bytes: u64) -> AppResult<Vec<u8>> {
    // Read at most one byte past the limit so a file that lands exactly on the ceiling still
    // decodes, while anything larger is caught below without materializing all of it.
    let mut limited = GzDecoder::new(data).take(max_bytes.saturating_add(1));
    let mut out = Vec::new();
    limited
        .read_to_end(&mut out)
        .map_err(|e| compress_error("failed to gunzip live chat data", e))?;

    if out.len() as u64 > max_bytes {
        return Err(compress_error(
            "live chat file is too large when decompressed",
            format!("decompressed size exceeds the {max_bytes}-byte limit"),
        ));
    }

    Ok(out)
}

pub fn gzip_decompress(data: &[u8]) -> AppResult<Vec<u8>> {
    gzip_decompress_with_limit(data, MAX_LIVE_CHAT_DECOMPRESSED_BYTES)
}

/// How many replay lines are grouped into one streamed batch. Large enough that per-message IPC
/// overhead is negligible, small enough that only a bounded slice of the file is ever in memory.
pub const LIVE_CHAT_STREAM_BATCH_LINES: usize = 500;

/// Streams a stored live chat file to `emit`, one batch of lines at a time, transparently
/// gunzipping the gzip-compressed files (older files may still be plain JSON and stream as-is).
/// The whole decompressed payload is never held in memory: the previous read returned the entire
/// file as one `String`, which for a long dense stream is hundreds of MB, and the frontend then
/// held a second copy across the IPC boundary before parsing. Here only a bounded batch is alive
/// at once, and only the compact parsed messages are retained on the frontend.
///
/// The two ways this fails are told apart rather than sharing one code, because they call for
/// opposite things from the user: a file that was moved or deleted can be put back
/// (`LiveChatFileNotFound`), while a corrupt or oversized archive cannot and only the backup can
/// help (`LiveChatFileUnreadable`).
///
/// Enforces the same [`MAX_LIVE_CHAT_DECOMPRESSED_BYTES`] ceiling as before, counted across the
/// decompressed stream via a `.take` on the reader, so a crafted tiny gzip (a decompression bomb)
/// still cannot expand without limit even though nothing buffers it whole - including a single
/// line that never ends. Blank lines are preserved as-is; the caller does the parsing and skips
/// them, exactly as the whole-file path did.
pub fn stream_live_chat_lines<F>(path: &Path, batch_lines: usize, emit: F) -> AppResult<()>
where
    F: FnMut(Vec<String>) -> AppResult<()>,
{
    let mut file = fs::File::open(path).map_err(|error| {
        let code = if error.kind() == std::io::ErrorKind::NotFound {
            AppErrorCode::LiveChatFileNotFound
        } else {
            AppErrorCode::LiveChatFileUnreadable
        };

        AppError::from_code_with_details(code, "failed to read live chat file", error.to_string())
    })?;

    // Peek the gzip magic to decide whether to wrap the file in a streaming gunzip, then rewind to
    // the start so the chosen reader sees the whole file.
    let mut magic = [0u8; 2];
    let is_compressed = match file.read_exact(&mut magic) {
        Ok(()) => is_gzip(&magic),
        // A file shorter than two bytes cannot be gzip; stream it verbatim.
        Err(_) => false,
    };

    file.rewind().map_err(|error| {
        AppError::from_code_with_details(
            AppErrorCode::LiveChatFileUnreadable,
            "failed to rewind live chat file",
            error.to_string(),
        )
    })?;

    let decoded: Box<dyn Read> = if is_compressed {
        Box::new(GzDecoder::new(file))
    } else {
        Box::new(file)
    };

    stream_reader_lines(decoded, batch_lines, MAX_LIVE_CHAT_DECOMPRESSED_BYTES, emit)
}

/// Reads `reader` line by line, decoding each line lossily, and hands `emit` batches of at most
/// `batch_lines` lines. Aborts with `LiveChatFileUnreadable` once the decompressed byte count
/// exceeds `max_total_bytes`. Split out from [`stream_live_chat_lines`] so the ceiling can be
/// tested against a small in-memory reader without materializing a real multi-hundred-MB stream.
fn stream_reader_lines<R, F>(
    reader: R,
    batch_lines: usize,
    max_total_bytes: u64,
    mut emit: F,
) -> AppResult<()>
where
    R: Read,
    F: FnMut(Vec<String>) -> AppResult<()>,
{
    let batch_lines = batch_lines.max(1);

    // Bound the byte count with `.take` so a decompression bomb (or a single huge line with no
    // newline) can never buffer past the ceiling. `+ 1` so a stream landing exactly on the limit
    // still reads, while anything larger is caught below - mirroring gzip_decompress_with_limit.
    let mut reader = BufReader::new(reader.take(max_total_bytes + 1));

    let mut batch: Vec<String> = Vec::with_capacity(batch_lines);
    let mut raw: Vec<u8> = Vec::new();
    let mut total_bytes: u64 = 0;

    loop {
        raw.clear();

        let read = reader.read_until(b'\n', &mut raw).map_err(|error| {
            AppError::from_code_with_details(
                AppErrorCode::LiveChatFileUnreadable,
                "failed to read live chat file",
                error.to_string(),
            )
        })?;

        if read == 0 {
            break;
        }

        total_bytes += read as u64;

        if total_bytes > max_total_bytes {
            return Err(AppError::from_code(
                AppErrorCode::LiveChatFileUnreadable,
                "the live chat file is too large when decompressed",
            ));
        }

        // Strip the trailing newline (and a preceding carriage return), matching the line split
        // the frontend used on the whole-file text.
        while matches!(raw.last(), Some(b'\n') | Some(b'\r')) {
            raw.pop();
        }

        // Per-line lossy UTF-8 decoding. The whole-file path used a strict `String::from_utf8`
        // that failed the entire read on one stray byte; decoding each line lossily is a superset
        // that keeps a single garbled line from discarding an otherwise-good replay (the parser
        // then drops just that line and counts it), consistent with `read_lossy_line` elsewhere.
        batch.push(String::from_utf8_lossy(&raw).into_owned());

        if batch.len() >= batch_lines {
            emit(std::mem::take(&mut batch))?;
            batch = Vec::with_capacity(batch_lines);
        }
    }

    if !batch.is_empty() {
        emit(batch)?;
    }

    Ok(())
}

/// One-time migration that moves live chat files from the old app-data location into the
/// library, so all of a video's bulk artifacts (media, thumbnail, live chat) live together
/// and travel with the library folder. Idempotent: a no-op once the source folder is empty
/// or gone. Handles the app-data-on-SSD to library-on-HDD case by falling back to copy+delete
/// when a cross-volume rename fails. Returns how many files were moved.
pub fn migrate_live_chat_files(app_data_dir: &Path, library_dir: &Path) -> AppResult<usize> {
    let source_dir = app_data_dir.join("live_chat");

    if !source_dir.exists() {
        return Ok(0);
    }

    let dest_dir = library_dir.join("live_chat");
    let mut moved = 0;

    let entries =
        fs::read_dir(&source_dir).map_err(|e| compress_error("failed to read live chat dir", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| compress_error("failed to read live chat entry", e))?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        let Some(name) = path.file_name() else {
            continue;
        };

        fs::create_dir_all(&dest_dir)
            .map_err(|e| compress_error("failed to create library live chat dir", e))?;
        let dest = dest_dir.join(name);

        // A file already at the destination was migrated on a previous run; drop the stale
        // source copy rather than clobbering it. This check is only trustworthy because the
        // cross-volume fallback below writes atomically (temp + fsync + rename), so a crash
        // mid-copy can never leave a partial `dest` here that we would mistake for a complete
        // prior migration and then delete the intact source of.
        if dest.exists() {
            let _ = fs::remove_file(&path);
            continue;
        }

        // Prefer a rename (fast, same volume); fall back to an atomic copy across volumes,
        // which is the expected case when app data is on the SSD and the library is on the
        // HDD. `copy_file_atomic` writes to a temp file, fsyncs, then renames into place, so
        // this backup artifact is never left truncated if the process dies mid-copy.
        if fs::rename(&path, &dest).is_err() {
            crate::services::filesystem::copy_file_atomic(&path, &dest)?;
            let _ = fs::remove_file(&path);
        }

        moved += 1;
    }

    // Best effort: drop the now-empty source directory.
    let _ = fs::remove_dir(&source_dir);

    Ok(moved)
}

/// Lists stored live chat files as library-relative, forward-slash paths (e.g.
/// `live_chat/<file>`), matching how they are recorded in the database. Live chat files are
/// stored flat under `live_chat/`, so this does not recurse.
pub fn list_live_chat_relative_paths(library_dir: &Path) -> AppResult<Vec<String>> {
    let dir = library_dir.join("live_chat");

    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut paths = Vec::new();

    let entries =
        fs::read_dir(&dir).map_err(|e| compress_error("failed to read live chat dir", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| compress_error("failed to read live chat entry", e))?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
            paths.push(format!("live_chat/{name}"));
        }
    }

    Ok(paths)
}

/// Cheap check that reads only the first two bytes, so already-compressed files are skipped
/// on every startup without reading their full contents.
fn starts_with_gzip_magic(path: &Path) -> AppResult<bool> {
    let mut file =
        fs::File::open(path).map_err(|e| compress_error("failed to open live chat file", e))?;
    let mut magic = [0u8; 2];

    match file.read_exact(&mut magic) {
        Ok(()) => Ok(is_gzip(&magic)),
        // A file shorter than two bytes cannot be gzip.
        Err(_) => Ok(false),
    }
}

fn temp_sibling_path(path: &Path) -> AppResult<PathBuf> {
    let file_name = path.file_name().ok_or_else(|| {
        AppError::from_code(
            AppErrorCode::LiveChatCompressFailed,
            "live chat file has no name",
        )
    })?;

    Ok(path.with_file_name(format!("{}.gztmp", file_name.to_string_lossy())))
}

/// Gzip-compresses `data` and verifies the round trip (decompressing back to the original bytes)
/// before returning the compressed buffer. Both compression call sites remove or overwrite the only
/// on-disk copy of the source afterwards, so a bad compression that silently changed the bytes must
/// be caught here, before the original is gone.
fn compress_verified(data: &[u8]) -> AppResult<Vec<u8>> {
    let compressed = gzip_compress(data)?;
    let restored = gzip_decompress(&compressed)?;

    if restored != data {
        return Err(AppError::from_code(
            AppErrorCode::LiveChatCompressFailed,
            "gzip round trip verification failed",
        ));
    }

    Ok(compressed)
}

/// Compresses `src` and writes the gzip result to `dest` atomically. Used when moving a
/// freshly downloaded live chat file into app storage. Verifies the gzip round trip before removing
/// `src` on success, so a bad compression can never lose the only copy of a just-downloaded replay.
pub fn compress_file_to(src: &Path, dest: &Path) -> AppResult<()> {
    let data = fs::read(src).map_err(|e| compress_error("failed to read live chat source", e))?;
    // This is the one call site where `src` is the only copy of a just-downloaded replay (a finished
    // livestream may no longer be re-fetchable), so verify the round trip before it is removed below.
    let compressed = compress_verified(&data)?;

    let temp = temp_sibling_path(dest)?;
    fs::write(&temp, &compressed)
        .map_err(|e| compress_error("failed to write compressed live chat", e))?;
    // Flush the temp before the same-volume rename in replace_file_safely: without it a crash could
    // leave a truncated file that the rename then makes the live one. Mirrors copy_file_atomic's
    // fsync-before-rename; the source is only removed after this returns Ok, so a failure just leaves
    // the pre-existing file for a retry.
    fsync_file(&temp)?;
    replace_file_safely(&temp, dest)?;

    let _ = fs::remove_file(src);
    Ok(())
}

/// Compresses a live chat file in place, skipping files that are already gzip. Verifies the
/// gzip round trip before replacing the original, so a bad compression can never lose data.
/// Returns true when the file was compressed, false when it was already compressed.
pub fn compress_file_in_place(path: &Path) -> AppResult<bool> {
    if starts_with_gzip_magic(path)? {
        return Ok(false);
    }

    let data = fs::read(path).map_err(|e| compress_error("failed to read live chat file", e))?;
    let compressed = compress_verified(&data)?;

    let temp = temp_sibling_path(path)?;
    fs::write(&temp, &compressed)
        .map_err(|e| compress_error("failed to write compressed live chat", e))?;
    // Flush the temp before the same-volume rename in replace_file_safely, so a crash cannot leave a
    // truncated file that the rename promotes over the original. The round trip above already proved
    // the bytes decompress, so this only adds durability, not a new failure mode.
    fsync_file(&temp)?;
    replace_file_safely(&temp, path)?;

    Ok(true)
}

/// Compresses every uncompressed live chat file in `dir`. Best effort: a failure on one file
/// is logged and counted, never aborting the whole pass.
pub fn compress_existing_live_chat_files(dir: &Path) -> AppResult<LiveChatCompressionSummary> {
    let mut summary = LiveChatCompressionSummary::default();

    if !dir.exists() {
        return Ok(summary);
    }

    let entries = fs::read_dir(dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::ReadDirFailed,
            format!("failed to read live chat directory: {e}"),
        )
    })?;

    for entry in entries {
        let Ok(entry) = entry else {
            summary.failed += 1;
            continue;
        };

        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        // Skip our own leftover temp files.
        let is_temp = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("gztmp"))
            .unwrap_or(false);

        if is_temp {
            continue;
        }

        summary.scanned += 1;

        match compress_file_in_place(&path) {
            Ok(true) => summary.compressed += 1,
            Ok(false) => summary.already_compressed += 1,
            Err(error) => {
                summary.failed += 1;
                crate::services::logger::warn(
                    "live_chat_compress",
                    format!(
                        "failed to compress {}: {}",
                        crate::services::logger::redact_path(&path),
                        error
                    ),
                );
            }
        }
    }

    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("kavynex_lcs_{label}_{nanos}"))
    }

    #[test]
    fn gzip_round_trip_preserves_data() {
        let data = b"{\"replayChatItemAction\":{}}\n{\"replayChatItemAction\":{}}\n";
        let compressed = gzip_compress(data).unwrap();

        assert!(is_gzip(&compressed));
        assert_eq!(gzip_decompress(&compressed).unwrap(), data);
    }

    #[test]
    fn is_gzip_detects_magic_bytes() {
        assert!(is_gzip(&[0x1f, 0x8b, 0x08]));
        assert!(!is_gzip(b"{\"a\":1}"));
        assert!(!is_gzip(&[0x1f]));
    }

    #[test]
    fn gzip_decompress_rejects_output_larger_than_the_limit() {
        // Highly compressible payload: a few KB of zeros gzip to a tiny file but decompress
        // well past a small limit - a stand-in for a decompression bomb.
        let payload = vec![0u8; 8 * 1024];
        let compressed = gzip_compress(&payload).unwrap();
        assert!(compressed.len() < payload.len());

        let error = gzip_decompress_with_limit(&compressed, 1024).unwrap_err();
        assert_eq!(error.code, AppErrorCode::LiveChatCompressFailed.as_str());

        // A limit above the real size still decodes the whole payload.
        let ok = gzip_decompress_with_limit(&compressed, 64 * 1024).unwrap();
        assert_eq!(ok, payload);
    }

    /// Collects every streamed line into one vector, plus the number of batches `emit` was called
    /// with, so a test can assert both the content and that batching actually happened.
    fn collect_streamed_lines(path: &Path, batch_lines: usize) -> AppResult<(Vec<String>, usize)> {
        let mut lines = Vec::new();
        let mut batches = 0;

        stream_live_chat_lines(path, batch_lines, |batch| {
            batches += 1;
            lines.extend(batch);
            Ok(())
        })?;

        Ok((lines, batches))
    }

    #[test]
    fn stream_live_chat_lines_streams_gzip_and_plain() {
        let dir = temp_dir("stream");
        fs::create_dir_all(&dir).unwrap();

        // Plain (legacy uncompressed) replay: streamed verbatim, one entry per line, blank lines
        // preserved (the frontend skips them, exactly as it did on the whole-file text).
        let plain = dir.join("plain.json");
        fs::write(&plain, b"{\"a\":1}\n{\"b\":2}\n").unwrap();
        let (lines, _) = collect_streamed_lines(&plain, 500).unwrap();
        assert_eq!(
            lines,
            vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]
        );

        // Gzip replay: transparently gunzipped while streaming, same result.
        let gz = dir.join("compressed.json");
        fs::write(&gz, gzip_compress(b"{\"a\":1}\n{\"b\":2}\n").unwrap()).unwrap();
        let (lines, _) = collect_streamed_lines(&gz, 500).unwrap();
        assert_eq!(
            lines,
            vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stream_live_chat_lines_delivers_multiple_batches_when_over_the_batch_size() {
        let dir = temp_dir("stream-batches");
        fs::create_dir_all(&dir).unwrap();

        // Five lines with a batch size of two must arrive as three batches (2 + 2 + 1) rather than
        // one whole-file read - the point of streaming.
        let file = dir.join("many.json");
        fs::write(&file, b"a\nb\nc\nd\ne\n").unwrap();

        let (lines, batches) = collect_streamed_lines(&file, 2).unwrap();
        assert_eq!(lines, vec!["a", "b", "c", "d", "e"]);
        assert_eq!(batches, 3);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stream_live_chat_lines_tells_a_missing_file_apart_from_a_corrupt_one() {
        // These share nothing but the fact that they fail: a file the user moved out of the library
        // can be put back (LiveChatFileNotFound), while a corrupt archive cannot and only a backup
        // helps (LiveChatFileUnreadable). Keeping the two codes apart is what lets the frontend say
        // either instead of the generic "check the logs" fallback.
        let dir = temp_dir("stream-failures");
        fs::create_dir_all(&dir).unwrap();

        let missing = dir.join("gone.json.gz");
        let error = collect_streamed_lines(&missing, 500).unwrap_err();
        assert_eq!(error.code, AppErrorCode::LiveChatFileNotFound.as_str());

        // Gzip magic bytes with a shredded body: present, readable, and not decompressible.
        let corrupt = dir.join("corrupt.json.gz");
        let mut bytes = gzip_compress(b"{\"a\":1}").unwrap();
        let tail = bytes.len() - 4;
        bytes[4..tail].fill(0xFF);
        fs::write(&corrupt, &bytes).unwrap();

        let error = collect_streamed_lines(&corrupt, 500).unwrap_err();
        assert_eq!(error.code, AppErrorCode::LiveChatFileUnreadable.as_str());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stream_reader_lines_decodes_a_garbled_line_lossily_and_keeps_the_rest() {
        // A single non-UTF-8 line between two valid ones must not discard the whole replay: it is
        // decoded lossily (U+FFFD) and streamed like any other, and the frontend parser then drops
        // just that line. This is the deliberate behavior change from the whole-file strict
        // `String::from_utf8`, matching the philosophy of `utils::io::read_lossy_line`.
        let mut data: Vec<u8> = b"before\n".to_vec();
        data.extend_from_slice(&[0xff, 0xfe]);
        data.extend_from_slice(b"\nafter\n");

        let mut lines = Vec::new();
        stream_reader_lines(&data[..], 500, MAX_LIVE_CHAT_DECOMPRESSED_BYTES, |batch| {
            lines.extend(batch);
            Ok(())
        })
        .unwrap();

        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "before");
        assert!(lines[1].contains('\u{fffd}'));
        assert_eq!(lines[2], "after");
    }

    #[test]
    fn stream_reader_lines_rejects_a_stream_larger_than_the_ceiling() {
        // The decompression-bomb guard: a stream whose decoded size exceeds the ceiling is aborted
        // rather than buffered. Tested against a small in-memory reader with a small cap so no
        // multi-hundred-MB payload is needed. A line with no terminator also exercises the `.take`
        // bound (read_until cannot run away buffering the whole line).
        let data = vec![b'x'; 4096];

        let error = stream_reader_lines(&data[..], 500, 1024, |_| Ok(())).unwrap_err();
        assert_eq!(error.code, AppErrorCode::LiveChatFileUnreadable.as_str());

        // A stream at or under the cap streams cleanly.
        let small = b"a\nb\n".to_vec();
        let mut lines = Vec::new();
        stream_reader_lines(&small[..], 500, 1024, |batch| {
            lines.extend(batch);
            Ok(())
        })
        .unwrap();
        assert_eq!(lines, vec!["a", "b"]);
    }

    #[test]
    fn migrate_live_chat_files_moves_and_is_idempotent() {
        let app_data = temp_dir("mig-appdata");
        let library = temp_dir("mig-library");

        let source = app_data.join("live_chat");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("a.live_chat.json"), b"hello").unwrap();

        assert_eq!(migrate_live_chat_files(&app_data, &library).unwrap(), 1);
        assert!(library.join("live_chat").join("a.live_chat.json").exists());
        assert!(!source.join("a.live_chat.json").exists());

        // The source folder is gone after the move, so a second run is a no-op.
        assert_eq!(migrate_live_chat_files(&app_data, &library).unwrap(), 0);

        let _ = fs::remove_dir_all(&app_data);
        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn migrate_live_chat_files_never_clobbers_an_existing_destination() {
        // A destination file already present (migrated on a previous run) must be kept
        // intact, and the stale source dropped - never overwritten. The atomic copy in the
        // cross-volume path guarantees such a destination is always a complete file, so this
        // "already migrated" shortcut can be trusted.
        let app_data = temp_dir("mig-existing-appdata");
        let library = temp_dir("mig-existing-library");

        let source = app_data.join("live_chat");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("a.live_chat.json"), b"stale-source").unwrap();

        let dest_dir = library.join("live_chat");
        fs::create_dir_all(&dest_dir).unwrap();
        fs::write(dest_dir.join("a.live_chat.json"), b"already-migrated").unwrap();

        assert_eq!(migrate_live_chat_files(&app_data, &library).unwrap(), 0);

        // The intact destination is preserved and the stale source is removed.
        assert_eq!(
            fs::read(dest_dir.join("a.live_chat.json")).unwrap(),
            b"already-migrated"
        );
        assert!(!source.join("a.live_chat.json").exists());

        let _ = fs::remove_dir_all(&app_data);
        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn compress_file_in_place_compresses_then_skips() {
        let dir = temp_dir("in-place");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("youtube_x.live_chat.json");
        let original = b"{\"replayChatItemAction\":{\"actions\":[]}}\n";
        fs::write(&file, original).unwrap();

        assert!(compress_file_in_place(&file).unwrap());
        let bytes = fs::read(&file).unwrap();
        assert!(is_gzip(&bytes));
        assert_eq!(gzip_decompress(&bytes).unwrap(), original);

        // Second pass is a no-op because the file is already gzip.
        assert!(!compress_file_in_place(&file).unwrap());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn compress_file_to_writes_gzip_and_removes_source() {
        let dir = temp_dir("to");
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.live_chat.json");
        let dest = dir.join("dest.live_chat.json");
        let original = b"{\"replayChatItemAction\":{}}\n";
        fs::write(&src, original).unwrap();

        compress_file_to(&src, &dest).unwrap();

        assert!(!src.exists());
        let bytes = fs::read(&dest).unwrap();
        assert!(is_gzip(&bytes));
        assert_eq!(gzip_decompress(&bytes).unwrap(), original);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn compress_existing_scans_and_is_idempotent() {
        let dir = temp_dir("scan");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.live_chat.json"), b"hello\n").unwrap();
        fs::write(dir.join("b.live_chat.json"), b"world\n").unwrap();

        let summary = compress_existing_live_chat_files(&dir).unwrap();
        assert_eq!(summary.scanned, 2);
        assert_eq!(summary.compressed, 2);
        assert_eq!(summary.already_compressed, 0);

        let second = compress_existing_live_chat_files(&dir).unwrap();
        assert_eq!(second.scanned, 2);
        assert_eq!(second.compressed, 0);
        assert_eq!(second.already_compressed, 2);

        let _ = fs::remove_dir_all(&dir);
    }
}
