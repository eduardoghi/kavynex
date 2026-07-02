use tauri::AppHandle;

use crate::services::channel_repository as repo;
use crate::services::channel_repository::ChannelRow;
use crate::services::database::shared_pool;
use crate::AppResult;

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
pub async fn delete_channel_by_id(app: AppHandle, channel_id: i64) -> AppResult<()> {
    let pool = shared_pool(&app).await?;
    repo::delete_channel_by_id(pool, channel_id).await
}

#[tauri::command]
pub async fn list_distinct_thumbnail_paths_by_channel_id(
    app: AppHandle,
    channel_id: i64,
) -> AppResult<Vec<String>> {
    let pool = shared_pool(&app).await?;
    repo::list_distinct_thumbnail_paths_by_channel_id(pool, channel_id).await
}

#[tauri::command]
pub async fn list_distinct_file_paths_by_channel_id(
    app: AppHandle,
    channel_id: i64,
) -> AppResult<Vec<String>> {
    let pool = shared_pool(&app).await?;
    repo::list_distinct_file_paths_by_channel_id(pool, channel_id).await
}

#[tauri::command]
pub async fn get_channel_avatar_path_by_channel_id(
    app: AppHandle,
    channel_id: i64,
) -> AppResult<Option<String>> {
    let pool = shared_pool(&app).await?;
    repo::get_channel_avatar_path_by_channel_id(pool, channel_id).await
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

#[tauri::command]
pub async fn count_media_using_thumbnail_outside_channel(
    app: AppHandle,
    thumbnail_path: String,
    channel_id: i64,
) -> AppResult<i64> {
    let pool = shared_pool(&app).await?;
    repo::count_media_using_thumbnail_outside_channel(pool, &thumbnail_path, channel_id).await
}

#[tauri::command]
pub async fn count_media_using_file_path_outside_channel(
    app: AppHandle,
    file_path: String,
    channel_id: i64,
) -> AppResult<i64> {
    let pool = shared_pool(&app).await?;
    repo::count_media_using_file_path_outside_channel(pool, &file_path, channel_id).await
}
