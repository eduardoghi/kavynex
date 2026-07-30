use tauri::AppHandle;

use crate::services::library::guard::{
    ensure_configured_library_path, verify_library_path_then_blocking,
};
use crate::services::thumbnail;
use crate::services::thumbnail::display::DisplayThumbnail;
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

/// Resolves display-sized copies of a page of the grid's thumbnails, generating the ones that are
/// not cached yet (see `services::thumbnail::display`).
///
/// Each entry answers the corresponding `relative_paths` entry, and "no derivative" is an ordinary
/// answer rather than a failure - the caller renders the stored thumbnail for it, which is what it
/// did before this existed. The command as a whole therefore only fails if the library path itself
/// does not check out.
///
/// The answer distinguishes a miss that is worth asking about again (`budgetSpent`) from one that is
/// final (`unavailable`), because only this side can tell them apart and the caller re-asks about
/// every path it has not settled. See [`DisplayThumbnail`] for what conflating them cost.
///
/// The library path goes through `verify_library_path_then_blocking` like every other library read,
/// so a caller cannot point this at a directory the user has not configured.
#[tauri::command]
pub async fn resolve_display_thumbnails(
    app: AppHandle,
    relative_paths: Vec<String>,
    library_path: String,
) -> AppResult<Vec<DisplayThumbnail>> {
    let app_for_resolve = app.clone();

    verify_library_path_then_blocking(&app, library_path, move |library_path| {
        thumbnail::resolve_display_thumbnails_sync(&app_for_resolve, &library_path, &relative_paths)
    })
    .await
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
