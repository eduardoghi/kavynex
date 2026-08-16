use tauri::State;

use crate::models::yt_dlp::YtDlpComment;
use crate::services::database::Db;
use crate::services::media_comments;
use crate::AppResult;

#[tauri::command]
pub async fn replace_media_comments(
    db: State<'_, Db>,
    media_id: i64,
    comments: Vec<YtDlpComment>,
) -> AppResult<u64> {
    let pool = db.pool().await?;
    media_comments::replace_media_comments(&pool, media_id, comments).await
}

/// Records that a comment fetch for this media found nothing, leaving any comments already stored
/// untouched.
///
/// Its own command rather than an empty `replace_media_comments`, because that one deletes before
/// it inserts: calling it with nothing would wipe a saved backup on the strength of a later fetch
/// coming back empty. See `media_comments::mark_media_comments_absent`.
#[tauri::command]
pub async fn mark_media_comments_absent(db: State<'_, Db>, media_id: i64) -> AppResult<()> {
    let pool = db.pool().await?;
    media_comments::mark_media_comments_absent(&pool, media_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_ipc::{invoke, memory_db};
    use crate::services::database::Db;
    use crate::AppErrorCode;
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::Manager;

    // replace_media_comments now takes State<Db>, so it runs under the mock runtime. insert_channel
    // is registered too so a real channel row exists before the media row that references it.
    fn test_webview(db: Db) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                crate::commands::channels::insert_channel,
                replace_media_comments
            ])
            .build(mock_context(noop_assets()))
            .unwrap();

        app.manage(db);

        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap()
    }

    /// Seeds the video row these tests attach comments to.
    ///
    /// The media row goes in through the repository rather than through an `insert_media` command,
    /// which no longer exists: a media is created by `create_media`, and the individual steps are
    /// not on the IPC surface. What this test needs is the row, not a particular way of producing it.
    fn seed_media(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>) -> i64 {
        let channel_id = invoke(
            webview,
            "insert_channel",
            serde_json::json!({ "name": "Chan", "youtubeHandle": "@chan", "avatarPath": null }),
        )
        .unwrap()
        .deserialize::<Option<i64>>()
        .unwrap()
        .expect("channel id");

        let pool = tauri::async_runtime::block_on(webview.state::<Db>().pool())
            .expect("the managed pool must open");

        tauri::async_runtime::block_on(crate::services::video_repository::insert_media(
            &pool,
            channel_id,
            "Video",
            "video/media_x.mp4",
            None,
            "video",
            None,
            None,
            None,
            false,
            None,
        ))
        .expect("media id")
    }

    #[test]
    fn replace_media_comments_rejects_a_non_positive_media_id_over_ipc() {
        let webview = test_webview(memory_db());

        let error = invoke(
            &webview,
            "replace_media_comments",
            serde_json::json!({ "mediaId": 0, "comments": [] }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidInput.as_str());
    }

    #[test]
    fn replace_media_comments_inserts_comments_for_a_media_row_over_ipc() {
        let webview = test_webview(memory_db());
        let media_id = seed_media(&webview);

        // YtDlpComment fields are snake_case over IPC (no serde rename on the struct); this
        // exercises the Vec<YtDlpComment> deserialization across the boundary end to end.
        let inserted = invoke(
            &webview,
            "replace_media_comments",
            serde_json::json!({
                "mediaId": media_id,
                "comments": [{
                    "comment_id": "c1",
                    "parent_comment_id": null,
                    "author_name": "Alice",
                    "author_handle": "@alice",
                    "author_channel_id": null,
                    "author_thumbnail": null,
                    "text": "Great video!",
                    "like_count": 5,
                    "reply_count": 1,
                    "is_author_uploader": false,
                    "is_favorited": false,
                    "is_pinned": true,
                    "is_edited": false,
                    "time_text": "1 day ago",
                    "published_at": "2026-01-01"
                }]
            }),
        )
        .unwrap()
        .deserialize::<u64>()
        .unwrap();

        assert_eq!(inserted, 1, "one non-blank comment should be inserted");
    }
}
