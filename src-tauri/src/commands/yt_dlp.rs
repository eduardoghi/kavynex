use tauri::AppHandle;

use crate::models::yt_dlp::{
    DownloadedMediaResult, ExternalToolsStatus, YtDlpComment, YtDlpFormatsResult,
};
use crate::services::binaries::resolve_external_tools_status_async;
use crate::services::library_guard::ensure_configured_library_path;
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
    ensure_configured_library_path(&app, &library_path).await?;

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
    yt_dlp::cancel_media_download_async(&run_id)
}

#[tauri::command]
pub async fn check_external_tools(app: AppHandle) -> AppResult<ExternalToolsStatus> {
    resolve_external_tools_status_async(&app).await
}

// `list_yt_dlp_formats`, `fetch_youtube_comments`, `download_media_from_url` and
// `check_external_tools` all take an `app: AppHandle` parameter. `AppHandle` resolves
// (via its default generic parameter) to the concrete type `AppHandle<tauri::Wry>` - the
// real runtime - while `tauri::test::mock_builder()` builds an
// `App<tauri::test::MockRuntime>`, a different concrete runtime. Registering any of
// those commands with `tauri::generate_handler!` for a mock app therefore fails to
// *compile*: there is no `CommandArg<'_, MockRuntime>` impl for `AppHandle<Wry>`. (This
// mirrors `commands/media.rs`: see the comment above its test module.) That leaves
// `cancel_media_download(run_id: String)` as the only command in this file that can be
// driven through a real IPC round trip with this harness, exercised below.
//
// The URL/video-id validation those other commands perform before ever spawning yt-dlp
// (host allow-list, empty/malformed id) is already covered directly at the service layer
// in `services/yt_dlp_url.rs` (`is_allowed_youtube_url` tests). None of the yt-dlp
// commands can be meaningfully tested beyond that without either a real `AppHandle<Wry>`
// (which needs a real webview runtime, unavailable headlessly here) or spawning the
// actual yt-dlp/ffmpeg binaries, which is out of scope for a deterministic, offline test.
#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    fn test_webview() -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![cancel_media_download])
            .build(mock_context(noop_assets()))
            .unwrap();

        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap()
    }

    fn invoke_command(
        webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        cmd: &str,
        body: serde_json::Value,
    ) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
        get_ipc_response(
            webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: if cfg!(any(windows, target_os = "android")) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
    }

    #[test]
    fn cancel_media_download_command_rejects_unknown_run_id_over_ipc() {
        let webview = test_webview();

        let error = invoke_command(
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

        let error = invoke_command(
            &webview,
            "cancel_media_download",
            serde_json::json!({ "runId": "   " }),
        )
        .unwrap_err();

        assert_eq!(error["code"], "INVALID_RUN_ID");
    }
}
