//! The gate on an image the user picked from the file dialog, and the name its staged copy lands
//! under.
//!
//! Pure, and a module of its own, for the reason `ssrf_guard.rs`, `thumbnail/url.rs` and
//! `yt_dlp/download/redaction.rs` each became one. This is security logic worth putting under the
//! mutation gate (`src-tauri/.cargo/mutants.toml`), and its previous home cannot be. `thumbnail/temp.rs`
//! spawns FFmpeg and drains its pipes, which a measured pass showed produces fifteen mutants no unit
//! test can kill. A deadline comparison, a byte cap on a pipe, the exit-status checks. Adding that
//! whole file to the gate would mean six exclusions and a permanently noisy run; extracting the part
//! that decides whether a caller-supplied path is allowed through costs one small module.
//!
//! What lives here is exactly that decision. The staging itself (`stage_manual_thumbnail_sync`)
//! stays next door with the filesystem work it does.
//!
//! Measured before the glob entry was added (2026-07-30, `--in-place --no-config --file`). 8
//! mutants, 4 caught, 4 unviable, 0 missed. The same pass over the whole of `temp.rs` reported 86
//! mutants with 15 missed, all of them in the FFmpeg and pipe-draining code, which is the
//! measurement that decided this extraction rather than a widened glob.

use std::path::PathBuf;

use crate::utils::format::{allowed_thumbnail_extensions_label, is_allowed_thumbnail_extension};
use crate::utils::path::{extension_from_path, is_network_path};
use crate::{AppError, AppErrorCode, AppResult};

/// Validates an image the user picked from the file dialog, before anything stats or reads it.
///
/// The network refusal comes first and is the reason this is its own validator rather than a reuse
/// of `temp.rs`'s `validate_source_media_path`. This path arrives raw over IPC, and on Windows merely
/// `is_file()`-ing `\\host\share\x.png` authenticates to `host` over SMB and hands it the user's NTLM
/// hash. Every sibling that takes a caller-supplied path already refuses one
/// (`library::resolve_path_inside_library`, `validate_source_media_path`, `db_backup`'s import and
/// export gates, `yt_dlp::cookies::normalize_cookies_path`); the asset-scope grant this replaced was
/// the last one that did not.
///
/// The extension gate is the same one the preview needs anyway. Only an image is worth staging, and
/// refusing anything else here means the copy that follows can never be pointed at an arbitrary file.
pub(crate) fn validate_picked_thumbnail_path(path: &str) -> AppResult<PathBuf> {
    let trimmed = path.trim();

    if trimmed.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidThumbnailPath,
            "thumbnail path is empty",
        ));
    }

    if is_network_path(trimmed) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidThumbnailPath,
            "thumbnail path must not be a network location",
        ));
    }

    let source_path = PathBuf::from(trimmed);

    if !source_path.is_file() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidThumbnailFile,
            "thumbnail path is not an existing file",
        ));
    }

    if !is_allowed_thumbnail_extension(&extension_from_path(&source_path)) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidThumbnailFile,
            format!(
                "only image files can be used as a thumbnail ({})",
                allowed_thumbnail_extensions_label()
            ),
        ));
    }

    Ok(source_path)
}

/// The name a picked image lands under in the preview directory.
///
/// A distinct prefix from `temp.rs`'s `temporary_thumbnail_file_name` so the two producers sharing
/// that directory can never name the same file, and the source's own extension rather than
/// `THUMBNAIL_OUTPUT_FORMAT` because the staged copy is byte-identical to what the user picked.
/// naming a PNG `.jpg` would make the extension disagree with the bytes, and the persist step
/// downstream derives the stored name from this one.
///
/// Content-addressed like everything else here, which is what makes picking the same image twice
/// free. The second stage finds the file already there.
pub(crate) fn staged_thumbnail_file_name(source_hash: &str, extension: &str) -> String {
    format!("picked_{source_hash}.{extension}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn unique_test_dir() -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-picked-thumbnail-test-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    #[test]
    fn a_network_location_is_rejected() {
        // The check the asset-scope grant this replaced did not have, and the reason it matters more
        // here than anywhere else. This path arrives raw over IPC, and on Windows `is_file()` alone
        // on a UNC share authenticates to that host over SMB and leaks the user's NTLM hash. Every
        // spelling Windows resolves to a share is covered, and each carries a valid image extension
        // so only the network check can be what rejects it.
        for value in [
            r"\\evil\share\cover.png",
            "//evil/share/cover.png",
            r"/\evil\share\cover.png",
            r"\/evil\share\cover.png",
            r"\\?\UNC\evil\share\cover.png",
        ] {
            let error = validate_picked_thumbnail_path(value)
                .expect_err(&format!("{value} should be rejected as a network path"));
            assert_eq!(error.code, AppErrorCode::InvalidThumbnailPath.as_str());
        }
    }

    #[test]
    fn an_empty_path_is_rejected() {
        let error = validate_picked_thumbnail_path("   ").unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidThumbnailPath.as_str());
    }

    #[test]
    fn a_missing_file_is_rejected() {
        let missing = unique_test_dir().join("nope.png");
        let error = validate_picked_thumbnail_path(&missing.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidThumbnailFile.as_str());
    }

    #[test]
    fn an_existing_non_image_file_is_rejected() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("notes.txt");
        fs::write(&file, b"x").unwrap();

        let error = validate_picked_thumbnail_path(&file.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidThumbnailFile.as_str());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_directory_with_an_image_name_is_rejected() {
        // A directory named like an image must not be staged, only regular files are.
        let dir = unique_test_dir();
        let fake = dir.join("thumb.png");
        fs::create_dir_all(&fake).unwrap();

        let error = validate_picked_thumbnail_path(&fake.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidThumbnailFile.as_str());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_existing_image_is_accepted_and_returned_trimmed() {
        let dir = unique_test_dir();
        fs::create_dir_all(&dir).unwrap();

        for name in ["thumb.png", "photo.JPG", "art.webp"] {
            let file = dir.join(name);
            fs::write(&file, b"\x89PNG\r\n").unwrap();

            // Padded input. The returned path is what the copy will read, so it has to be the
            // trimmed one. The same single-path invariant the database export/import gates pin.
            let padded = format!("   {}   ", file.to_string_lossy());
            let accepted = validate_picked_thumbnail_path(&padded)
                .unwrap_or_else(|error| panic!("{name} should be accepted: {error}"));

            assert_eq!(accepted, file);
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_staged_name_carries_the_source_extension_under_its_own_prefix() {
        // Two producers share the preview directory. The prefixes have to differ, or a generated
        // preview and a picked image could name the same file, and the extension has to be the
        // source's, because the staged copy is byte-identical and the persist step downstream names
        // the stored file from this one.
        let hash = "a".repeat(64);

        assert_eq!(
            staged_thumbnail_file_name(&hash, "png"),
            format!("picked_{hash}.png")
        );
        assert!(staged_thumbnail_file_name(&hash, "jpg").starts_with("picked_"));
    }
}
