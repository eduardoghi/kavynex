use tauri::AppHandle;

use crate::models::yt_dlp::ImportMode;
use crate::services::library_cleanup::{self, ArtifactCleanupReport};
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

/// Removes on-disk artifacts (media file, thumbnail, live chat replay) that were prepared for
/// a media creation which never inserted a row, deleting each only when no registered row
/// still references it. The reference count and the unlink happen in one command, so the
/// frontend cannot interleave another operation between them. The library directory is
/// re-derived from the persisted settings, so no untrusted base path is accepted here.
#[tauri::command]
pub async fn cleanup_unreferenced_media_artifacts(
    app: AppHandle,
    file_path: Option<String>,
    thumbnail_path: Option<String>,
    live_chat_file_path: Option<String>,
) -> AppResult<ArtifactCleanupReport> {
    library_cleanup::cleanup_unreferenced_artifacts(
        &app,
        file_path,
        thumbnail_path,
        live_chat_file_path,
    )
    .await
}
