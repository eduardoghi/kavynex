use tauri::{AppHandle, State};

use crate::services::database::Db;
use crate::services::library_cleanup::{self, ArtifactCleanupReport};
use crate::services::video_repository as repo;
use crate::services::video_repository::{
    MediaCommentRow, MediaIntegrityReference, MediaPage, MediaPageQuery, MediaRepositoryStats,
    MediaRow,
};
use crate::utils::path::ensure_managed_library_relative_path;
use crate::utils::validation::{ensure_valid_media_title, ensure_valid_media_type};
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
pub async fn update_media_title(db: State<'_, Db>, media_id: i64, title: String) -> AppResult<()> {
    ensure_valid_media_title(&title)?;

    let pool = db.pool().await?;
    repo::update_media_title(&pool, media_id, &title).await
}

/// Returns one filtered, sorted, windowed page of a channel's media (plus the total match
/// count), so the library list can page through large channels instead of loading every row
/// over IPC. Filtering and sorting happen in SQLite; see `repo::list_media_page`.
#[tauri::command]
pub async fn list_media_page(
    db: State<'_, Db>,
    channel_id: i64,
    query: MediaPageQuery,
) -> AppResult<MediaPage> {
    let pool = db.pool().await?;
    repo::list_media_page(&pool, channel_id, &query).await
}

#[tauri::command]
pub async fn find_media_by_channel_and_file_path(
    db: State<'_, Db>,
    channel_id: i64,
    file_path: String,
) -> AppResult<Option<MediaRow>> {
    let pool = db.pool().await?;
    repo::find_media_by_channel_and_file_path(&pool, channel_id, &file_path).await
}

