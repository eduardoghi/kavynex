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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_ipc::{invoke, memory_db};
    use crate::services::database::Db;
    use crate::AppErrorCode;
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::Manager;

    // replace_media_comments now takes State<Db>, so it runs under the mock runtime. The channel
    // and media inserts are registered too so a real video row exists (foreign key) before
    // comments are replaced for it.
    fn test_webview(db: Db) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                crate::commands::channels::insert_channel,
                crate::commands::videos::insert_media,
                replace_media_comments
            ])
            .build(mock_context(noop_assets()))
            .unwrap();

        app.manage(db);

        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap()
    }

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

        invoke(
            webview,
            "insert_media",
            serde_json::json!({
                "channelId": channel_id,
                "title": "Video",
                "filePath": "video/media_x.mp4",
                "thumbnailPath": null,
                "mediaType": "video",
                "youtubeVideoId": null,
                "publishedAt": null,
                "durationSeconds": null,
                "isLive": false,
                "liveChatFilePath": null
            }),
        )
        .unwrap()
        .deserialize::<Option<i64>>()
        .unwrap()
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
