use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::{AppError, AppErrorCode, AppResult};

pub fn file_hash(path: &Path) -> AppResult<String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn file_hash_matches_known_sha256() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "kavynex-hash-test-{}-{}.bin",
            std::process::id(),
            nanos
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
}
