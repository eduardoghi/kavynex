use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use sha2::{Digest, Sha256};

use crate::{AppError, AppErrorCode, AppResult};

/// How much data moves per read in the streaming helpers here.
const HASH_CHUNK_BYTES: usize = 8192;

/// Streams everything `reader` yields into `writer`, returning the SHA-256 of the bytes that passed
/// through - a tee that hashes what it copies.
///
/// Written as one traversal rather than a hash pass plus a copy pass because its caller has a file
/// it would otherwise read twice: `services::live_chat_storage` compresses a replay into a staged
/// archive and then proves that archive decompresses back to the source's exact bytes. The
/// compression side hands this a gzip encoder, the verification side hands it [`std::io::sink`]
/// because it wants the digest alone, and neither ever holds more than one chunk. That bound is the
/// point: a replay of a long stream runs to hundreds of megabytes, and that module used to keep
/// three copies of one alive at once.
///
/// It lives here rather than beside its caller for the reason its shape makes obvious - it is a
/// hashing primitive, and [`file_hash_cancellable`] below is the same loop with a cancel flag. There
/// is a second consequence worth stating plainly rather than discovering later: `live_chat_storage`
/// is inside the mutation gate (`src-tauri/.cargo/mutants.toml`) and this file is not, so the loop's
/// `read == 0` mutant is not exercised there. That mutant is a genuine one - inverting the EOF check
/// spins forever on an empty reader - and it is caught here by
/// `hashing_a_stream_matches_the_published_sha256_vectors`, whose empty-input case is exactly the
/// input that would hang. Keeping the test is what makes the placement a placement rather than a
/// dodge.
pub fn hash_while_copying<R: Read, W: Write>(reader: &mut R, writer: &mut W) -> AppResult<String> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; HASH_CHUNK_BYTES];

    loop {
        let read = reader.read(&mut buffer).map_err(|e| {
            AppError::from_code(
                AppErrorCode::FileReadFailed,
                format!("failed to read data for hashing: {e}"),
            )
        })?;

        if read == 0 {
            break;
        }

        hasher.update(&buffer[..read]);
        writer.write_all(&buffer[..read]).map_err(|e| {
            AppError::from_code(
                AppErrorCode::FileCopyFailed,
                format!("failed to write data while hashing: {e}"),
            )
        })?;
    }

    Ok(hex_digest(hasher))
}

/// Hex-encodes a finished hasher. sha2 0.11 returns a hybrid-array `Array` (no `LowerHex`), so the
/// encoding is spelled out; sharing it keeps the two producers here from drifting into different
/// casings, which would silently break any comparison between them.
fn hex_digest(hasher: Sha256) -> String {
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

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
    let mut buffer = [0_u8; HASH_CHUNK_BYTES];

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

    Ok(hex_digest(hasher))
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
    fn hashing_a_stream_matches_the_published_sha256_vectors() {
        // Anchored on the published vectors rather than on this module's other hasher, so the two
        // cannot agree by being wrong together - the same reason `file_hash_matches_known_sha256`
        // above pins the "abc" digest.
        //
        // The empty case carries a second job. It is the one input where a mutated EOF check
        // (`read != 0`) never terminates, and this file sits outside the mutation gate, so this
        // assertion is what stands in for the mutant that would otherwise be reported next door.
        let mut empty: &[u8] = b"";
        let mut sink = std::io::sink();
        assert_eq!(
            hash_while_copying(&mut empty, &mut sink).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );

        let mut abc: &[u8] = b"abc";
        assert_eq!(
            hash_while_copying(&mut abc, &mut sink).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn hashing_a_stream_copies_every_byte_and_agrees_with_the_file_hasher() {
        // Deliberately spans several chunks and is not a repeating byte, so a loop that dropped a
        // chunk, hashed before advancing, or mis-sliced the tail lands on a different digest rather
        // than on the same answer by symmetry.
        let payload: Vec<u8> = (0..(HASH_CHUNK_BYTES * 3 + 517))
            .map(|index| (index % 251) as u8)
            .collect();

        let mut source = payload.as_slice();
        let mut copied = Vec::new();
        let digest = hash_while_copying(&mut source, &mut copied).unwrap();

        assert_eq!(copied, payload, "the copy must be byte-exact");

        // The two hashers here take different routes to the same answer (a BufReader over a file
        // versus a tee over a slice), so agreeing is a real cross-check on both.
        let path = std::env::temp_dir().join(format!(
            "kavynex-hash-stream-{}.bin",
            crate::utils::naming::unique_temp_suffix()
        ));
        File::create(&path).unwrap().write_all(&payload).unwrap();
        assert_eq!(digest, file_hash(&path).unwrap());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn hashing_a_stream_distinguishes_payloads_that_differ_by_one_byte() {
        // The digest is what `live_chat_storage`'s verification compares, so it has to depend on
        // the content: a helper returning a constant would satisfy one vector test by coincidence
        // but cannot satisfy this at the same time.
        let first = vec![7u8; 64];
        let mut second = first.clone();
        second[63] = 8;

        let mut sink = std::io::sink();
        let first_digest = hash_while_copying(&mut first.as_slice(), &mut sink).unwrap();
        let second_digest = hash_while_copying(&mut second.as_slice(), &mut sink).unwrap();

        assert_ne!(first_digest, second_digest);
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
