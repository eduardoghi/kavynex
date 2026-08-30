use tauri::{AppHandle, Runtime};

use crate::models::yt_dlp::{ExternalToolsStatus, YtDlpComment, YtDlpFormatsResult};
use crate::services::binaries::resolve_external_tools_status_async;
use crate::services::yt_dlp;
use crate::AppResult;

#[tauri::command]
pub async fn list_yt_dlp_formats<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    cookies_browser: Option<String>,
    cookies_path: Option<String>,
    run_id: Option<String>,
) -> AppResult<YtDlpFormatsResult> {
    yt_dlp::list_yt_dlp_formats_async(
        &app,
        &url,
        cookies_browser.as_deref(),
        cookies_path.as_deref(),
        run_id.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn fetch_youtube_comments<R: Runtime>(
    app: AppHandle<R>,
    video_id: String,
    cookies_browser: Option<String>,
    cookies_path: Option<String>,
    run_id: Option<String>,
) -> AppResult<Vec<YtDlpComment>> {
    yt_dlp::fetch_youtube_comments_async(
        &app,
        &video_id,
        cookies_browser.as_deref(),
        cookies_path.as_deref(),
        run_id.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn cancel_media_download(run_id: String) -> AppResult<()> {
    yt_dlp::cancel_media_download(&run_id)
}

#[tauri::command]
pub async fn check_external_tools<R: Runtime>(app: AppHandle<R>) -> AppResult<ExternalToolsStatus> {
    resolve_external_tools_status_async(&app).await
}

// `list_yt_dlp_formats`, `fetch_youtube_comments` and `check_external_tools` are generic over
// `R: Runtime` like every other command now, so the mock-runtime harness *can* register them. What
// keeps them out of an IPC test is what they do, not their signature. Each resolves and spawns the
// real yt-dlp (and ffmpeg) binary, which a deterministic, offline test must not depend on. The
// URL/video-id validation they perform before ever spawning (host allow-list, empty or malformed id)
// is covered directly at the service layer in `services/yt_dlp/url.rs` and `metadata.rs`.
// `cancel_media_download(run_id: String)` touches no binary and is exercised over IPC below.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_ipc::invoke;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    fn test_webview() -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![cancel_media_download])
            .build(mock_context(noop_assets()))
            .unwrap();

        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap()
    }

    #[test]
    fn cancel_media_download_command_rejects_unknown_run_id_over_ipc() {
        let webview = test_webview();

        let error = invoke(
            &webview,
            "cancel_media_download",
            serde_json::json!({ "runId": "kavynex-test-unknown-run-id" }),
        )
        .unwrap_err();

        assert_eq!(error["code"], "INVALID_RUN_ID");
    }

    #[test]
    fn cancel_media_download_command_rejects_empty_run_id_over_ipc() {
        let webview = test_webview();

        let error = invoke(
            &webview,
            "cancel_media_download",
            serde_json::json!({ "runId": "   " }),
        )
        .unwrap_err();

        assert_eq!(error["code"], "INVALID_RUN_ID");
    }
}
