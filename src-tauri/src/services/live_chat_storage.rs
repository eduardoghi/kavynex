use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;

use crate::services::filesystem::replace_file_safely;
use crate::{AppError, AppErrorCode, AppResult};

#[derive(Debug, Default, Clone)]
pub struct LiveChatCompressionSummary {
    pub scanned: usize,
    pub compressed: usize,
    pub already_compressed: usize,
    pub failed: usize,
}

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

pub fn gzip_decompress(data: &[u8]) -> AppResult<Vec<u8>> {
    let mut decoder = GzDecoder::new(data);
    let mut out = Vec::new();
    decoder
        .read_to_end(&mut out)
        .map_err(|e| compress_error("failed to gunzip live chat data", e))?;
    Ok(out)
}

/// Reads a stored live chat file and returns its JSON text, transparently gunzipping the
/// gzip-compressed files (older files may still be plain JSON and are returned as-is).
pub fn read_live_chat_text(path: &Path) -> AppResult<String> {
    let bytes = fs::read(path).map_err(|e| compress_error("failed to read live chat file", e))?;

    let raw = if is_gzip(&bytes) {
        gzip_decompress(&bytes)?
    } else {
        bytes
    };

    String::from_utf8(raw).map_err(|e| compress_error("live chat file is not valid utf-8", e))
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
        // source copy rather than clobbering it.
        if dest.exists() {
            let _ = fs::remove_file(&path);
            continue;
        }

        // Prefer a rename (fast, same volume); fall back to copy+delete across volumes, which
        // is the expected case when app data is on the SSD and the library is on the HDD.
        if fs::rename(&path, &dest).is_err() {
            fs::copy(&path, &dest)
                .map_err(|e| compress_error("failed to copy live chat file", e))?;
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

/// Compresses `src` and writes the gzip result to `dest` atomically. Used when moving a
/// freshly downloaded live chat file into app storage. Removes `src` on success.
pub fn compress_file_to(src: &Path, dest: &Path) -> AppResult<()> {
    let data = fs::read(src).map_err(|e| compress_error("failed to read live chat source", e))?;
    let compressed = gzip_compress(&data)?;

    let temp = temp_sibling_path(dest)?;
    fs::write(&temp, &compressed)
        .map_err(|e| compress_error("failed to write compressed live chat", e))?;
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
    let compressed = gzip_compress(&data)?;
    let restored = gzip_decompress(&compressed)?;

    if restored != data {
        return Err(AppError::from_code(
            AppErrorCode::LiveChatCompressFailed,
            "gzip round trip verification failed",
        ));
    }

    let temp = temp_sibling_path(path)?;
    fs::write(&temp, &compressed)
        .map_err(|e| compress_error("failed to write compressed live chat", e))?;
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
                    format!("failed to compress {}: {}", path.display(), error),
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
    fn read_live_chat_text_reads_gzip_and_plain() {
        let dir = temp_dir("read");
        fs::create_dir_all(&dir).unwrap();

        let plain = dir.join("plain.json");
        fs::write(&plain, b"{\"a\":1}").unwrap();
        assert_eq!(read_live_chat_text(&plain).unwrap(), "{\"a\":1}");

        let gz = dir.join("compressed.json");
        fs::write(&gz, gzip_compress(b"{\"b\":2}").unwrap()).unwrap();
        assert_eq!(read_live_chat_text(&gz).unwrap(), "{\"b\":2}");

        let _ = fs::remove_dir_all(&dir);
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
