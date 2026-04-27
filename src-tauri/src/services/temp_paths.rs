use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::constants::{TEMP_DIR_THUMBS, TEMP_DIR_YT_DLP, TEMP_DIR_YT_DLP_THUMB};
use crate::{AppError, AppErrorCode, AppResult};

fn ensure_temp_subdir(
    app: &AppHandle,
    dir_name: &str,
    create_error_code: AppErrorCode,
) -> AppResult<PathBuf> {
    let cache_dir = app.path().app_cache_dir().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CacheDirectoryResolveFailed,
            format!("failed to resolve cache directory: {e}"),
        )
    })?;

    fs::create_dir_all(&cache_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CacheDirectoryCreateFailed,
            format!("failed to create cache directory: {e}"),
        )
    })?;

    let dir = cache_dir.join(dir_name);

    fs::create_dir_all(&dir).map_err(|e| {
        AppError::from_code(
            create_error_code,
            format!("failed to create temporary directory: {e}"),
        )
    })?;

    Ok(dir)
}

pub fn thumbs_temp_dir(app: &AppHandle) -> AppResult<PathBuf> {
    ensure_temp_subdir(
        app,
        TEMP_DIR_THUMBS,
        AppErrorCode::CreateTempThumbsDirFailed,
    )
}

pub fn yt_dlp_temp_dir(app: &AppHandle) -> AppResult<PathBuf> {
    ensure_temp_subdir(app, TEMP_DIR_YT_DLP, AppErrorCode::CreateTempRootDirFailed)
}

pub fn yt_dlp_thumb_temp_dir(app: &AppHandle) -> AppResult<PathBuf> {
    ensure_temp_subdir(
        app,
        TEMP_DIR_YT_DLP_THUMB,
        AppErrorCode::CreateTempThumbRootFailed,
    )
}
