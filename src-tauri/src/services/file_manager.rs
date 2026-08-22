//! Revealing a path in the operating system's own file manager.
//!
//! This used to live inside `services::library`, which is where its first caller was but not where
//! it belongs: resolving `explorer.exe`/`open`/`xdg-open` and spawning it has nothing to do with
//! the user's media directory. It moved when a second caller appeared (the Diagnostics dialog's
//! "Open log folder"), and the alternative was a second copy of the three platform spawn branches,
//! which is exactly the kind of duplicated rule this codebase gates elsewhere rather than tolerates.
//!
//! **The split between what is here and what is not is the security-relevant part.**
//! [`reveal_canonical_path`] reveals whatever canonical path it is handed and decides nothing about
//! whether that path is one the app may act on. Deciding that is the caller's whole job, and there
//! are exactly two callers, each answering it a different way:
//!
//! - `library::open_path_in_system_sync` confines the caller-supplied path to the configured
//!   library first (`resolve_path_inside_library`, behind the settings cross-check in
//!   `library::guard`). Its path comes over IPC, so it is guarded.
//! - [`reveal_app_log_dir`] takes **no path at all** and derives one from `app_log_dir()`. A command
//!   that accepts nothing cannot be redirected, which is why the log folder needed its own entry
//!   point instead of reusing the library one. Passing the log directory as both `path` and
//!   `library_path` to that command would satisfy its containment check trivially, which is the
//!   self-referential shape `docs/THREAT-MODEL.md` records as a defect rather than a pattern to reuse.
//!
//! A third caller has to answer the same question before it uses this, and neither of the two ways
//! above generalizes for free.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use crate::services::logger;
use crate::{AppError, AppErrorCode, AppResult};

// `std::fs::canonicalize` on Windows returns an extended-length (`\\?\`) path. That form is
// correct for a containment check, but `explorer /select,` does not reliably highlight a file when
// given a verbatim path, so strip the prefix before handing the path to explorer.
#[cfg(target_os = "windows")]
fn strip_windows_verbatim_prefix(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();

    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }

    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }

    path.to_path_buf()
}

/// Resolves the OS file manager this module reveals a path with, never by bare name.
///
/// `Command::new("explorer")` hands the lookup to the OS executable search order, which on Windows
/// begins with the directory of the running application. The working-directory/app-directory
/// hijack class `services::binaries` was hardened against for yt-dlp and ffmpeg
/// (`resolve_from_path_var`, and `docs/THREAT-MODEL.md`'s "External binary resolution"). These spawns
/// sat outside that policy only because they lived in a different module, not because a file manager
/// deserves less care than a downloader: it is spawned from a process that owns the user's library.
///
/// Windows and macOS have a fixed system location for theirs, so those are absolute paths built
/// from `%SystemRoot%` (set by the OS, not by any caller) and a literal respectively. Linux has no
/// fixed location for `xdg-open`, so it goes through the same PATH-only search yt-dlp and ffmpeg
/// use, which skips empty `PATH` entries, i.e. never resolves out of the current directory.
#[cfg(target_os = "windows")]
fn resolve_file_manager_binary() -> AppResult<PathBuf> {
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| String::from(r"C:\Windows"));

    Ok(PathBuf::from(system_root).join("explorer.exe"))
}

