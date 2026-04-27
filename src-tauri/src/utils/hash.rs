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

    Ok(format!("{:x}", hasher.finalize()))
}
