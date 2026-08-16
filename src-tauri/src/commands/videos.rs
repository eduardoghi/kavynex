use tauri::{AppHandle, State};

use crate::services::database::Db;
use crate::services::library;
use crate::services::library::cleanup::ArtifactCleanupReport;
use crate::services::video_repository as repo;
use crate::services::video_repository::{
    MediaCommentRow, MediaPage, MediaPageQuery, MediaRepositoryStats,
};
use crate::utils::validation::ensure_valid_media_title;
use crate::AppResult;

/// Deletes a media row and its now-unreferenced files (media file, thumbnail, live chat)
/// in a single atomic operation.
#[tauri::command]
pub async fn delete_media_with_artifacts(
    app: AppHandle,
    media_id: i64,
) -> AppResult<ArtifactCleanupReport> {
    library::cleanup::delete_media_with_artifacts(&app, media_id).await
}

#[tauri::command]
pub async fn update_media_title(db: State<'_, Db>, media_id: i64, title: String) -> AppResult<()> {
    ensure_valid_media_title(&title)?;

    // Store the trimmed title: validation checks the trimmed form, so persist that rather than a
    // padded value.
    let title = title.trim();

    let pool = db.pool().await?;
    repo::update_media_title(&pool, media_id, title).await
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

/// Records the duration the renderer measured for a media that has already been created.
///
/// The probe runs after `create_media` returns, not inside it: it decodes the file through a media
/// element, which is a capability the webview has and the backend would have to re-implement over
/// FFmpeg to match. Keeping it outside also keeps it off the creation's critical path. It used to
/// sit between the crash marker and the insert, where a source that never fired `loadedmetadata` nor
/// `error` would hang the whole creation with the marker on disk.
///
/// A negative or absurd value is refused rather than stored: it arrives over IPC, and a duration is
/// only ever a count of seconds.
#[tauri::command]
pub async fn update_media_duration(
    db: State<'_, Db>,
    media_id: i64,
    duration_seconds: Option<i64>,
) -> AppResult<()> {
    // A media element reports a non-finite or non-positive duration for a file it could not read,
    // which the renderer already maps to "unknown"; normalizing the same way here means the column
    // holds either a real measurement or nothing, never a zero that renders as "0:00".
    let duration_seconds = duration_seconds.filter(|seconds| *seconds > 0);

    let pool = db.pool().await?;
    repo::update_media_duration(&pool, media_id, duration_seconds).await
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

// `list_media_integrity_references` is deliberately not a command. It existed so the renderer
// could assemble the path lists `check_library_integrity` used to take, and that resolution moved
// into that command, which holds the same pool and is the only caller. Re-exposing it would put
// every stored path back on the IPC surface for a step rather than an operation, which is the rule
// `create_media` established when the creation sequence stopped being seven calls.

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
                update_media_title,
                list_media_page,
                mark_media_as_watched,
                mark_media_as_unwatched,
                update_media_progress,
                list_media_comments_by_media_id,
                get_media_repository_stats
            ])
            .build(mock_context(noop_assets()))
            .unwrap();

        app.manage(db);

        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap()
    }

    /// The pool the mock app manages, for seeding rows the commands under test then read.
    ///
    /// These tests used to seed through the `insert_media` command, which is what kept that command
    /// registered long after `create_media` had made it dead IPC surface. Seeding through the
    /// repository instead is what let it be removed: the row is what these tests need, and how it got
    /// there is not what any of them is about.
    fn seed_pool(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>) -> sqlx::SqlitePool {
        let db = webview.state::<Db>();
        tauri::async_runtime::block_on(db.pool()).expect("the managed pool must open")
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

    fn insert_media_row(
        webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        channel_id: i64,
        file_path: &str,
    ) -> i64 {
        let pool = seed_pool(webview);

        tauri::async_runtime::block_on(repo::insert_media(
            &pool, channel_id, "Video", file_path, None, "video", None, None, None, false, None,
        ))
        .expect("media id")
    }

    fn first_media_item(
        webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        channel_id: i64,
    ) -> serde_json::Value {
        let page = invoke(
            webview,
            "list_media_page",
            serde_json::json!({ "channelId": channel_id, "query": default_media_page_query() }),
        )
        .unwrap()
        .deserialize::<serde_json::Value>()
        .unwrap();

        page["items"].as_array().unwrap()[0].clone()
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
    fn paging_media_round_trips_through_ipc() {
        let webview = test_webview(memory_db());
        let channel_id = seed_channel(&webview);
        insert_media_row(&webview, channel_id, "video/media_x.mp4");

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

    // The five tests that pinned `insert_media`'s validation over IPC moved with that validation,
    // into `services::video_repository`'s own test module: the trimmed and blank youtube id, the
    // unmanaged file path, the empty title and the invalid media type. They assert the same
    // behaviors against the function that now performs them, which is also the one every caller
    // reaches. The command layer was never the only way in, it was just the only one being tested.

    #[test]
    fn update_media_title_rejects_an_empty_title_over_ipc() {
        let webview = test_webview(memory_db());
        let channel_id = seed_channel(&webview);
        let media_id = insert_media_row(&webview, channel_id, "video/media_x.mp4");

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
        let media_id = insert_media_row(&webview, channel_id, "video/media_x.mp4");

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

    #[test]
    fn list_media_comments_by_media_id_is_empty_for_a_fresh_media_over_ipc() {
        let webview = test_webview(memory_db());
        let channel_id = seed_channel(&webview);
        let media_id = insert_media_row(&webview, channel_id, "video/media_x.mp4");

        let comments = invoke(
            &webview,
            "list_media_comments_by_media_id",
            serde_json::json!({ "mediaId": media_id }),
        )
        .unwrap()
        .deserialize::<serde_json::Value>()
        .unwrap();

        assert_eq!(comments.as_array().unwrap().len(), 0);
    }

    #[test]
    fn mark_media_as_unwatched_clears_the_watched_timestamp_over_ipc() {
        let webview = test_webview(memory_db());
        let channel_id = seed_channel(&webview);
        let media_id = insert_media_row(&webview, channel_id, "video/media_x.mp4");

        invoke(
            &webview,
            "mark_media_as_watched",
            serde_json::json!({ "mediaId": media_id }),
        )
        .unwrap();
        assert!(!first_media_item(&webview, channel_id)["watched_at"].is_null());

        invoke(
            &webview,
            "mark_media_as_unwatched",
            serde_json::json!({ "mediaId": media_id }),
        )
        .unwrap();
        assert!(first_media_item(&webview, channel_id)["watched_at"].is_null());
    }

    #[test]
    fn update_media_progress_persists_the_position_over_ipc() {
        let webview = test_webview(memory_db());
        let channel_id = seed_channel(&webview);
        let media_id = insert_media_row(&webview, channel_id, "video/media_x.mp4");

        invoke(
            &webview,
            "update_media_progress",
            serde_json::json!({ "mediaId": media_id, "progressSeconds": 87 }),
        )
        .unwrap();

        assert_eq!(
            first_media_item(&webview, channel_id)["progress_seconds"],
            87
        );
    }

    #[test]
    fn get_media_repository_stats_counts_inserted_media_over_ipc() {
        let webview = test_webview(memory_db());
        let channel_id = seed_channel(&webview);
        insert_media_row(&webview, channel_id, "video/media_a.mp4");
        insert_media_row(&webview, channel_id, "video/media_b.mp4");

        let stats = invoke(
            &webview,
            "get_media_repository_stats",
            serde_json::json!({}),
        )
        .unwrap()
        .deserialize::<serde_json::Value>()
        .unwrap();

        assert_eq!(stats["total_media"], 2);
        assert_eq!(stats["total_video_media"], 2);
        assert_eq!(stats["total_audio_media"], 0);
    }

    // The IPC test for `list_media_integrity_references` went with the command. What it asserted
    // (that the query returns the stored paths and the channel each belongs to) is covered by
    // `services::video_repository`'s own test, which drives the function directly, and the shape
    // the integrity check needs out of it is pinned in `library::integrity`.
}
