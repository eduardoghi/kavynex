use std::fs;
use std::io::{BufRead, BufReader, Read, Seek};
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;

use crate::services::filesystem::replace_file_safely;
use crate::utils::bounded_semaphore::{BoundedSemaphore, BoundedSemaphorePermit};
use crate::utils::hash::hash_while_copying;
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

/// Compresses `src` into `temp`, returning the SHA-256 of the source bytes so the caller can prove
/// the result against them. Refuses a source larger than `max_bytes` before reading any of it.
///
/// The refusal is by the source's own size and it comes first, which is the ordering the old path
/// had backwards. The read side caps a replay at the same ceiling
/// ([`stream_live_chat_lines`]), so compressing past it produces a file this app can write and then
/// never open again - and the previous implementation discovered that only after reading the whole
/// file into memory, i.e. after paying the exact cost the ceiling exists to bound.
///
/// `max_bytes` is a parameter rather than the constant so the boundary is testable against a
/// kilobyte instead of half a gigabyte, matching how `stream_reader_lines` takes its own ceiling.
fn compress_file_to_temp(src: &Path, temp: &Path, max_bytes: u64) -> AppResult<String> {
    let size = fs::metadata(src)
        .map_err(|e| compress_error("failed to stat live chat source", e))?
        .len();

    if size > max_bytes {
        return Err(compress_error(
            "live chat file is too large to store",
            format!("{size} bytes exceeds the {max_bytes}-byte limit"),
        ));
    }

    let mut source =
        fs::File::open(src).map_err(|e| compress_error("failed to open live chat source", e))?;
    let target = fs::File::create(temp)
        .map_err(|e| compress_error("failed to create compressed live chat", e))?;
    let mut encoder = GzEncoder::new(target, Compression::default());

    let digest = hash_while_copying(&mut source, &mut encoder)?;

    // `finish` writes the gzip trailer and hands the file back; without it the archive is truncated
    // and only the verification would notice.
    let file = encoder
        .finish()
        .map_err(|e| compress_error("failed to finish gzip stream", e))?;

    // Flushed through the handle already open rather than by reopening the path, which is what
    // `fsync_file` would do. Same durability guarantee, one fewer open, and no window in which the
    // path could name a different file than the one just written. It has to happen before the
    // caller's rename: without it a crash could leave a truncated file that the rename then
    // promotes to the live one.
    file.sync_all()
        .map_err(|e| compress_error("failed to flush compressed live chat", e))?;

    Ok(digest)
}

/// Proves that `compressed` decompresses to exactly the bytes `expected_digest` was taken over,
/// reading at most `max_bytes` of output.
///
/// This is the round-trip check the buffer path performed, and it now covers strictly more. That
/// version compared an in-memory buffer against the bytes it had just compressed and *then* wrote
/// the result to disk, so a write that truncated or corrupted the file fell outside what the check
/// proved. Reading the staged file back covers the write too, which is the failure the whole dance
/// exists for: `compress_file_to`'s source is a just-downloaded replay of a finished livestream,
/// and it may no longer be re-fetchable.
///
/// The ceiling is a plain `take(max_bytes)`, and it deliberately does **not** carry the `+ 1` that
/// `stream_reader_lines` and the old `gzip_decompress_with_limit` both do. That extra byte exists so
/// a counter can tell "landed exactly on the limit" apart from "went past it" and raise a specific
/// error; here the digest comparison already draws that line for free. A payload of exactly
/// `max_bytes` reads whole and matches, and anything larger is truncated and therefore cannot -
/// whereas with the `+ 1` a payload one byte over the ceiling would read whole and verify, which is
/// the opposite of what the ceiling is for. Copying the idiom without its counter was the first
/// version of this function, and `verification_accepts_a_payload_landing_exactly_on_the_read_ceiling`
/// is what caught it.
///
/// An oversized source is already refused up front by `compress_file_to_temp`, so reaching this
/// ceiling means the source changed underneath the pass - a round-trip failure in the honest sense.
fn verify_compressed_matches(
    compressed: &Path,
    expected_digest: &str,
    max_bytes: u64,
) -> AppResult<()> {
    let file = fs::File::open(compressed)
        .map_err(|e| compress_error("failed to reopen compressed live chat", e))?;

    let mut decoder = GzDecoder::new(file).take(max_bytes);
    let actual = hash_while_copying(&mut decoder, &mut std::io::sink())?;

    if actual != expected_digest {
        return Err(AppError::from_code(
            AppErrorCode::LiveChatCompressFailed,
            "gzip round trip verification failed",
        ));
    }

    Ok(())
}

