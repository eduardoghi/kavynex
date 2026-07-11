use tauri::AppHandle;

use crate::services::library_guard::{
    ensure_configured_library_path, verify_library_path_then_blocking,
};
use crate::services::thumbnail;
use crate::utils::task::run_blocking;
use crate::AppResult;

#[tauri::command]
pub async fn generate_temporary_thumbnail(app: AppHandle, path: String) -> AppResult<String> {
    run_blocking(move || thumbnail::generate_temporary_thumbnail_sync(&app, &path)).await
}

#[tauri::command]
pub async fn persist_thumbnail_file(
    app: AppHandle,
    path: String,
    library_path: String,
) -> AppResult<String> {
    verify_library_path_then_blocking(&app, library_path, move |library_path| {
        thumbnail::persist_thumbnail_file_sync(&path, &library_path)
    })
    .await
}

#[tauri::command]
pub async fn download_thumbnail_from_url(
    app: AppHandle,
    url: String,
    library_path: String,
) -> AppResult<String> {
    ensure_configured_library_path(&app, &library_path).await?;

    thumbnail::download_thumbnail_from_url_async(&app, &url, &library_path).await
}

#[tauri::command]
pub async fn download_channel_avatar_from_handle(
    app: AppHandle,
    youtube_handle: String,
    library_path: String,
) -> AppResult<String> {
    ensure_configured_library_path(&app, &library_path).await?;

    thumbnail::download_channel_avatar_from_handle_async(&app, &youtube_handle, &library_path).await
}

#[tauri::command]
pub async fn delete_temporary_thumbnail(app: AppHandle, path: String) -> AppResult<()> {
    run_blocking(move || thumbnail::delete_temporary_thumbnail_sync(&app, &path)).await
}

#[tauri::command]
pub async fn delete_thumbnail_file(
    app: AppHandle,
    thumbnail_path: String,
    library_path: String,
) -> AppResult<()> {
    verify_library_path_then_blocking(&app, library_path, move |library_path| {
        thumbnail::delete_thumbnail_file_sync(&thumbnail_path, &library_path)
    })
    .await
}
