use tauri::AppHandle;

use crate::models::yt_dlp::{
    DownloadedMediaResult, ExternalToolsStatus, YtDlpComment, YtDlpFormatsResult,
};
use crate::services::binaries::resolve_external_tools_status;
use crate::services::yt_dlp;
use crate::AppResult;

#[tauri::command]
pub async fn list_yt_dlp_formats(
    app: AppHandle,
    url: String,
    cookies_browser: Option<String>,
    cookies_path: Option<String>,
) -> AppResult<YtDlpFormatsResult> {
    yt_dlp::list_yt_dlp_formats_async(
        &app,
        &url,
        cookies_browser.as_deref(),
        cookies_path.as_deref(),
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn download_media_from_url(
    app: AppHandle,
    url: String,
    library_path: String,
    run_id: String,
    format_id: String,
    download_live_chat: bool,
    skip_auto_thumbnail_download: bool,
    cookies_browser: Option<String>,
    cookies_path: Option<String>,
) -> AppResult<DownloadedMediaResult> {
    yt_dlp::download_media_from_url_async(
        &app,
        &url,
        &library_path,
        &run_id,
        &format_id,
        download_live_chat,
        skip_auto_thumbnail_download,
        cookies_browser.as_deref(),
        cookies_path.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn fetch_youtube_comments(
    app: AppHandle,
    video_id: String,
    cookies_browser: Option<String>,
    cookies_path: Option<String>,
) -> AppResult<Vec<YtDlpComment>> {
    yt_dlp::fetch_youtube_comments_async(
        &app,
        &video_id,
        cookies_browser.as_deref(),
        cookies_path.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn cancel_media_download(run_id: String) -> AppResult<()> {
    yt_dlp::cancel_media_download_async(&run_id).await
}

#[tauri::command]
pub async fn check_external_tools(app: AppHandle) -> AppResult<ExternalToolsStatus> {
    resolve_external_tools_status(&app)
}
