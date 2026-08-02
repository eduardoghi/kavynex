use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use sha2::{Digest, Sha256};

use crate::{AppError, AppErrorCode, AppResult};

/// True once the caller's cancel flag is set. `None` means the caller did not offer one, which is
/// every call site but the media import - so the common path pays one `Option` check per 8 KiB
/// chunk and nothing else.
pub(crate) fn is_cancelled(cancel: Option<&AtomicBool>) -> bool {
    cancel.is_some_and(|flag| flag.load(Ordering::SeqCst))
}

/// Hashes a file, giving up promptly when `cancel` is set.
///
/// The plain [`file_hash`] is this with no flag. It exists because hashing is a full read pass over
/// a file that may be several gigabytes, and it is the *first* long step of a local import - so a
/// user who changes their mind about importing a 50 GB file from a slow external drive would
/// otherwise have nothing to click and no way out but killing the app.
///
/// The flag is read once per 8 KiB chunk, which is frequent enough that a cancel is felt as
/// immediate and cheap enough not to matter next to the read itself. Nothing is written here, so
/// there is nothing to undo: the function simply stops and reports the cancellation.
pub fn file_hash_cancellable(path: &Path, cancel: Option<&AtomicBool>) -> AppResult<String> {
    if !path.exists() {
        return Err(AppError::from_code(
            AppErrorCode::SourceFileNotFound,
            "source file does not exist",
        ));
    }

    if !path.is_file() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidSourceFile,
            "source path is not a file",
        ));
    }

    let file = File::open(path).map_err(|e| {
        AppError::from_code(
            AppErrorCode::FileOpenFailed,
            format!("failed to open file for hashing: {e}"),
        )
    })?;

    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 8192];

    loop {
        // Checked at the top of the loop, so a flag already set when the call starts stops it
        // before the first read rather than after one chunk.
        if is_cancelled(cancel) {
            return Err(AppError::from_code(
                AppErrorCode::MediaImportCancelled,
                "the import was cancelled while hashing the source file",
            ));
        }

        let read = reader.read(&mut buffer).map_err(|e| {
            AppError::from_code(
                AppErrorCode::FileReadFailed,
                format!("failed to read file for hashing: {e}"),
            )
        })?;

        if read == 0 {
            break;
        }

        hasher.update(&buffer[..read]);
    }

    // sha2 0.11 returns a hybrid-array `Array` (no LowerHex), so hex-encode the bytes.
    let digest = hasher.finalize();
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Hashes a file with no cancellation. The shape every caller but the media import wants: the
/// backup staging copies, the content-addressed thumbnail names and the duplicate checks all run on
/// files small enough, or on paths short enough, that there is nothing to interrupt.
pub fn file_hash(path: &Path) -> AppResult<String> {
    file_hash_cancellable(path, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn file_hash_matches_known_sha256() {
        let path = std::env::temp_dir().join(format!(
            "kavynex-hash-test-{}.bin",
            crate::utils::naming::unique_temp_suffix()
        ));

        File::create(&path).unwrap().write_all(b"abc").unwrap();

        // Content-addressed media/thumbnail filenames depend on this exact, stable,
        // lowercase-hex output; it must not change across sha2 upgrades.
        assert_eq!(
            file_hash(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn file_hash_cancellable_gives_up_when_the_flag_is_already_set() {
        // The direction that matters for a multi-gigabyte source: a flag set before the call must
        // stop it without reading the file at all, so a cancel that lands while the import is
        // queued is honoured rather than paying for a full read pass first.
        let path = std::env::temp_dir().join(format!(
            "kavynex-hash-cancel-{}.bin",
            crate::utils::naming::unique_temp_suffix()
        ));
        File::create(&path).unwrap().write_all(b"abc").unwrap();

        let cancel = AtomicBool::new(true);
        let error = file_hash_cancellable(&path, Some(&cancel)).unwrap_err();

        assert_eq!(error.code, AppErrorCode::MediaImportCancelled.as_str());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn file_hash_cancellable_with_an_unset_flag_matches_the_plain_hash() {
        // The other direction, and the one a wrongly-placed check breaks silently: an import that
        // was never cancelled has to produce the same content address as before, or every file
        // already in the library stops being found by name.
        let path = std::env::temp_dir().join(format!(
            "kavynex-hash-nocancel-{}.bin",
            crate::utils::naming::unique_temp_suffix()
        ));
        File::create(&path).unwrap().write_all(b"abc").unwrap();

        let cancel = AtomicBool::new(false);

        assert_eq!(
            file_hash_cancellable(&path, Some(&cancel)).unwrap(),
            file_hash(&path).unwrap()
        );

        let _ = std::fs::remove_file(&path);
    }
}