/// Pre-check used by the yt-dlp (URL) add flow before the video is downloaded: lets the
/// frontend fail early with the friendly "already registered" error instead of downloading the
/// whole file only to hit the unique index in `insert_media` afterwards.
#[tauri::command]
pub async fn media_exists_for_channel_and_youtube_id(
    db: State<'_, Db>,
    channel_id: i64,
    youtube_video_id: String,
) -> AppResult<bool> {
    let pool = db.pool().await?;
    repo::media_exists_for_channel_and_youtube_id(&pool, channel_id, &youtube_video_id).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn insert_media(
    db: State<'_, Db>,
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
) -> AppResult<i64> {
    // Validate the text fields at this write boundary too, mirroring the frontend's checks so
    // the backend (the only durable trust boundary) does not depend on them.
    ensure_valid_media_title(&title)?;
    ensure_valid_media_type(&media_type)?;

    // Validate every stored path at this write boundary: each must be a managed,
    // library-relative path (no traversal, rooted at video/audio/thumbnails/live_chat). The
    // deletion path trusts these rows, so a bare or traversing path persisted here would let a
    // later delete/move command act outside the app's own layout.
    ensure_managed_library_relative_path(&file_path)?;

    if let Some(path) = thumbnail_path.as_deref() {
        ensure_managed_library_relative_path(path)?;
    }

    if let Some(path) = live_chat_file_path.as_deref() {
        ensure_managed_library_relative_path(path)?;
    }

    let pool = db.pool().await?;
    repo::insert_media(
        &pool,
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
    db: State<'_, Db>,
    media_id: i64,
) -> AppResult<Vec<MediaCommentRow>> {
    let pool = db.pool().await?;
    repo::list_media_comments_by_media_id(&pool, media_id).await
}

/// Returns the `watched_at` timestamp the database stored, so the frontend can show the exact
/// persisted value rather than a client-generated one.
#[tauri::command]
pub async fn mark_media_as_watched(db: State<'_, Db>, media_id: i64) -> AppResult<String> {
    let pool = db.pool().await?;
    repo::mark_media_as_watched(&pool, media_id).await
}

#[tauri::command]
pub async fn mark_media_as_unwatched(db: State<'_, Db>, media_id: i64) -> AppResult<()> {
    let pool = db.pool().await?;
    repo::mark_media_as_unwatched(&pool, media_id).await
}

#[tauri::command]
pub async fn update_media_progress(
    db: State<'_, Db>,
    media_id: i64,
    progress_seconds: i64,
) -> AppResult<()> {
    let pool = db.pool().await?;
    repo::update_media_progress(&pool, media_id, progress_seconds).await
}

#[tauri::command]
pub async fn get_media_repository_stats(db: State<'_, Db>) -> AppResult<MediaRepositoryStats> {
    let pool = db.pool().await?;
    repo::get_media_repository_stats(&pool).await
}

#[tauri::command]
pub async fn list_media_integrity_references(
    db: State<'_, Db>,
) -> AppResult<Vec<MediaIntegrityReference>> {
    let pool = db.pool().await?;
    repo::list_media_integrity_references(&pool).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_ipc::{invoke, memory_db};
    use crate::AppErrorCode;
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::Manager;

    // The pool-only media commands take `State<Db>`, so they can be driven through a real IPC
    // round trip. insert_channel is registered too (from the channels module) to satisfy the
    // channel_id foreign key before media rows are inserted.
    fn test_webview(db: Db) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                crate::commands::channels::insert_channel,
                insert_media,
                update_media_title,
                list_media_page,
                mark_media_as_watched
            ])
            .build(mock_context(noop_assets()))
            .unwrap();

        app.manage(db);

        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap()
    }

    fn seed_channel(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>) -> i64 {
        invoke(
            webview,
            "insert_channel",
            serde_json::json!({ "name": "Chan", "youtubeHandle": "@chan", "avatarPath": null }),
        )
        .unwrap()
        .deserialize::<Option<i64>>()
        .unwrap()
        .expect("channel id")
    }

    fn insert_media_body(channel_id: i64, file_path: &str) -> serde_json::Value {
        serde_json::json!({
            "channelId": channel_id,
            "title": "Video",
            "filePath": file_path,
            "thumbnailPath": null,
            "mediaType": "video",
            "youtubeVideoId": null,
            "publishedAt": null,
            "durationSeconds": null,
            "isLive": false,
            "liveChatFilePath": null
        })
    }

    fn default_media_page_query() -> serde_json::Value {
        serde_json::json!({
            "mediaType": "all",
            "watched": "all",
            "publication": "all",
            "search": "",
            "sortCategory": "added_date",
            "sortDirection": "desc",
            "limit": 50,
            "offset": 0
        })
    }

    #[test]
    fn insert_and_page_media_round_trips_through_ipc() {
        let webview = test_webview(memory_db());
        let channel_id = seed_channel(&webview);

        let media_id = invoke(
            &webview,
            "insert_media",
            insert_media_body(channel_id, "video/media_x.mp4"),
        )
        .unwrap()
        .deserialize::<Option<i64>>()
        .unwrap();
        assert!(media_id.is_some(), "insert should return the new row id");

        // Read the row back through the real paginated-list command the library uses (there is no
        // separate unpaginated list command); this exercises the MediaPageQuery deserialization and
        // the MediaPage response over a genuine IPC round trip.
        let page = invoke(
            &webview,
            "list_media_page",
            serde_json::json!({ "channelId": channel_id, "query": default_media_page_query() }),
        )
        .unwrap()
        .deserialize::<serde_json::Value>()
        .unwrap();

        assert_eq!(page["total"], 1);
        let items = page["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["file_path"], "video/media_x.mp4");
        assert_eq!(items[0]["title"], "Video");
    }

    #[test]
    fn insert_media_rejects_an_unmanaged_file_path_over_ipc() {
        let webview = test_webview(memory_db());
        let channel_id = seed_channel(&webview);

        // The managed-path guard runs at the IPC boundary before the row is written.
        let error = invoke(
            &webview,
            "insert_media",
            insert_media_body(channel_id, "../escape.mp4"),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidRelativePath.as_str());
    }

    #[test]
    fn insert_media_rejects_an_empty_title_over_ipc() {
        let webview = test_webview(memory_db());
        let channel_id = seed_channel(&webview);

        let mut body = insert_media_body(channel_id, "video/media_x.mp4");
        body["title"] = serde_json::json!("   ");

        let error = invoke(&webview, "insert_media", body).unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidMediaTitle.as_str());
    }

    #[test]
    fn insert_media_rejects_an_invalid_media_type_over_ipc() {
        let webview = test_webview(memory_db());
        let channel_id = seed_channel(&webview);

        let mut body = insert_media_body(channel_id, "video/media_x.mp4");
        body["mediaType"] = serde_json::json!("image");

        let error = invoke(&webview, "insert_media", body).unwrap_err();

        assert_eq!(
            error["code"],
            AppErrorCode::InvalidMediaCreationArguments.as_str()
        );
    }

    #[test]
    fn update_media_title_rejects_an_empty_title_over_ipc() {
        let webview = test_webview(memory_db());
        let channel_id = seed_channel(&webview);

        let media_id = invoke(
            &webview,
            "insert_media",
            insert_media_body(channel_id, "video/media_x.mp4"),
        )
        .unwrap()
        .deserialize::<Option<i64>>()
        .unwrap()
        .expect("media id");

        let error = invoke(
            &webview,
            "update_media_title",
            serde_json::json!({ "mediaId": media_id, "title": "   " }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidMediaTitle.as_str());
    }

    #[test]
    fn mark_media_as_watched_returns_a_persisted_timestamp_over_ipc() {
        let webview = test_webview(memory_db());
        let channel_id = seed_channel(&webview);

        let media_id = invoke(
            &webview,
            "insert_media",
            insert_media_body(channel_id, "video/media_x.mp4"),
        )
        .unwrap()
        .deserialize::<Option<i64>>()
        .unwrap()
        .expect("media id");

        let watched_at = invoke(
            &webview,
            "mark_media_as_watched",
            serde_json::json!({ "mediaId": media_id }),
        )
        .unwrap()
        .deserialize::<String>()
        .unwrap();

        assert!(
            !watched_at.trim().is_empty(),
            "a watched timestamp should be returned"
        );
    }
}
