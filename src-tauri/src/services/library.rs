pub use crate::services::library_media::{delete_media_file_sync, import_media_file_sync};
pub use crate::services::library_migration::migrate_library_directory_sync;
pub use crate::services::library_paths::{
    ensure_directory_exists_sync, ensure_library_dir, resolve_default_library_directory_sync,
    resolve_existing_directory_sync, resolve_existing_library_dir,
};
pub use crate::services::library_summary::LibrarySummaryInfo;

use std::path::PathBuf;

use crate::services::library_summary::summarize_library;
use crate::{AppError, AppErrorCode, AppResult};

pub fn get_library_summary_sync(library_path: &str) -> AppResult<LibrarySummaryInfo> {
    let library_dir = resolve_existing_library_dir(library_path)?;
    summarize_library(&library_dir)
}

/// True for a UNC / network location (`\\host\share` or `//host/share`). Merely
/// canonicalizing or opening one of these on Windows makes the OS reach out to `host` over
/// SMB and authenticate, which leaks the user's NTLM hash to whoever controls that host - so
/// a network path must be rejected *before* any filesystem call touches it, not after.
fn is_network_path(value: &str) -> bool {
    let value = value.trim_start();

    // Windows verbatim prefix: `\\?\UNC\...` is a network share, but `\\?\C:\...` (and the
    // `\\.\` device namespace) are local, so those must not be treated as network even though
    // they start with two backslashes.
    if let Some(rest) = value.strip_prefix(r"\\?\") {
        return rest.starts_with("UNC\\") || rest.starts_with("unc\\");
    }

    if value.starts_with(r"\\.\") {
        return false;
    }

    value.starts_with(r"\\") || value.starts_with("//")
}

/// Resolves `path` relative to `library_path` (or as-is if absolute), verifies that
/// the result exists and is contained within the library, and returns the canonical path.
pub fn resolve_path_inside_library(path: &str, library_path: Option<&str>) -> AppResult<PathBuf> {
    let normalized = path.trim();

    if normalized.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidMediaPath,
            "path is empty",
        ));
    }

    let base_library = match library_path.map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => p,
        None => {
            return Err(AppError::from_code(
                AppErrorCode::InvalidMediaPath,
                "library_path is required",
            ))
        }
    };

    let candidate = PathBuf::from(normalized);

    let resolved_path = if candidate.is_absolute() {
        candidate
    } else {
        PathBuf::from(base_library).join(candidate)
    };

    // Refuse UNC / network locations before any filesystem call. Both `path` and
    // `library_path` arrive over IPC, and the containment check below cannot be trusted to
    // catch this because `library_path` is caller-supplied too: an attacker who drives IPC can
    // pass a `\\host\share` as both, making `starts_with` trivially true. Rejecting here - and
    // before the `canonicalize` calls, which is what would trigger the SMB/NTLM handshake -
    // closes that. The cost is that a library kept on a network share loses only the "reveal in
    // file manager" convenience; playback, import and download are unaffected.
    if is_network_path(base_library) || is_network_path(&resolved_path.to_string_lossy()) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidMediaPath,
            "network paths are not allowed",
        ));
    }

    let canonical_library = std::fs::canonicalize(base_library).map_err(|_| {
        AppError::from_code(
            AppErrorCode::InvalidMediaPath,
            "library path does not exist or cannot be resolved",
        )
    })?;

    let canonical_path = std::fs::canonicalize(&resolved_path).map_err(|_| {
        AppError::from_code(
            AppErrorCode::InvalidMediaPath,
            format!("path does not exist: {}", resolved_path.to_string_lossy()),
        )
    })?;

    if !canonical_path.starts_with(&canonical_library) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidMediaPath,
            "path is outside the library directory",
        ));
    }

    Ok(canonical_path)
}

// `std::fs::canonicalize` on Windows returns an extended-length (`\\?\`) path. That form is
// correct for the containment check above, but `explorer /select,` does not reliably highlight
// a file when given a verbatim path, so strip the prefix before handing the path to explorer.
#[cfg(target_os = "windows")]
fn strip_windows_verbatim_prefix(path: &std::path::Path) -> std::path::PathBuf {
    let text = path.to_string_lossy();

    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\\{rest}"));
    }

    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return std::path::PathBuf::from(rest);
    }

    path.to_path_buf()
}

