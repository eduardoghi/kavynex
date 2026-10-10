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

    let comments = yt_dlp::fetch_youtube_comments_async(
        &app,
        &video_id,
        cookies_browser.as_deref(),
        cookies_path.as_deref(),
        run_id.as_deref(),
    )
    .await?;

    let pool = db.pool().await?;
    media_comments::store_fetched_comments(&pool, media_id, comments).await
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
