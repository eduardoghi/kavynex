use tauri::{AppHandle, State};

use crate::services::channel_repository as repo;
use crate::services::channel_repository::ChannelRow;
use crate::services::database::Db;
use crate::services::library_cleanup::{self, ArtifactCleanupReport};
use crate::utils::path::ensure_managed_library_relative_path;
use crate::utils::validation::{ensure_valid_channel_name, ensure_valid_youtube_handle};
use crate::AppResult;

/// Deletes a channel row (its media and comments cascade) and the now-unreferenced files
/// of its media (media files, thumbnails, avatar, live chat) in a single atomic operation.
#[tauri::command]
pub async fn delete_channel_with_artifacts(
    app: AppHandle,
    channel_id: i64,
) -> AppResult<ArtifactCleanupReport> {
    library_cleanup::delete_channel_with_artifacts(&app, channel_id).await
}

#[tauri::command]
pub async fn list_channels(db: State<'_, Db>) -> AppResult<Vec<ChannelRow>> {
    let pool = db.pool().await?;
    repo::list_channels(&pool).await
}

#[tauri::command]
pub async fn find_channel_by_youtube_handle(
    db: State<'_, Db>,
    youtube_handle: String,
) -> AppResult<Option<ChannelRow>> {
    let pool = db.pool().await?;
    repo::find_channel_by_youtube_handle(&pool, &youtube_handle).await
}

#[tauri::command]
pub async fn get_channel_by_id(
    db: State<'_, Db>,
    channel_id: i64,
) -> AppResult<Option<ChannelRow>> {
    let pool = db.pool().await?;
    repo::get_channel_by_id(&pool, channel_id).await
}

#[tauri::command]
pub async fn insert_channel(
    db: State<'_, Db>,
    name: String,
    youtube_handle: String,
    avatar_path: Option<String>,
) -> AppResult<i64> {
    // Validate the text fields at this write boundary, not just in the frontend: the backend is
    // the only durable trust boundary, so a malformed name/handle from any other call path is
    // rejected here with a catalogued error before it reaches the row.
    ensure_valid_channel_name(&name)?;
    ensure_valid_youtube_handle(&youtube_handle)?;

    if let Some(path) = avatar_path.as_deref() {
        ensure_managed_library_relative_path(path)?;
    }

    let pool = db.pool().await?;
    repo::insert_channel(&pool, &name, &youtube_handle, avatar_path.as_deref()).await
}

#[tauri::command]
pub async fn update_channel_name_and_handle(
    db: State<'_, Db>,
    channel_id: i64,
    name: String,
    youtube_handle: String,
) -> AppResult<()> {
    ensure_valid_channel_name(&name)?;
    ensure_valid_youtube_handle(&youtube_handle)?;

    let pool = db.pool().await?;
    repo::update_channel_name_and_handle(&pool, channel_id, &name, &youtube_handle).await
}

/// Updates a channel's avatar and removes the previous avatar file when nothing else (a
/// video thumbnail or another channel avatar) still references it, in a single atomic
/// operation. Files it could not remove are reported back so an orphan stays visible.
#[tauri::command]
pub async fn replace_channel_avatar(
    app: AppHandle,
    channel_id: i64,
    avatar_path: Option<String>,
) -> AppResult<ArtifactCleanupReport> {
    if let Some(path) = avatar_path.as_deref() {
        ensure_managed_library_relative_path(path)?;
    }

    library_cleanup::replace_channel_avatar(&app, channel_id, avatar_path).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_ipc::{invoke, memory_db};
    use crate::AppErrorCode;
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::Manager;

    // The pool-only channel commands take `State<Db>`, so they run under the mock runtime and
    // can be driven through a real IPC round trip against an in-memory database. The two
    // file-cleanup commands still take `AppHandle` and are covered at the service layer.
    fn test_webview(db: Db) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                list_channels,
                find_channel_by_youtube_handle,
                get_channel_by_id,
                insert_channel,
                update_channel_name_and_handle
            ])
            .build(mock_context(noop_assets()))
            .unwrap();

        app.manage(db);

        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap()
    }

    fn insert(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>, name: &str, handle: &str) {
        invoke(
            webview,
            "insert_channel",
            serde_json::json!({ "name": name, "youtubeHandle": handle, "avatarPath": null }),
        )
        .unwrap();
    }

    #[test]
    fn insert_then_list_channels_round_trips_through_ipc() {
        let webview = test_webview(memory_db());

        let id = invoke(
            &webview,
            "insert_channel",
            serde_json::json!({ "name": "Chan", "youtubeHandle": "@chan", "avatarPath": null }),
        )
        .unwrap()
        .deserialize::<Option<i64>>()
        .unwrap();
        assert!(id.is_some(), "insert should return the new row id");

        let channels = invoke(&webview, "list_channels", serde_json::json!({}))
            .unwrap()
            .deserialize::<serde_json::Value>()
            .unwrap();

        let channels = channels.as_array().unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0]["youtube_handle"], "@chan");
        assert_eq!(channels[0]["name"], "Chan");
    }

    #[test]
    fn find_channel_by_youtube_handle_returns_the_inserted_channel_over_ipc() {
        let webview = test_webview(memory_db());
        insert(&webview, "Chan", "@chan");

        let found = invoke(
            &webview,
            "find_channel_by_youtube_handle",
            serde_json::json!({ "youtubeHandle": "@chan" }),
        )
        .unwrap()
        .deserialize::<serde_json::Value>()
        .unwrap();

        assert_eq!(found["youtube_handle"], "@chan");

        // A handle that was never inserted resolves to null, not an error.
        let missing = invoke(
            &webview,
            "find_channel_by_youtube_handle",
            serde_json::json!({ "youtubeHandle": "@nobody" }),
        )
        .unwrap()
        .deserialize::<serde_json::Value>()
        .unwrap();
        assert!(missing.is_null());
    }

    #[test]
    fn insert_channel_rejects_a_duplicate_handle_over_ipc() {
        let webview = test_webview(memory_db());
        insert(&webview, "Chan", "@chan");

        let error = invoke(
            &webview,
            "insert_channel",
            serde_json::json!({ "name": "Other", "youtubeHandle": "@chan", "avatarPath": null }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::ChannelAlreadyExists.as_str());
    }

    #[test]
    fn insert_channel_rejects_an_empty_name_over_ipc() {
        let webview = test_webview(memory_db());

        let error = invoke(
            &webview,
            "insert_channel",
            serde_json::json!({ "name": "   ", "youtubeHandle": "@chan", "avatarPath": null }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidChannelName.as_str());
    }

    #[test]
    fn insert_channel_rejects_a_malformed_handle_over_ipc() {
        let webview = test_webview(memory_db());

        // A non-normalized handle (no `@`, no known prefix) is rejected at the write boundary,
        // not only by the frontend.
        let error = invoke(
            &webview,
            "insert_channel",
            serde_json::json!({ "name": "Chan", "youtubeHandle": "plainname", "avatarPath": null }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidYoutubeHandle.as_str());
    }

    #[test]
    fn insert_channel_rejects_an_unmanaged_avatar_path_over_ipc() {
        let webview = test_webview(memory_db());

        // The managed-path guard runs before the DB write, at the IPC boundary.
        let error = invoke(
            &webview,
            "insert_channel",
            serde_json::json!({
                "name": "Chan",
                "youtubeHandle": "@chan",
                "avatarPath": "contract.docx"
            }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidRelativePath.as_str());
    }
}