/// How many replay lines are grouped into one streamed batch. Large enough that per-message IPC
/// overhead is negligible, small enough that only a bounded slice of the file is ever in memory.
pub const LIVE_CHAT_STREAM_BATCH_LINES: usize = 500;

/// Bounds how many replay reads run at once.
///
/// This is the fourth spawn-or-blocking choke point to get a gate, and it was the one that did not
/// have one. [`stream_live_chat_lines`] holds a blocking-pool thread for a whole gunzip pass over a
/// file that runs to hundreds of megabytes for a long stream, and that pool is shared with the media
/// import, the content hashing and the library cleanup - so an unbounded number of concurrent reads
/// starves work that has nothing to do with live chat. The bound is stated here rather than left to
/// the caller for the same reason `MAX_MEDIA_PAGE_LIMIT`, `MAX_MEDIA_COMMENTS_LOADED` and
/// `MAX_RUN_ID_LEN` are: the backend is the trust boundary, so it declares its own limit instead of
/// inheriting whatever the renderer sends.
///
/// Two is enough for every legitimate use. The player shows one media at a time, so the only way a
/// second read overlaps a first is a user switching media before the first finishes - and a third
/// concurrent read means either a third switch inside that window or a caller that is not the
/// player.
const MAX_CONCURRENT_LIVE_CHAT_READS: usize = 2;

/// Ceiling on how many replay reads may be in flight (running or waiting) at once.
///
/// The concurrency cap above bounds only how many run together; without this, a caller firing the
/// command in a loop queues an unbounded backlog ahead of the read the user is actually waiting on
/// (see [`BoundedSemaphore`]). Set well above the handful a person can produce by clicking through a
/// channel, so it only ever trips on abuse.
const MAX_LIVE_CHAT_READS_IN_FLIGHT: usize = 16;

// Both bounds above are numbers about legitimate use, so what is worth holding is the relationship
// between them rather than either value. `BoundedSemaphore::new` documents that the ceiling must not
// sit below the concurrency - a caller would otherwise be refused while a permit sat free - and
// cannot enforce it, being a `const fn`. Asserted here in a `const` block so a future edit that
// inverts them fails the build rather than a test, which is the earliest either could be caught.
const _: () = {
    assert!(MAX_LIVE_CHAT_READS_IN_FLIGHT >= MAX_CONCURRENT_LIVE_CHAT_READS);
    // The player shows one media at a time, so anything below two would refuse the ordinary case of
    // switching media before the first read finishes.
    assert!(MAX_CONCURRENT_LIVE_CHAT_READS >= 2);
};

/// A single process-wide gate, deliberately separate from `DOWNLOAD_SEMAPHORE`,
/// `STANDALONE_RUN_SEMAPHORE` and `THUMBNAIL_RUN_SEMAPHORE` rather than shared with them.
///
/// The download gate's own comment gives the reason in the other direction: gating two kinds of work
/// on one semaphore couples them, and a read that waited on a permit a download holds would be
/// serialized behind an operation it has nothing to do with. Reading a saved replay is local I/O
/// with no child process, so it is a different resource and gets a different bound.
static LIVE_CHAT_READ_SEMAPHORE: BoundedSemaphore = BoundedSemaphore::new(
    MAX_CONCURRENT_LIVE_CHAT_READS,
    MAX_LIVE_CHAT_READS_IN_FLIGHT,
);

