use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{AppHandle, Manager};

use crate::models::yt_dlp::{ExternalToolHealth, ExternalToolsStatus};
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

#[cfg(windows)]
fn resolve_from_path(candidates: &[&str]) -> Option<String> {
    for candidate in candidates {
        let output = Command::new("where.exe").arg(candidate).output().ok()?;

        if !output.status.success() {
            continue;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);

        if let Some(found) = stdout.lines().map(str::trim).find(|line| !line.is_empty()) {
            let path = PathBuf::from(found);

            if is_executable_file(&path) {
                return Some(found.to_string());
            }
        }
    }

    None
}

#[cfg(not(windows))]
fn resolve_from_path(candidates: &[&str]) -> Option<String> {
    for candidate in candidates {
        let output = Command::new("which").arg(candidate).output().ok()?;

        if !output.status.success() {
            continue;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);

        if let Some(found) = stdout.lines().map(str::trim).find(|line| !line.is_empty()) {
            let path = PathBuf::from(found);

            if is_executable_file(&path) {
                return Some(found.to_string());
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

fn run_command_and_capture_first_line(
    binary_path: &str,
    args: &[&str],
    error_code: AppErrorCode,
    default_message: &str,
) -> AppResult<String> {
    let output = Command::new(binary_path).args(args).output().map_err(|e| {
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

    Ok(ExternalToolsStatus {
        yt_dlp: ExternalToolHealth {
            path: yt_dlp_path,
            version: yt_dlp_version,
            healthy: true,
        },
        ffmpeg: ExternalToolHealth {
            path: ffmpeg_path,
            version: ffmpeg_version,
            healthy: true,
        },
    })
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