#[cfg(target_os = "macos")]
fn resolve_file_manager_binary() -> AppResult<PathBuf> {
    Ok(PathBuf::from("/usr/bin/open"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn resolve_file_manager_binary() -> AppResult<PathBuf> {
    crate::services::binaries::resolve_from_path(&["xdg-open"])
        .map(PathBuf::from)
        .ok_or_else(|| {
            AppError::from_code(
                AppErrorCode::InvalidMediaPath,
                "xdg-open was not found in PATH, so the file manager cannot be opened",
            )
        })
}

/// Reveals an already-canonical, already-authorized path in the OS file manager.
///
/// `failure_code` is the error code a failed spawn is reported under, and it is a parameter rather
/// than a constant because the two callers are different operations: a media file that will not
/// reveal is an `InvalidMediaPath` to the flow that asked, while the log folder failing to open is
/// not about a media path at all. Passing it keeps each caller's observable error honest instead of
/// making one of them lie for the other's benefit.
///
/// See the module comment for the contract this does *not* enforce: the caller must already have
/// decided that this path is one the app may reveal.
///
/// Each platform block ends with an explicit `return` because the sibling `#[cfg]` blocks are
/// stripped per-target, so the active block is a statement, not the function tail.
#[allow(clippy::needless_return)]
pub(crate) fn reveal_canonical_path(
    canonical_path: &Path,
    failure_code: AppErrorCode,
) -> AppResult<()> {
    let file_manager = resolve_file_manager_binary()?;

    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new(file_manager);
        let explorer_path = strip_windows_verbatim_prefix(canonical_path);

        if canonical_path.is_file() {
            command.arg("/select,").arg(&explorer_path);
        } else {
            command.arg(&explorer_path);
        }

        command.spawn().map_err(|error| {
            AppError::from_code(
                failure_code,
                format!("failed to open path in system explorer: {error}"),
            )
        })?;

        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        // Always reveal, never open. A macOS `.app` bundle is a *directory*, so plain `open <dir>`
        // would launch the application rather than show it in Finder, and the library caller's
        // `path` and `library_path` both arrive from the caller, so its containment check cannot
        // rule that out on its own (a caller can pass `/Applications` as both). `-R` reveals files
        // and directories alike, which is all this function is ever meant to do.
        let mut command = std::process::Command::new(file_manager);
        command.arg("-R").arg(canonical_path);

        command.spawn().map_err(|error| {
            AppError::from_code(
                failure_code,
                format!("failed to open path in Finder: {error}"),
            )
        })?;

        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = if canonical_path.is_file() {
            canonical_path.parent().unwrap_or(canonical_path)
        } else {
            canonical_path
        };

        std::process::Command::new(file_manager)
            .arg(target)
            .spawn()
            .map_err(|error| {
                AppError::from_code(
                    failure_code,
                    format!("failed to open path in file manager: {error}"),
                )
            })?;

        return Ok(());
    }
}

/// Makes an app-owned directory ready to be revealed, and returns its canonical path.
///
/// The `create_dir_all` is not defensive tidying. The log directory is created by `logger::init` at
/// startup, but that is best effort (it returns early when the create fails) and nothing stops the
/// user deleting the folder while the app runs, and revealing a directory that is not there fails
/// on every platform, which would surface as a button that sometimes does nothing. Creating it
/// makes the button always land somewhere. It is safe to create because the path is derived from
/// the OS, never from a caller: this is not the caller-chosen `create_dir_all` that
/// `docs/THREAT-MODEL.md` records as an accepted residual for `ensure_directory_exists`.
///
/// Split out from [`reveal_app_log_dir`] because it is the whole of that function a test can
/// observe: the resolution needs a live `AppHandle` and the reveal spawns a real file manager,
/// neither of which belongs in a unit test.
fn prepare_dir_for_reveal(dir: &Path) -> AppResult<PathBuf> {
    std::fs::create_dir_all(dir).map_err(|error| {
        AppError::from_code(
            AppErrorCode::LogDirectoryOpenFailed,
            format!(
                "failed to create the directory {}: {error}",
                logger::redact_path(dir)
            ),
        )
    })?;

    dir.canonicalize().map_err(|error| {
        AppError::from_code(
            AppErrorCode::LogDirectoryOpenFailed,
            format!(
                "failed to resolve the directory {}: {error}",
                logger::redact_path(dir)
            ),
        )
    })
}

/// Reveals the app's log directory in the OS file manager.
///
/// Takes no path, and that is the point rather than a convenience: this is the one thing that makes
/// it safe without a containment check. The README asks users to attach `kavynex.log` to a bug
/// report and then tells them where to find it per OS; a command that accepts a path could be
/// redirected by a compromised renderer to reveal any directory on disk, so it accepts none and
/// asks Tauri where the log directory is.
///
/// No network-location refusal, deliberately, and for the same reason `set_external_backup_dir` has
/// none: the UNC rule exists to stop a *caller-supplied* path pointing at an attacker's host, and
/// this path comes from the OS. A Windows profile redirected onto a corporate share is a supported
/// configuration where refusing would break the feature for the user whose own share it is.
pub fn reveal_app_log_dir<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    let log_dir = app.path().app_log_dir().map_err(|error| {
        AppError::from_code(
            AppErrorCode::LogDirectoryOpenFailed,
            format!("failed to resolve the app log directory: {error}"),
        )
    })?;

    let canonical_log_dir = prepare_dir_for_reveal(&log_dir)?;

    reveal_canonical_path(&canonical_log_dir, AppErrorCode::LogDirectoryOpenFailed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn unique_test_dir(suffix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-file-manager-test-{suffix}-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    // The property that matters is the same on every platform and is what a bare-name spawn would
    // not have: whatever this returns is an absolute path, so the OS never gets to pick the
    // executable out of its own search order (which on Windows starts with the application's
    // directory). Split per target because each one resolves it a different way.

    #[cfg(target_os = "windows")]
    #[test]
    fn file_manager_resolves_to_explorer_under_the_system_root() {
        let resolved = resolve_file_manager_binary().unwrap();

        assert!(
            resolved.is_absolute(),
            "the file manager must be an absolute path, got {}",
            resolved.display()
        );
        assert!(resolved.ends_with("explorer.exe"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn file_manager_resolves_to_the_system_open_binary() {
        assert_eq!(
            resolve_file_manager_binary().unwrap(),
            PathBuf::from("/usr/bin/open")
        );
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn file_manager_resolves_xdg_open_to_an_absolute_path_when_it_is_installed() {
        // xdg-open is not guaranteed on every machine the suite runs on (it is a desktop package,
        // and ci.yml's Ubuntu job does not install it), so a missing one is a valid outcome rather
        // than a failure. What is asserted is the part that must hold whenever it *is* found: the
        // lookup went through the PATH-only search and produced an absolute path, never the bare
        // name the OS would have resolved itself.
        if let Ok(resolved) = resolve_file_manager_binary() {
            assert!(
                resolved.is_absolute(),
                "the file manager must be an absolute path, got {}",
                resolved.display()
            );
            assert!(resolved.ends_with("xdg-open"));
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn strip_windows_verbatim_prefix_removes_extended_length_prefixes() {
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
    fn preparing_a_directory_creates_it_when_it_is_missing() {
        // The branch the log-folder button depends on: the directory is created by logger::init at
        // startup, but that is best effort and the user can delete it while the app runs. Without
        // the create, revealing it fails and the button does nothing.
        let dir = unique_test_dir("missing");
        assert!(!dir.exists());

        let prepared = prepare_dir_for_reveal(&dir).unwrap();

        assert!(dir.is_dir(), "the directory should have been created");
        assert_eq!(prepared, dir.canonicalize().unwrap());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn preparing_a_directory_returns_its_canonical_form() {
        // The reveal is handed this value, and on Windows the canonical form is the `\\?\` one the
        // spawn strips before passing to explorer. Routing through a `..` segment yields a path
        // whose canonical form differs on every platform, which keeps this portable.
        let base = unique_test_dir("canonical");
        let nested = base.join("sub");
        fs::create_dir_all(&nested).unwrap();

        let indirect = nested.join("..");
        let prepared = prepare_dir_for_reveal(&indirect).unwrap();

        assert_eq!(prepared, base.canonicalize().unwrap());
        assert_ne!(prepared, indirect);

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn preparing_a_directory_fails_when_a_file_occupies_the_path() {
        // create_dir_all cannot replace a file, so this is the failure the caller has to surface
        // rather than spawn a file manager at a path that is not a directory.
        let base = unique_test_dir("blocked");
        fs::create_dir_all(&base).unwrap();

        let occupied = base.join("logs");
        fs::write(&occupied, b"not a directory").unwrap();

        let error = prepare_dir_for_reveal(&occupied).unwrap_err();
        assert_eq!(error.code, AppErrorCode::LogDirectoryOpenFailed.as_str());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn preparing_a_directory_reports_a_failure_without_the_absolute_path() {
        // A log line and an error message can both reach a public bug report, so the failure names
        // the final component through logger::redact_path rather than embedding
        // `C:\Users\<name>\...`. Same rule ci.yml's "Verify log lines redact absolute paths" step
        // enforces for the logger calls.
        let base = unique_test_dir("redaction");
        fs::create_dir_all(&base).unwrap();

        let occupied = base.join("logs");
        fs::write(&occupied, b"not a directory").unwrap();

        let error = prepare_dir_for_reveal(&occupied).unwrap_err();

        assert!(
            error.message.contains("logs"),
            "the failure should still name the directory: {}",
            error.message
        );
        assert!(
            !error.message.contains(&base.to_string_lossy().to_string()),
            "the failure must not carry the absolute path: {}",
            error.message
        );

        let _ = fs::remove_dir_all(&base);
    }
}