/// The code a refused read carries.
///
/// Named rather than written inline at the one call site below, because it is the only part of this
/// gate a test can reach. Forcing a real refusal would mean filling the in-flight ceiling on a
/// process-wide static whose permit count is far below it, which parks every caller past the second
/// one on a permit nothing will release - see the test module for why that is a deadlock rather than
/// a slow test. So the value is pinned directly instead.
///
/// It is worth pinning: a wrong code here is not a wrong log line. `src/constants/error-codes.ts`
/// catalogues this one, and a code with no catalogued message degrades in the renderer to the
/// generic "check the app log file" - which is precisely the wrong thing to tell someone whose only
/// problem is that another replay is still loading.
const READ_GATE_BUSY_CODE: AppErrorCode = AppErrorCode::TooManyConcurrentLiveChatReads;

/// Reserves a slot to stream one replay. The returned permit must be held for the whole read, so a
/// caller binds it for the duration of its `run_blocking` rather than dropping it at the call.
///
/// Lives beside the reader it bounds rather than in the command, so the gate travels with the
/// operation: a second caller of [`stream_live_chat_lines`] added later reaches the bound by calling
/// this, instead of having to notice that the command layer was where the bound happened to live.
pub async fn acquire_read_permit() -> AppResult<BoundedSemaphorePermit> {
    LIVE_CHAT_READ_SEMAPHORE.acquire(READ_GATE_BUSY_CODE).await
}

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

/// Compresses `src` into `temp` and proves the result decompresses back to the source's exact
/// bytes, leaving `temp` durable and ready for the caller to rename into place.
///
/// Nothing is promoted here and the source is never touched, so every failure path leaves the
/// original exactly as it was. A failure does leave the staged `<name>.gztmp` behind, which is
/// deliberate rather than overlooked: the next attempt truncates it (`File::create`), and removing
/// it here would add a cleanup no test can observe - the only way to fail *after* the file exists is
/// a verification failure, which cannot be produced without corrupting the staged file mid-call.
fn compress_to_temp_verified(src: &Path, temp: &Path) -> AppResult<()> {
    let digest = compress_file_to_temp(src, temp, MAX_LIVE_CHAT_DECOMPRESSED_BYTES)?;
    verify_compressed_matches(temp, &digest, MAX_LIVE_CHAT_DECOMPRESSED_BYTES)
}

/// Compresses `src` and writes the gzip result to `dest` atomically. Used when moving a
/// freshly downloaded live chat file into app storage. Verifies the gzip round trip before removing
/// `src` on success, so a bad compression can never lose the only copy of a just-downloaded replay.
pub fn compress_file_to(src: &Path, dest: &Path) -> AppResult<()> {
    let temp = temp_sibling_path(dest)?;

    // This is the one call site where `src` is the only copy of a just-downloaded replay (a finished
    // livestream may no longer be re-fetchable), so the round trip is proved - against the staged
    // file, not against a buffer - before the source is removed below.
    compress_to_temp_verified(src, &temp)?;
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

    let temp = temp_sibling_path(path)?;

    compress_to_temp_verified(path, &temp)?;
    replace_file_safely(&temp, path)?;

    Ok(true)
}

