use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

use chrono::{NaiveDate, Utc};
use tauri::{AppHandle, Manager};

use crate::models::yt_dlp::{ExternalToolHealth, ExternalToolsStatus};
use crate::utils::process::hide_console;
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && (metadata.permissions().mode() & 0o111 != 0))
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(not(any(unix, windows)))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn resolve_from_path(candidates: &[&str]) -> Option<String> {
    let path_var = std::env::var_os("PATH")?;
    resolve_from_path_var(&path_var, candidates)
}

#[cfg(windows)]
fn resolve_from_path_var(path_var: &OsStr, candidates: &[&str]) -> Option<String> {
    // Resolve against the directories listed in PATH only. Unlike where.exe, this never
    // searches the current working directory, which where.exe probes before PATH and would
    // let a malicious yt-dlp.exe/ffmpeg.exe planted in the process CWD win over the real one
    // on PATH (arbitrary code execution).
    //
    // PATHEXT is honored so a bare candidate like "yt-dlp" still resolves to "yt-dlp.exe" or
    // a ".cmd"/".bat" shim, matching how the shell would find it.
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());

    for candidate in candidates {
        for dir in std::env::split_paths(path_var) {
            if dir.as_os_str().is_empty() {
                continue;
            }

            let direct = dir.join(candidate);
            if is_executable_file(&direct) {
                return Some(direct.to_string_lossy().to_string());
            }

            if Path::new(candidate).extension().is_none() {
                for ext in pathext.split(';').filter(|value| !value.is_empty()) {
                    let with_ext = dir.join(format!("{candidate}{ext}"));
                    if is_executable_file(&with_ext) {
                        return Some(with_ext.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    None
}

#[cfg(not(windows))]
fn resolve_from_path_var(path_var: &OsStr, candidates: &[&str]) -> Option<String> {
    // Resolve against the directories listed in PATH only. An empty PATH entry historically
    // means "current directory"; it is skipped so a binary in the process CWD is never picked
    // up implicitly.
    for candidate in candidates {
        for dir in std::env::split_paths(path_var) {
            if dir.as_os_str().is_empty() {
                continue;
            }

            let candidate_path = dir.join(candidate);
            if is_executable_file(&candidate_path) {
                return Some(candidate_path.to_string_lossy().to_string());
            }
        }
    }

    None
}

fn resolve_binary_from_candidates(
    app: &AppHandle,
    candidates: &[&str],
    error_code: AppErrorCode,
    error_message: &str,
) -> AppResult<String> {
    if let Some(found_path) = resolve_from_path(candidates) {
        return Ok(found_path);
    }

    let data_dir: PathBuf = app.path().app_data_dir().map_err(|e| {
        AppError::from_code(
            AppErrorCode::DataDirectoryResolveFailed,
            format!("failed to resolve app data directory: {e}"),
        )
    })?;

    let tools_dir = data_dir.join("tools");

    for candidate in candidates {
        let bundled = tools_dir.join(candidate);

        if is_executable_file(&bundled) {
            return Ok(bundled.to_string_lossy().to_string());
        }
    }

    Err(AppError::from_code(error_code, error_message))
}

pub fn resolve_yt_dlp_binary(app: &AppHandle) -> AppResult<String> {
    let candidates = if cfg!(target_os = "windows") {
        vec!["yt-dlp.exe", "yt-dlp"]
    } else {
        vec!["yt-dlp"]
    };

    resolve_binary_from_candidates(
        app,
        &candidates,
        AppErrorCode::YtDlpNotFound,
        "yt-dlp was not found. Install yt-dlp and ensure it is available in PATH, or place an executable binary inside the app data tools folder.",
    )
}

pub fn resolve_ffmpeg_binary(app: &AppHandle) -> AppResult<String> {
    let candidates = if cfg!(target_os = "windows") {
        vec!["ffmpeg.exe", "ffmpeg"]
    } else {
        vec!["ffmpeg"]
    };

    resolve_binary_from_candidates(
        app,
        &candidates,
        AppErrorCode::FfmpegNotFound,
        "ffmpeg was not found. Install ffmpeg and ensure it is available in PATH, or place an executable binary inside the app data tools folder.",
    )
}

/// Parses the release date out of a yt-dlp version string.
///
/// yt-dlp versions are dates: `2026.07.01` for a stable release, with a trailing build counter on
/// a nightly/master build (`2026.07.01.123456`). Anything that is not a plausible date - ffmpeg's
/// `N-124716-g054dffd133-win64-gpl`, a distro-patched string, an empty read - yields `None` rather
/// than a guess, since a wrong date here would show the user a warning about nothing.
fn parse_release_date(version: &str) -> Option<NaiveDate> {
    let mut parts = version.trim().split('.');

    let year: i32 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;

    // Guard against a version that merely looks numeric (something like `1.2.3` parses fine but is
    // not a date). NaiveDate rejects an impossible month/day; the year bound rejects the rest.
    if !(2000..=2999).contains(&year) {
        return None;
    }

    NaiveDate::from_ymd_opt(year, month, day)
}

/// Days between the release `version` names and `today`, or `None` when the version does not
/// encode a date. A version dated in the future (a clock skewed backwards, a nightly built
/// elsewhere) reports 0 rather than a negative age: the tool is not stale, which is all the caller
/// asks about.
fn release_age_days(version: &str, today: NaiveDate) -> Option<u32> {
    let released = parse_release_date(version)?;

    Some((today - released).num_days().max(0) as u32)
}

fn run_command_and_capture_first_line(
    binary_path: &str,
    args: &[&str],
    error_code: AppErrorCode,
    default_message: &str,
) -> AppResult<String> {
    let mut command = Command::new(binary_path);
    command.args(args);
    hide_console(&mut command);

    let output = command.output().map_err(|e| {
        AppError::from_code(
            error_code,
            format!("{default_message}: failed to execute command: {e}"),
        )
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "unknown execution failure".to_string()
        };

        return Err(AppError::from_code(
            error_code,
            format!("{default_message}: {detail}"),
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let version = stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("unknown")
        .to_string();

    Ok(version)
}

pub fn validate_yt_dlp_binary(binary_path: &str) -> AppResult<String> {
    run_command_and_capture_first_line(
        binary_path,
        &["--version"],
        AppErrorCode::YtDlpMetadataExecFailed,
        "yt-dlp binary was found but failed health check",
    )
}

pub fn validate_ffmpeg_binary(binary_path: &str) -> AppResult<String> {
    run_command_and_capture_first_line(
        binary_path,
        &["-version"],
        AppErrorCode::FfmpegExecFailed,
        "ffmpeg binary was found but failed health check",
    )
}

pub fn resolve_external_tools_status(app: &AppHandle) -> AppResult<ExternalToolsStatus> {
    let yt_dlp_path = resolve_yt_dlp_binary(app)?;
    let ffmpeg_path = resolve_ffmpeg_binary(app)?;

    let yt_dlp_version = validate_yt_dlp_binary(&yt_dlp_path)?;
    let ffmpeg_version = validate_ffmpeg_binary(&ffmpeg_path)?;

    // Only yt-dlp carries a date in its version, so ffmpeg simply reports no age. The clock is
    // read once, here at the boundary, so the age computation itself stays pure and testable.
    let today = Utc::now().date_naive();
    let yt_dlp_age = release_age_days(&yt_dlp_version, today);

    Ok(ExternalToolsStatus {
        yt_dlp: ExternalToolHealth {
            path: yt_dlp_path,
            version: yt_dlp_version,
            healthy: true,
            release_age_days: yt_dlp_age,
        },
        ffmpeg: ExternalToolHealth {
            path: ffmpeg_path,
            version: ffmpeg_version,
            healthy: true,
            release_age_days: None,
        },
    })
}

// Async wrappers so callers on the Tokio runtime do not block a worker thread while these
// shell out (where.exe/which, and the `--version` health checks). Blocking work is moved to
// the dedicated blocking pool via `run_blocking`.
pub async fn resolve_yt_dlp_binary_async(app: &AppHandle) -> AppResult<String> {
    let app = app.clone();
    run_blocking(move || resolve_yt_dlp_binary(&app)).await
}

pub async fn resolve_ffmpeg_binary_async(app: &AppHandle) -> AppResult<String> {
    let app = app.clone();
    run_blocking(move || resolve_ffmpeg_binary(&app)).await
}

pub async fn resolve_external_tools_status_async(
    app: &AppHandle,
) -> AppResult<ExternalToolsStatus> {
    let app = app.clone();
    run_blocking(move || resolve_external_tools_status(&app)).await
}

pub fn ffmpeg_location_argument(ffmpeg_binary: &str) -> String {
    let ffmpeg_path = PathBuf::from(ffmpeg_binary);

    if ffmpeg_path.components().count() == 1 {
        return ffmpeg_binary.to_string();
    }

    ffmpeg_path
        .parent()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| ffmpeg_binary.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_executable(path: &Path) {
        std::fs::write(path, b"binary").unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(path, perms).unwrap();
        }
    }

    fn unique_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        std::env::temp_dir().join(format!(
            "kavynex-binaries-{tag}-{}-{}",
            std::process::id(),
            nanos
        ))
    }

    // The security guarantee: only directories explicitly listed in PATH are searched. A
    // binary that exists somewhere not on PATH (the process CWD being the case that matters)
    // must never be resolved.
    #[test]
    fn resolve_from_path_var_only_searches_listed_directories() {
        let base = unique_dir("path");
        let dir_a = base.join("a");
        let dir_b = base.join("b");
        std::fs::create_dir_all(&dir_a).unwrap();
        std::fs::create_dir_all(&dir_b).unwrap();

        let name = if cfg!(windows) {
            "kavynex-fake-tool.exe"
        } else {
            "kavynex-fake-tool"
        };
        make_executable(&dir_b.join(name));
        let candidates = [name];

        let only_a = std::env::join_paths([dir_a.as_os_str()]).unwrap();
        assert!(resolve_from_path_var(&only_a, &candidates).is_none());

        let only_b = std::env::join_paths([dir_b.as_os_str()]).unwrap();
        let found = resolve_from_path_var(&only_b, &candidates).unwrap();
        assert!(Path::new(&found).ends_with(name));

        let both = std::env::join_paths([dir_a.as_os_str(), dir_b.as_os_str()]).unwrap();
        assert!(resolve_from_path_var(&both, &candidates).is_some());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn resolve_from_path_var_honors_pathext_for_bare_candidate() {
        let base = unique_dir("pathext");
        std::fs::create_dir_all(&base).unwrap();
        make_executable(&base.join("kavynex-fake-tool.exe"));

        let path = std::env::join_paths([base.as_os_str()]).unwrap();
        let found = resolve_from_path_var(&path, &["kavynex-fake-tool"]).unwrap();
        assert!(found.to_lowercase().ends_with("kavynex-fake-tool.exe"));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn release_age_days_reads_the_date_out_of_a_yt_dlp_version() {
        let today = NaiveDate::from_ymd_opt(2026, 7, 16).unwrap();

        // A stable release, and the same date as a nightly with a trailing build counter.
        assert_eq!(release_age_days("2026.07.01", today), Some(15));
        assert_eq!(release_age_days("2026.07.01.123456", today), Some(15));
        assert_eq!(release_age_days("  2026.07.16  ", today), Some(0));
        assert_eq!(release_age_days("2025.07.16", today), Some(365));
    }

    #[test]
    fn release_age_days_reports_no_age_for_a_version_that_is_not_a_date() {
        let today = NaiveDate::from_ymd_opt(2026, 7, 16).unwrap();

        for version in [
            // ffmpeg's own version line: must never be mistaken for a date.
            "ffmpeg version N-124716-g054dffd133-win64-gpl",
            "N-124716-g054dffd133",
            // Numeric but not a date - the shape a naive parser would happily accept.
            "1.2.3",
            "2026.13.01",
            "2026.02.30",
            "2026.07",
            "unknown",
            "",
        ] {
            assert_eq!(
                release_age_days(version, today),
                None,
                "{version} should not yield an age"
            );
        }
    }

    #[test]
    fn release_age_days_never_reports_a_negative_age() {
        // A clock behind the release date (skew, or a nightly built on a machine ahead of this
        // one) must read as "not stale", not as a huge or negative number.
        let today = NaiveDate::from_ymd_opt(2026, 7, 16).unwrap();

        assert_eq!(release_age_days("2026.08.01", today), Some(0));
    }

    #[test]
    fn ffmpeg_location_argument_returns_bare_name_unchanged() {
        assert_eq!(ffmpeg_location_argument("ffmpeg"), "ffmpeg");
        assert_eq!(ffmpeg_location_argument("ffmpeg.exe"), "ffmpeg.exe");
    }

    #[test]
    fn ffmpeg_location_argument_returns_parent_directory_for_full_path() {
        let bin_dir = std::env::temp_dir().join("kavynex-ffmpeg-bin");
        let ffmpeg = bin_dir.join("ffmpeg");

        let result = ffmpeg_location_argument(ffmpeg.to_str().unwrap());

        assert_eq!(result, bin_dir.to_string_lossy());
    }
}
