use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::services::database::{get_app_settings_from_pool, shared_pool};
use crate::services::live_chat_storage::{
    compress_existing_live_chat_files, list_live_chat_relative_paths, migrate_live_chat_files,
    read_live_chat_text,
};
use crate::utils::path::absolute_path_from_relative;
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

/// Resolves the configured library directory from settings. Live chat files live under it
/// (in `live_chat/`), alongside media and thumbnails, so the base is never taken from the
/// caller - a compromised frontend cannot redirect reads/writes to an arbitrary location.
async fn configured_library_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let pool = shared_pool(app).await?;
    let settings = get_app_settings_from_pool(pool).await?;

    let library_path = settings
        .library_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::from_code(
                AppErrorCode::InvalidLibraryPath,
                "no library folder is configured",
            )
        })?;

    Ok(PathBuf::from(library_path))
}

/// Reads a live chat replay file from the library and returns its JSON text (gunzipped).
#[tauri::command]
pub async fn read_live_chat_file(app: AppHandle, relative_path: String) -> AppResult<String> {
    let library_dir = configured_library_dir(&app).await?;

    run_blocking(move || {
        let absolute = absolute_path_from_relative(&library_dir, &relative_path)?;
        read_live_chat_text(&absolute)
    })
    .await
}

/// Deletes a live chat replay file from the library, if it exists.
#[tauri::command]
pub async fn delete_live_chat_file(app: AppHandle, relative_path: String) -> AppResult<()> {
    let library_dir = configured_library_dir(&app).await?;

    run_blocking(move || {
        let absolute = absolute_path_from_relative(&library_dir, &relative_path)?;

        if absolute.exists() {
            std::fs::remove_file(&absolute).map_err(|e| {
                AppError::from_code(
                    AppErrorCode::RemoveMediaFailed,
                    format!("failed to remove live chat file: {e}"),
                )
            })?;
        }

        Ok(())
    })
    .await
}

/// Lists stored live chat files as library-relative paths, for diagnostics.
#[tauri::command]
pub async fn list_live_chat_files(app: AppHandle) -> AppResult<Vec<String>> {
    let library_dir = configured_library_dir(&app).await?;
    run_blocking(move || list_live_chat_relative_paths(&library_dir)).await
}

/// Moves any live chat files still in the old app-data location into the library and
/// compresses legacy uncompressed files. Idempotent, so it is safe to call on every startup
/// once the library path is known.
#[tauri::command]
pub async fn migrate_live_chat_to_library(app: AppHandle) -> AppResult<()> {
    let library_dir = configured_library_dir(&app).await?;

    let app_data_dir = app.path().app_data_dir().map_err(|e| {
        AppError::from_code(
            AppErrorCode::DataDirectoryResolveFailed,
            format!("failed to resolve app data directory: {e}"),
        )
    })?;

    run_blocking(move || {
        migrate_live_chat_files(&app_data_dir, &library_dir)?;
        compress_existing_live_chat_files(&library_dir.join("live_chat"))?;
        Ok(())
    })
    .await
}
