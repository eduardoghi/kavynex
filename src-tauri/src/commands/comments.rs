use tauri::AppHandle;

use crate::models::yt_dlp::YtDlpComment;
use crate::services::media_comments;
use crate::AppResult;

#[tauri::command]
pub async fn replace_media_comments(
    app: AppHandle,
    media_id: i64,
    comments: Vec<YtDlpComment>,
) -> AppResult<u64> {
    media_comments::replace_media_comments(&app, media_id, comments).await
}