// Each platform block ends with an explicit `return` because the sibling `#[cfg]` blocks
// are stripped per-target, so the active block is a statement, not the function tail.
#[allow(clippy::needless_return)]
pub fn open_path_in_system_sync(path: &str, library_path: Option<&str>) -> AppResult<()> {
    let canonical_path = resolve_path_inside_library(path, library_path)?;

    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new("explorer");
        let explorer_path = strip_windows_verbatim_prefix(&canonical_path);

        if canonical_path.is_file() {
            command.arg("/select,").arg(&explorer_path);
        } else {
            command.arg(&explorer_path);
        }

        command.spawn().map_err(|error| {
            AppError::from_code(
                AppErrorCode::InvalidMediaPath,
                format!("failed to open path in system explorer: {error}"),
            )
        })?;

        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");

        if canonical_path.is_file() {
            command.arg("-R").arg(&canonical_path);
        } else {
            command.arg(&canonical_path);
        }

        command.spawn().map_err(|error| {
            AppError::from_code(
                AppErrorCode::InvalidMediaPath,
                format!("failed to open path in Finder: {error}"),
            )
        })?;

        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = if canonical_path.is_file() {
            canonical_path
                .parent()
                .unwrap_or(&canonical_path)
                .to_path_buf()
        } else {
            canonical_path
        };

        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|error| {
                AppError::from_code(
                    AppErrorCode::InvalidMediaPath,
                    format!("failed to open path in file manager: {error}"),
                )
            })?;

        return Ok(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn make_temp_library(suffix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kavynex-library-test-{suffix}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_when_library_path_is_none() {
        let result = resolve_path_inside_library("video.mp4", None);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("library_path is required"));
    }

    #[test]
    fn rejects_when_library_path_is_empty() {
        let result = resolve_path_inside_library("video.mp4", Some(""));
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("library_path is required"));
    }

    #[test]
    fn rejects_absolute_path_outside_library() {
        let library = make_temp_library("outside-check");

        #[cfg(target_os = "windows")]
        let outside = "C:\\Windows\\System32";
        #[cfg(not(target_os = "windows"))]
        let outside = "/etc";

        let result = resolve_path_inside_library(outside, Some(library.to_str().unwrap()));
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("outside the library directory") || msg.contains("does not exist"),
            "unexpected error: {msg}"
        );
        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn rejects_relative_traversal_outside_library() {
        let library = make_temp_library("traversal-check");

        let result =
            resolve_path_inside_library("../../etc/passwd", Some(library.to_str().unwrap()));
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("outside the library directory") || msg.contains("does not exist"),
            "unexpected error: {msg}"
        );
        let _ = fs::remove_dir_all(&library);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn strip_windows_verbatim_prefix_removes_extended_length_prefixes() {
        use std::path::{Path, PathBuf};

        assert_eq!(
            strip_windows_verbatim_prefix(Path::new(r"\\?\C:\Users\me\video.mp4")),
            PathBuf::from(r"C:\Users\me\video.mp4")
        );
        assert_eq!(
            strip_windows_verbatim_prefix(Path::new(r"\\?\UNC\server\share\clip.mp4")),
            PathBuf::from(r"\\server\share\clip.mp4")
        );
        // A path without the prefix is returned unchanged.
        assert_eq!(
            strip_windows_verbatim_prefix(Path::new(r"C:\Users\me\video.mp4")),
            PathBuf::from(r"C:\Users\me\video.mp4")
        );
    }

    #[test]
    fn accepts_relative_path_inside_library() {
        let library = make_temp_library("in-library-check");
        let file_path = library.join("video.mp4");
        fs::write(&file_path, b"").unwrap();

        let result = resolve_path_inside_library("video.mp4", Some(library.to_str().unwrap()));
        assert!(result.is_ok(), "expected Ok but got: {:?}", result.err());
        assert_eq!(result.unwrap(), file_path.canonicalize().unwrap());
        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn is_network_path_flags_unc_and_forward_slash_shares() {
        for value in [
            r"\\server\share",
            r"\\server\share\clip.mp4",
            "//server/share",
            r"\\?\UNC\server\share", // verbatim UNC is still a network share
        ] {
            assert!(is_network_path(value), "should flag: {value}");
        }

        for value in [
            r"C:\Users\me\video.mp4",
            "/home/me/video.mp4",
            "video/clip.mp4",
            r"\\?\C:\Users\me\video.mp4", // extended-length local path, not a network share
        ] {
            assert!(!is_network_path(value), "should not flag: {value}");
        }
    }

    #[test]
    fn rejects_network_path_as_the_target() {
        // A caller that drives IPC could pass a UNC path as both `path` and `library_path`,
        // making the containment check self-referential; it must be rejected before any
        // filesystem call (canonicalize) can trigger an SMB/NTLM handshake.
        let error = resolve_path_inside_library(r"\\attacker\share", Some(r"\\attacker\share"))
            .unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidMediaPath.as_str());
    }

    #[test]
    fn rejects_network_path_built_from_a_network_library_base() {
        // A relative `path` joined onto a UNC `library_path` still resolves to a network
        // location, so it must be rejected too (the join, not just the raw argument).
        let error = resolve_path_inside_library("clip.mp4", Some(r"\\attacker\share")).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidMediaPath.as_str());
    }
}
