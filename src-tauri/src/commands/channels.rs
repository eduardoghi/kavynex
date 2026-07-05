use tauri::AppHandle;

use crate::services::channel_repository as repo;
use crate::services::channel_repository::ChannelRow;
use crate::services::database::shared_pool;
use crate::services::library_cleanup::{self, ArtifactCleanupReport};
use crate::AppResult;

/// Deletes a channel row (its media and comments cascade) and the now-unreferenced files
/// of its media (media files, thumbnails, avatar, live chat) in a single atomic operation.
#[tauri::command]
pub async fn delete_channel_with_artifacts(
    app: AppHandle,
    channel_id: i64,
) -> AppResult<ArtifactCleanupReport> {
    library_cleanup::delete_channel_with_artifacts(&app, channel_id).await
}

#[tauri::command]
pub async fn list_channels(app: AppHandle) -> AppResult<Vec<ChannelRow>> {
    let pool = shared_pool(&app).await?;
    repo::list_channels(pool).await
}

#[tauri::command]
pub async fn find_channel_by_youtube_handle(
    app: AppHandle,
    youtube_handle: String,
) -> AppResult<Option<ChannelRow>> {
    let pool = shared_pool(&app).await?;
    repo::find_channel_by_youtube_handle(pool, &youtube_handle).await
}

#[tauri::command]
pub async fn get_channel_by_id(app: AppHandle, channel_id: i64) -> AppResult<Option<ChannelRow>> {
    let pool = shared_pool(&app).await?;
    repo::get_channel_by_id(pool, channel_id).await
}

#[tauri::command]
pub async fn insert_channel(
    app: AppHandle,
    name: String,
    youtube_handle: String,
    avatar_path: Option<String>,
) -> AppResult<Option<i64>> {
    let pool = shared_pool(&app).await?;
    repo::insert_channel(pool, &name, &youtube_handle, avatar_path.as_deref()).await
}

#[tauri::command]
pub async fn update_channel_name_and_handle(
    app: AppHandle,
    channel_id: i64,
    name: String,
    youtube_handle: String,
) -> AppResult<()> {
    let pool = shared_pool(&app).await?;
    repo::update_channel_name_and_handle(pool, channel_id, &name, &youtube_handle).await
}

#[tauri::command]
pub async fn update_channel_avatar_path(
    app: AppHandle,
    channel_id: i64,
    avatar_path: Option<String>,
) -> AppResult<()> {
    let pool = shared_pool(&app).await?;
    repo::update_channel_avatar_path(pool, channel_id, avatar_path.as_deref()).await
}

#[tauri::command]
pub async fn count_channels_using_avatar_path_outside_channel(
    app: AppHandle,
    avatar_path: String,
    channel_id: i64,
) -> AppResult<i64> {
    let pool = shared_pool(&app).await?;
    repo::count_channels_using_avatar_path_outside_channel(pool, &avatar_path, channel_id).await
}
