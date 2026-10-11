use tauri::{AppHandle, Runtime, State};

use crate::services::chosen_files::{self, ChosenFile};
use crate::services::database::Db;
use crate::services::media_comments::{self, MediaCommentsFetch};
use crate::services::yt_dlp;
use crate::{AppError, AppErrorCode, AppResult};

/// Fetches a media's comments with yt-dlp and merges them into the ones already stored, in one
/// command. The renderer gets the two counts back and never the comments.
///
/// `run_id` registers the fetch so `cancel_media_download` can stop it. A cancelled or failed fetch
/// stores nothing and records nothing, so a rate limit is never mistaken for a video with no
/// comments.
#[tauri::command]
pub async fn fetch_media_comments<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Db>,
    media_id: i64,
    video_id: String,
    cookies_browser: Option<String>,
    cookies_path: Option<String>,
    run_id: Option<String>,
) -> AppResult<MediaCommentsFetch> {
    // Checked before yt-dlp is started, so a bad id does not cost a fetch of several minutes that
    // the merge would then refuse.
    if media_id <= 0 {
        return Err(AppError::from_code(
            AppErrorCode::InvalidInput,
            "media id must be a positive number",
        ));
    }

    chosen_files::ensure_chosen_if_present(ChosenFile::Source, cookies_path.as_deref())?;

    // The video whose comments are fetched has to be the one the row names. Taken from the renderer
    // as it was, a stale or wrong id merged another video's comments into this media's backup.
    let pool = db.pool().await?;
    ensure_video_belongs_to_media(&pool, media_id, &video_id).await?;

    let comments = yt_dlp::fetch_youtube_comments_async(
        &app,
        &video_id,
        cookies_browser.as_deref(),
        cookies_path.as_deref(),
        run_id.as_deref(),
    )
    .await?;

    media_comments::store_fetched_comments(&pool, media_id, comments).await
}

/// Refuses `video_id` unless it is the YouTube video id stored for `media_id`.
async fn ensure_video_belongs_to_media(
    pool: &sqlx::SqlitePool,
    media_id: i64,
    video_id: &str,
) -> AppResult<()> {
    let stored: Option<Option<String>> =
        sqlx::query_scalar("SELECT youtube_video_id FROM videos WHERE id = ?")
            .bind(media_id)
            .fetch_optional(pool)
            .await
            .map_err(|error| {
                crate::services::database::db_error("failed to read the media's video id", error)
            })?;

    let Some(stored) = stored else {
        return Err(AppError::from_code(
            AppErrorCode::MediaNotFound,
            "the media no longer exists",
        ));
    };

    if stored.as_deref().map(str::trim) != Some(video_id.trim()) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidYoutubeVideoId,
            "the video id does not belong to this media",
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_ipc::{invoke, memory_db};
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::Manager;

    // Only the checks that run before yt-dlp is started are reachable here. A deterministic,
    // offline test must not spawn the real binary (see commands/yt_dlp.rs). The merge itself is
    // covered by `media_comments::store_fetched_comments`.
    fn test_webview(db: Db) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![fetch_media_comments])
            .build(mock_context(noop_assets()))
            .unwrap();

        app.manage(db);

        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn a_video_id_another_media_owns_is_refused_before_fetching() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::services::db_schema::ensure_schema(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO channels (id, name, youtube_handle) VALUES (1, 'C', '@c')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO videos (id, channel_id, title, title_normalized, file_path, media_type, \
             youtube_video_id) VALUES (7, 1, 'T', 't', 'video/a.mp4', 'video', 'dQw4w9WgXcQ')",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(ensure_video_belongs_to_media(&pool, 7, "dQw4w9WgXcQ")
            .await
            .is_ok());

        let wrong = ensure_video_belongs_to_media(&pool, 7, "jNQXAC9IVRw")
            .await
            .unwrap_err();
        assert_eq!(wrong.code, AppErrorCode::InvalidYoutubeVideoId.as_str());

        let gone = ensure_video_belongs_to_media(&pool, 8, "dQw4w9WgXcQ")
            .await
            .unwrap_err();
        assert_eq!(gone.code, AppErrorCode::MediaNotFound.as_str());
    }

    #[test]
    fn fetch_media_comments_rejects_a_non_positive_media_id_before_fetching() {
        let webview = test_webview(memory_db());

        let error = invoke(
            &webview,
            "fetch_media_comments",
            serde_json::json!({ "mediaId": 0, "videoId": "dQw4w9WgXcQ" }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidInput.as_str());
    }

    #[test]
    fn fetch_media_comments_refuses_a_cookies_file_the_user_did_not_pick() {
        let webview = test_webview(memory_db());

        let error = invoke(
            &webview,
            "fetch_media_comments",
            serde_json::json!({
                "mediaId": 1,
                "videoId": "dQw4w9WgXcQ",
                "cookiesPath": "C:/Users/someone/cookies.txt"
            }),
        )
        .unwrap_err();

        // The media id is valid, so this refusal is the cookies check. Reaching yt-dlp would have
        // failed with a binary or network error instead.
        assert_eq!(error["code"], AppErrorCode::InvalidInput.as_str());
    }
}
