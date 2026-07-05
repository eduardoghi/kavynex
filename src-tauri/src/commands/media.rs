use tauri::AppHandle;

use crate::models::yt_dlp::ImportMode;
use crate::services::library_guard::ensure_configured_library_path;
use crate::services::library_media;
use crate::utils::task::run_blocking;
use crate::AppResult;

#[tauri::command]
pub async fn import_media_file(
    app: AppHandle,
    path: String,
    mode: ImportMode,
    library_path: String,
) -> AppResult<String> {
    ensure_configured_library_path(&app, &library_path).await?;

    run_blocking(move || library_media::import_media_file_sync(&path, mode, &library_path)).await
}

#[tauri::command]
pub async fn delete_media_file(
    app: AppHandle,
    file_path: String,
    library_path: String,
) -> AppResult<()> {
    ensure_configured_library_path(&app, &library_path).await?;

    run_blocking(move || library_media::delete_media_file_sync(&file_path, &library_path)).await
}
