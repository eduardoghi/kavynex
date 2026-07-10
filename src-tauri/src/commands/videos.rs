use tauri::AppHandle;

use crate::services::database::shared_pool;
use crate::services::library_cleanup::{self, ArtifactCleanupReport};
use crate::services::video_repository as repo;
use crate::services::video_repository::{
    MediaCommentRow, MediaIntegrityReference, MediaRepositoryStats, MediaRow,
};
use crate::AppResult;

/// Deletes a media row and its now-unreferenced files (media file, thumbnail, live chat)
/// in a single atomic operation.
#[tauri::command]
pub async fn delete_media_with_artifacts(
    app: AppHandle,
    media_id: i64,
) -> AppResult<ArtifactCleanupReport> {
    library_cleanup::delete_media_with_artifacts(&app, media_id).await
}

#[tauri::command]
pub async fn update_media_title(app: AppHandle, media_id: i64, title: String) -> AppResult<()> {
    let pool = shared_pool(&app).await?;
    repo::update_media_title(pool, media_id, &title).await
}

#[tauri::command]
pub async fn list_media_by_channel(app: AppHandle, channel_id: i64) -> AppResult<Vec<MediaRow>> {
    let pool = shared_pool(&app).await?;
    repo::list_media_by_channel(pool, channel_id).await
}

#[tauri::command]
pub async fn find_media_by_channel_and_file_path(
    app: AppHandle,
    channel_id: i64,
    file_path: String,
) -> AppResult<Option<MediaRow>> {
    let pool = shared_pool(&app).await?;
    repo::find_media_by_channel_and_file_path(pool, channel_id, &file_path).await
}

/// Pre-check used by the yt-dlp (URL) add flow before the video is downloaded: lets the
/// frontend fail early with the friendly "already registered" error instead of downloading the
/// whole file only to hit the unique index in `insert_media` afterwards.
#[tauri::command]
pub async fn media_exists_for_channel_and_youtube_id(
    app: AppHandle,
    channel_id: i64,
    youtube_video_id: String,
) -> AppResult<bool> {
    let pool = shared_pool(&app).await?;
    repo::media_exists_for_channel_and_youtube_id(pool, channel_id, &youtube_video_id).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn insert_media(
    app: AppHandle,
    channel_id: i64,
    title: String,
    file_path: String,
    thumbnail_path: Option<String>,
    media_type: String,
    youtube_video_id: Option<String>,
    published_at: Option<String>,
    duration_seconds: Option<i64>,
    is_live: bool,
    live_chat_file_path: Option<String>,
) -> AppResult<Option<i64>> {
    let pool = shared_pool(&app).await?;
    repo::insert_media(
        pool,
        channel_id,
        &title,
        &file_path,
        thumbnail_path.as_deref(),
        &media_type,
        youtube_video_id.as_deref(),
        published_at.as_deref(),
        duration_seconds,
        is_live,
        live_chat_file_path.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn list_media_comments_by_media_id(
    app: AppHandle,
    media_id: i64,
) -> AppResult<Vec<MediaCommentRow>> {
    let pool = shared_pool(&app).await?;
    repo::list_media_comments_by_media_id(pool, media_id).await
}

#[tauri::command]
pub async fn mark_media_as_watched(app: AppHandle, media_id: i64) -> AppResult<()> {
    let pool = shared_pool(&app).await?;
    repo::mark_media_as_watched(pool, media_id).await
}

#[tauri::command]
pub async fn mark_media_as_unwatched(app: AppHandle, media_id: i64) -> AppResult<()> {
    let pool = shared_pool(&app).await?;
    repo::mark_media_as_unwatched(pool, media_id).await
}

#[tauri::command]
pub async fn update_media_progress(
    app: AppHandle,
    media_id: i64,
    progress_seconds: i64,
) -> AppResult<()> {
    let pool = shared_pool(&app).await?;
    repo::update_media_progress(pool, media_id, progress_seconds).await
}

#[tauri::command]
pub async fn get_media_repository_stats(app: AppHandle) -> AppResult<MediaRepositoryStats> {
    let pool = shared_pool(&app).await?;
    repo::get_media_repository_stats(pool).await
}

#[tauri::command]
pub async fn list_media_integrity_references(
    app: AppHandle,
) -> AppResult<Vec<MediaIntegrityReference>> {
    let pool = shared_pool(&app).await?;
    repo::list_media_integrity_references(pool).await
}