/// Counts a directory entry the OS refused to yield at all, and says so.
///
/// Its own function for a reason that is about the mutation gate rather than about readability, and
/// worth stating because the extraction otherwise looks gratuitous. cargo-mutants names a mutant by
/// the function it lives in, so the five `+= 1` sites in `compress_existing_live_chat_files` all
/// shared one description - four of them killable, this one not, since a `read_dir` entry that fails
/// to yield cannot be produced portably. That made the file ungateable: excluding the description
/// would have silently dropped four working checks along with the one that needed it.
///
/// The extraction was made to allow that exclusion, and then made it unnecessary, which is the part
/// worth recording. A counter reachable only through a `read_dir` failure is unreachable; the same
/// counter behind a named function is one call from a test, and
/// `an_unreadable_directory_entry_is_counted_as_a_failure` kills both of its mutants directly. The
/// lesson generalizes past this file: "no portable way to trigger the branch" is a statement about
/// the *caller*, not about the decision, and moving the decision out is what turns an exclusion into
/// a test.
///
/// It also gained a log line it did not have. An entry that cannot even be read is the one case in
/// this pass that left no trace anywhere - the count went up and nothing said why.
fn record_unreadable_entry(summary: &mut LiveChatCompressionSummary) {
    summary.failed += 1;

    crate::services::logger::warn(
        "live_chat_compress",
        "a live chat directory entry could not be read and was skipped",
    );
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
            record_unreadable_entry(&mut summary);
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
    use std::io::Write;

    fn temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex_lcs_{label}_{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    /// Buffer-based gzip, a test fixture rather than production code.
    ///
    /// These two used to be both. `compress_verified` gzipped a whole file in memory and
    /// decompressed the result to check it, which is what made this module hold the source, the
    /// archive and the restored copy alive at once - three copies of something that runs to
    /// hundreds of megabytes for a long stream. The production path streams now, and what is left
    /// here is a different job: building a gzip fixture and reading one back, both on payloads
    /// measured in kilobytes.
    fn gzip_compress(data: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    fn gzip_decompress(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        GzDecoder::new(data).read_to_end(&mut out).unwrap();
        out
    }

    /// The SHA-256 of `data`, computed by the module the content-addressed filenames already use.
    ///
    /// Deliberately not `hash_while_copying` itself: a test that checked that function against
    /// itself would pass for any hash at all. `utils::hash::file_hash` is an independent
    /// implementation with its own tests, so agreeing with it is a real assertion.
    fn independent_digest(data: &[u8]) -> String {
        let dir = temp_dir("digest");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("payload.bin");
        fs::write(&file, data).unwrap();

        let digest = crate::utils::hash::file_hash(&file).unwrap();

        let _ = fs::remove_dir_all(&dir);
        digest
    }

    #[test]
    fn gzip_round_trip_preserves_data() {
        let data = b"{\"replayChatItemAction\":{}}\n{\"replayChatItemAction\":{}}\n";
        let compressed = gzip_compress(data);

        assert!(is_gzip(&compressed));
        assert_eq!(gzip_decompress(&compressed), data);
    }

    #[test]
    fn is_gzip_detects_magic_bytes() {
        assert!(is_gzip(&[0x1f, 0x8b, 0x08]));
        assert!(!is_gzip(b"{\"a\":1}"));
        assert!(!is_gzip(&[0x1f]));
    }

    #[test]
    fn compressing_refuses_a_source_larger_than_the_ceiling_before_reading_it() {
        // The ceiling this replaces was applied to the *decompressed output*, i.e. after the whole
        // file had been read into memory - which is the cost the ceiling exists to avoid paying.
        // It is checked against the source's own size now, so nothing is read at all.
        let dir = temp_dir("too-large");
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("huge.live_chat.json");
        let temp = dir.join("huge.live_chat.json.gztmp");
        fs::write(&src, vec![0u8; 4096]).unwrap();

        let error = compress_file_to_temp(&src, &temp, 1024)
            .expect_err("a source past the ceiling must be refused");
        assert_eq!(error.code, AppErrorCode::LiveChatCompressFailed.as_str());
        assert!(
            !temp.exists(),
            "nothing should have been staged for a source that was refused"
        );
        assert_eq!(
            fs::read(&src).unwrap().len(),
            4096,
            "the source is untouched"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn compressing_accepts_a_source_landing_exactly_on_the_ceiling() {
        // The comparison is `> max_bytes`, so a source of exactly the allowed size must pass.
        // Both sides are asserted one byte apart, because relaxing it to `>=` would otherwise
        // change nothing any test could see - the same boundary the previous ceiling test pinned,
        // moved to where the ceiling now lives.
        let dir = temp_dir("exact-ceiling");
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("exact.live_chat.json");
        let payload = vec![0u8; 4096];
        fs::write(&src, &payload).unwrap();
        let exact = payload.len() as u64;

        let at_limit = dir.join("at-limit.gztmp");
        compress_file_to_temp(&src, &at_limit, exact)
            .expect("a source exactly at the ceiling must be accepted");
        assert_eq!(gzip_decompress(&fs::read(&at_limit).unwrap()), payload);

        let over_limit = dir.join("over-limit.gztmp");
        let error = compress_file_to_temp(&src, &over_limit, exact - 1)
            .expect_err("one byte over the ceiling must be refused");
        assert_eq!(error.code, AppErrorCode::LiveChatCompressFailed.as_str());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn compressing_stages_a_gzip_whose_digest_describes_the_source() {
        let dir = temp_dir("stage");
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("clip.live_chat.json");
        let temp = dir.join("clip.live_chat.json.gztmp");
        let payload = b"{\"replayChatItemAction\":{}}\n".repeat(400);
        fs::write(&src, &payload).unwrap();

        let digest = compress_file_to_temp(&src, &temp, MAX_LIVE_CHAT_DECOMPRESSED_BYTES).unwrap();

        assert_eq!(digest, independent_digest(&payload));

        let staged = fs::read(&temp).unwrap();
        assert!(is_gzip(&staged), "the staged file must be a gzip archive");
        assert_eq!(gzip_decompress(&staged), payload);
        // The whole point of streaming: the archive is smaller than the source it never held whole.
        assert!(staged.len() < payload.len());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn verification_accepts_the_matching_digest_and_rejects_any_other() {
        let dir = temp_dir("verify");
        fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("clip.gz");
        let payload = b"{\"replayChatItemAction\":{}}\n".repeat(50);
        fs::write(&archive, gzip_compress(&payload)).unwrap();

        let digest = independent_digest(&payload);
        verify_compressed_matches(&archive, &digest, MAX_LIVE_CHAT_DECOMPRESSED_BYTES)
            .expect("an archive that decompresses to the expected bytes must verify");

        // The digest of *different* content, so the comparison has to be doing the work: inverting
        // it to `==` fails here, and dropping it fails the positive case above.
        let other = independent_digest(b"not the same replay");
        let error = verify_compressed_matches(&archive, &other, MAX_LIVE_CHAT_DECOMPRESSED_BYTES)
            .expect_err("a mismatching digest must fail verification");
        assert_eq!(error.code, AppErrorCode::LiveChatCompressFailed.as_str());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn verification_refuses_an_archive_that_expands_past_the_read_ceiling() {
        // The decompression-bomb half of the old ceiling test, at the layer that now enforces it.
        // A few KB of zeros gzip to almost nothing and expand well past a small limit; the `.take`
        // truncates the read, so the digest cannot match and the archive is refused rather than
        // being expanded without bound.
        let dir = temp_dir("bomb");
        fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("bomb.gz");
        let payload = vec![0u8; 8 * 1024];
        let compressed = gzip_compress(&payload);
        assert!(compressed.len() < payload.len());
        fs::write(&archive, &compressed).unwrap();

        let digest = independent_digest(&payload);

        let error = verify_compressed_matches(&archive, &digest, 1024)
            .expect_err("an archive expanding past the ceiling must be refused");
        assert_eq!(error.code, AppErrorCode::LiveChatCompressFailed.as_str());

        // A ceiling above the real size verifies the same archive, so the refusal above is the
        // ceiling talking and not a broken fixture.
        verify_compressed_matches(&archive, &digest, 64 * 1024).unwrap();

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn verification_accepts_a_payload_landing_exactly_on_the_read_ceiling() {
        // Both sides of the take, one byte apart. This is the test that caught the first version of
        // `verify_compressed_matches`, which copied the `+ 1` from `stream_reader_lines` without the
        // counter that makes it mean something: with it, a payload one byte *over* the ceiling read
        // whole and verified, so the ceiling refused nothing at its own boundary.
        let dir = temp_dir("exact-read");
        fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("exact.gz");
        let payload = vec![0u8; 8 * 1024];
        fs::write(&archive, gzip_compress(&payload)).unwrap();

        let digest = independent_digest(&payload);
        let exact = payload.len() as u64;

        verify_compressed_matches(&archive, &digest, exact)
            .expect("a payload exactly at the ceiling must verify");

        let error = verify_compressed_matches(&archive, &digest, exact - 1)
            .expect_err("one byte over the ceiling must be refused");
        assert_eq!(error.code, AppErrorCode::LiveChatCompressFailed.as_str());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_live_chat_decompression_ceiling_is_512_mib() {
        // Pinned by value, not by re-deriving it from the same multiplication the constant uses:
        // the ceiling is a decompression-bomb guard, and an arithmetic slip in it (512 + 1024 +
        // 1024 is 2560 bytes, not 512 MiB) would either break every real replay or, the other way,
        // remove the bound - neither of which any behavioral test can afford to exercise at that
        // size. A literal is the only thing that catches it.
        assert_eq!(MAX_LIVE_CHAT_DECOMPRESSED_BYTES, 536_870_912);
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
        fs::write(&gz, gzip_compress(b"{\"a\":1}\n{\"b\":2}\n")).unwrap();
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
        let mut bytes = gzip_compress(b"{\"a\":1}");
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
    fn stream_reader_lines_accepts_a_stream_landing_exactly_on_the_ceiling() {
        // Same boundary as the gzip ceiling above, and it was untested for the same reason: the
        // existing case sits far over the cap, so tightening `>` to `>=` - which would refuse a
        // stream of exactly the allowed size - was invisible. `a\nb\n` is four bytes, so a cap of
        // four is the exact boundary and a cap of three is one byte under it.
        let data = b"a\nb\n".to_vec();

        let mut lines = Vec::new();
        stream_reader_lines(&data[..], 500, 4, |batch| {
            lines.extend(batch);
            Ok(())
        })
        .expect("a stream exactly at the ceiling must be accepted");
        assert_eq!(lines, vec!["a", "b"]);

        let error = stream_reader_lines(&data[..], 500, 3, |_| Ok(()))
            .expect_err("a stream over the ceiling must be refused");
        assert_eq!(error.code, AppErrorCode::LiveChatFileUnreadable.as_str());
    }

    #[test]
    fn list_live_chat_relative_paths_returns_files_and_skips_directories() {
        // Two guards in one walk, and both were unpinned: the early return when `live_chat/` does
        // not exist, and the per-entry skip of anything that is not a file. Dropping the `!` from
        // either inverts it - the first makes an existing directory report nothing, the second
        // makes it report its subdirectories and hide its files - and a library that silently
        // reports no live chat files is how diagnostics would start deleting them as unreferenced.
        let library = temp_dir("list-relative");
        let live_chat = library.join("live_chat");
        fs::create_dir_all(live_chat.join("a-subdirectory")).unwrap();
        fs::write(live_chat.join("clip.live_chat.json.gz"), b"data").unwrap();

        let paths = list_live_chat_relative_paths(&library).unwrap();

        assert_eq!(paths, vec!["live_chat/clip.live_chat.json.gz".to_string()]);

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn list_live_chat_relative_paths_reports_nothing_when_the_directory_is_absent() {
        // The other side of the early return, so it is the *condition* that is pinned rather than
        // just the populated path: a library with no live_chat/ yet is an empty list, not an error.
        let library = temp_dir("list-relative-missing");
        fs::create_dir_all(&library).unwrap();

        assert!(list_live_chat_relative_paths(&library).unwrap().is_empty());

        let _ = fs::remove_dir_all(&library);
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
        assert_eq!(gzip_decompress(&bytes), original);

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
        assert_eq!(gzip_decompress(&bytes), original);

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

    #[test]
    fn compress_existing_counts_a_file_it_could_not_compress_and_keeps_going() {
        // The `failed` counter on the compression branch, which had nothing behind it: making one
        // file fail was assumed to need a permission trick no test can do portably, so the count
        // went unasserted and a mutation of it would have been invisible.
        //
        // It does not need one. `compress_file_in_place` stages through a `<name>.gztmp` sibling, so
        // putting a *directory* at that path makes the staged write fail on both platforms, with no
        // permissions involved. The directory itself is skipped by the loop's `is_file` guard, so it
        // does not disturb the scan.
        let dir = temp_dir("compress-failure");
        fs::create_dir_all(&dir).unwrap();

        let doomed = dir.join("blocked.live_chat.json");
        fs::write(&doomed, b"never compressed\n").unwrap();
        fs::create_dir_all(dir.join("blocked.live_chat.json.gztmp")).unwrap();

        // A healthy sibling, because "best effort" is the other half of the claim: one file failing
        // must not abort the pass or skip the files after it.
        fs::write(dir.join("fine.live_chat.json"), b"compressed\n").unwrap();

        let summary = compress_existing_live_chat_files(&dir).unwrap();

        assert_eq!(summary.failed, 1);
        assert_eq!(summary.compressed, 1);
        assert_eq!(summary.scanned, 2);
        assert_eq!(summary.already_compressed, 0);

        // The source is left exactly as it was: the staged write is what failed, and nothing
        // replaces the original until that write and its round-trip check have both succeeded.
        assert_eq!(fs::read(&doomed).unwrap(), b"never compressed\n");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_directory_entry_is_counted_as_a_failure() {
        // The one counter in this pass that no portable test can reach through the real loop - a
        // `read_dir` entry the OS refuses to yield - so it is asserted directly instead. That is
        // also why it lives in its own function: alone in there, the mutation gate can exclude it
        // by name without dropping the four counters around it that tests do cover.
        let mut summary = LiveChatCompressionSummary::default();

        record_unreadable_entry(&mut summary);
        assert_eq!(summary.failed, 1);

        record_unreadable_entry(&mut summary);
        assert_eq!(
            summary.failed, 2,
            "each unreadable entry counts exactly once"
        );

        // Only `failed` moves: an entry that never yielded was not scanned, compressed or skipped.
        assert_eq!(summary.scanned, 0);
        assert_eq!(summary.compressed, 0);
        assert_eq!(summary.already_compressed, 0);
    }

    // The read gate. `BoundedSemaphore` has its own tests over the primitive; what is pinned here is
    // that *this* module reaches it - that a replay read is bounded at all, and with which code.
    //
    // The gate is a process-wide static, so these two tests share it and cannot assert an absolute
    // in-flight count the way the primitive's tests do (another test holding a permit would make
    // that flaky). They assert what does not depend on the rest of the suite instead: a permit is
    // obtainable, and it is released on drop.

    #[tokio::test]
    async fn a_replay_read_takes_a_permit_that_is_released_when_it_is_dropped() {
        // Held one at a time rather than up to the concurrency cap, so this says nothing about how
        // many permits exist and stays true whatever else in the suite is holding one.
        let permit = acquire_read_permit()
            .await
            .expect("a free gate admits a read");
        drop(permit);

        acquire_read_permit()
            .await
            .expect("dropping a permit must free the slot it held");
    }

    #[test]
    fn a_refused_read_carries_the_code_the_frontend_catalogues() {
        // The refusal itself is not exercised here, and the reason is worth stating rather than
        // leaving as a gap. Reaching it means putting MAX_LIVE_CHAT_READS_IN_FLIGHT callers in
        // flight on a process-wide static that hands out MAX_CONCURRENT_LIVE_CHAT_READS permits, so
        // every caller past the second parks awaiting a permit no one in the test holds to release.
        // That is a deadlock, not a slow test - the first version of this test was exactly that, and
        // it hung the suite. `BoundedSemaphore`'s own tests avoid it by giving each a private gate
        // with `permits == max_in_flight`, which a shared static cannot be.
        //
        // What those tests already cover is the admit/refuse/release behaviour of the primitive.
        // What they cannot cover is which code *this* gate refuses with, and that is the half with a
        // user-visible consequence: an uncatalogued code degrades in the renderer to "check the app
        // log file" (src/constants/error-codes.test.ts pins the catalogue), which is the wrong
        // advice for someone whose only problem is that another replay is still loading.
        assert_eq!(
            READ_GATE_BUSY_CODE.as_str(),
            "TOO_MANY_CONCURRENT_LIVE_CHAT_READS"
        );
    }

    // The relationship between the two bounds is asserted where they are declared, in a `const`
    // block, rather than by a test here: it is knowable at compile time, so a violated edit should
    // fail the build instead of waiting for the suite.
}
