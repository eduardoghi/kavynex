use tauri::{AppHandle, Runtime, State};

use crate::services::channel_repository as repo;
use crate::services::channel_repository::ChannelRow;
use crate::services::database::Db;
use crate::services::library;
use crate::services::library::cleanup::ArtifactCleanupReport;
use crate::services::logger;
use crate::utils::path::{
    ensure_managed_library_relative_path, ensure_relative_path_in_managed_dir,
};
use crate::utils::validation::{ensure_valid_channel_name, ensure_valid_youtube_handle};
use crate::AppResult;

/// Deletes a channel row (its media and comments cascade) and the now-unreferenced files
/// of its media (media files, thumbnails, avatar, live chat) in a single atomic operation.
#[tauri::command]
pub async fn delete_channel_with_artifacts<R: Runtime>(
    app: AppHandle<R>,
    channel_id: i64,
) -> AppResult<ArtifactCleanupReport> {
    library::cleanup::delete_channel_with_artifacts(&app, channel_id).await
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

/// Creates a channel row. When the row cannot be created, removes the avatar file it was handed if
/// nothing else references it.
///
/// The frontend writes the avatar into the library before calling this, so a refusal here (a handle
/// that already exists, a name that fails validation) used to leave that file behind with no row
/// pointing at it. The removal goes through the reference-counted cleanup, so an avatar that is
/// content-addressed onto a file another channel or a media thumbnail already uses is kept.
#[tauri::command]
pub async fn insert_channel<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Db>,
    name: String,
    youtube_handle: String,
    avatar_path: Option<String>,
) -> AppResult<i64> {
    // Only `thumbnails/`, not any managed directory. The cleanup below counts thumbnail and avatar
    // references, not media ones, so an avatar path pointing into `video/` would let a refused
    // insert remove a media file its rows still use.
    if let Some(path) = avatar_path.as_deref() {
        ensure_managed_library_relative_path(path)?;
        ensure_relative_path_in_managed_dir(path, crate::constants::LIBRARY_DIR_THUMBNAILS)?;
    }

    let inserted = insert_channel_row(&db, &name, &youtube_handle, avatar_path.as_deref()).await;

    if inserted.is_err() {
        if let Some(avatar) = avatar_path {
            remove_unused_avatar(&app, avatar).await;
        }
    }

    inserted
}

async fn insert_channel_row(
    db: &Db,
    name: &str,
    youtube_handle: &str,
    avatar_path: Option<&str>,
) -> AppResult<i64> {
    // Validate the text fields at this write boundary, not just in the frontend. The backend is
    // the only durable trust boundary, so a malformed name/handle from any other call path is
    // rejected here with a catalogued error before it reaches the row.
    ensure_valid_channel_name(name)?;
    ensure_valid_youtube_handle(youtube_handle)?;

    // Persist the trimmed values, not the raw arguments. Validation checks the trimmed form, but
    // the UNIQUE index and `find_channel_by_youtube_handle` compare the stored column verbatim, so
    // storing a padded " @handle" would let a whitespace-only duplicate slip past both and hide
    // the channel from its own handle lookup.
    let name = name.trim();
    let youtube_handle = youtube_handle.trim();

    let pool = db.pool().await?;
    repo::insert_channel(&pool, name, youtube_handle, avatar_path).await
}

/// Best effort. The insert error is what the caller needs to see, so a cleanup failure is only
/// logged, and the file is left for Diagnostics to report as an orphan, as before.
async fn remove_unused_avatar<R: Runtime>(app: &AppHandle<R>, avatar: String) {
    match library::cleanup::cleanup_unreferenced_artifacts(app, None, Some(avatar), None).await {
        Ok(report) if !report.failed_paths.is_empty() => logger::warn(
            "channels",
            format!(
                "could not remove the avatar of a channel that was not created: {} file(s) left",
                report.failed_paths.len()
            ),
        ),
        Ok(_) => {}
        Err(error) => logger::warn(
            "channels",
            format!("could not remove the avatar of a channel that was not created: {error}"),
        ),
    }
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

    // Store the trimmed values so the UNIQUE index and handle lookup stay consistent (see
    // insert_channel).
    let name = name.trim();
    let youtube_handle = youtube_handle.trim();

    let pool = db.pool().await?;
    repo::update_channel_name_and_handle(&pool, channel_id, name, youtube_handle).await
}

/// Updates a channel's avatar and removes the previous avatar file when nothing else (a
/// video thumbnail or another channel avatar) still references it, in a single atomic
/// operation. Files it could not remove are reported back so an orphan stays visible.
#[tauri::command]
pub async fn replace_channel_avatar<R: Runtime>(
    app: AppHandle<R>,
    channel_id: i64,
    avatar_path: Option<String>,
) -> AppResult<ArtifactCleanupReport> {
    if let Some(path) = avatar_path.as_deref() {
        ensure_managed_library_relative_path(path)?;
    }

    library::cleanup::replace_channel_avatar(&app, channel_id, avatar_path).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_ipc::{invoke, memory_db};
    use crate::AppErrorCode;
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::Manager;

    // Driven through a real IPC round trip under the mock runtime against an in-memory database.
    // `insert_channel` also takes an `AppHandle` for its avatar cleanup, which the mock runtime
    // provides. The two delete/replace commands are covered at the service layer.
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

    /// A library folder with a `thumbnails/` directory, configured in the settings row of `db`, so
    /// the avatar cleanup has somewhere to look.
    fn configure_library(db: &Db, prefix: &str) -> std::path::PathBuf {
        let library = std::env::temp_dir().join(format!(
            "kavynex-channels-test-{prefix}-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(library.join("thumbnails")).unwrap();

        tauri::async_runtime::block_on(async {
            let pool = db.pool().await.expect("open the in-memory pool");

            crate::services::database::set_app_settings_in_pool(
                &pool,
                &crate::services::database::StoredAppSettings {
                    library_path: Some(library.to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("persist the configured library path");
        });

        library
    }

    #[test]
    fn a_refused_insert_removes_the_avatar_it_was_handed() {
        // The frontend writes the avatar before calling insert_channel. When the insert is refused,
        // here for a handle that already exists, nothing else points at that file.
        let db = memory_db();
        let library = configure_library(&db, "refused-insert");
        let webview = test_webview(db);
        insert(&webview, "Chan", "@chan");

        let avatar = library.join("thumbnails").join("thumb_new.jpg");
        std::fs::write(&avatar, b"img").unwrap();

        let error = invoke(
            &webview,
            "insert_channel",
            serde_json::json!({
                "name": "Other",
                "youtubeHandle": "@chan",
                "avatarPath": "thumbnails/thumb_new.jpg"
            }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::ChannelAlreadyExists.as_str());
        assert!(
            !avatar.exists(),
            "the avatar of a channel that was never created is removed"
        );

        let _ = std::fs::remove_dir_all(&library);
    }

    #[test]
    fn a_refused_insert_keeps_an_avatar_another_channel_uses() {
        // Avatars are content-addressed, so the same image picked for two channels is one file.
        // The refused insert must not take it from the channel that already has it.
        let db = memory_db();
        let library = configure_library(&db, "shared-avatar");
        let webview = test_webview(db);

        let avatar = library.join("thumbnails").join("thumb_shared.jpg");
        std::fs::write(&avatar, b"img").unwrap();

        invoke(
            &webview,
            "insert_channel",
            serde_json::json!({
                "name": "Chan",
                "youtubeHandle": "@chan",
                "avatarPath": "thumbnails/thumb_shared.jpg"
            }),
        )
        .unwrap();

        invoke(
            &webview,
            "insert_channel",
            serde_json::json!({
                "name": "Other",
                "youtubeHandle": "@chan",
                "avatarPath": "thumbnails/thumb_shared.jpg"
            }),
        )
        .unwrap_err();

        assert!(
            avatar.exists(),
            "the first channel still references the file"
        );

        let _ = std::fs::remove_dir_all(&library);
    }

    #[test]
    fn insert_channel_refuses_an_avatar_outside_the_thumbnails_directory() {
        // The cleanup of a refused insert counts thumbnail references only, so an avatar path in
        // `video/` would let it remove a media file its rows still use. It is refused up front.
        let db = memory_db();
        let library = configure_library(&db, "avatar-in-video");
        std::fs::create_dir_all(library.join("video")).unwrap();
        let media = library.join("video").join("media_abc.mp4");
        std::fs::write(&media, b"data").unwrap();
        let webview = test_webview(db);

        let error = invoke(
            &webview,
            "insert_channel",
            serde_json::json!({
                "name": "Chan",
                "youtubeHandle": "@chan",
                "avatarPath": "video/media_abc.mp4"
            }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidRelativePath.as_str());
        assert!(media.exists());

        let _ = std::fs::remove_dir_all(&library);
    }

    #[test]
    fn get_channel_by_id_returns_the_channel_or_null_over_ipc() {
        let webview = test_webview(memory_db());

        let id = invoke(
            &webview,
            "insert_channel",
            serde_json::json!({ "name": "Chan", "youtubeHandle": "@chan", "avatarPath": null }),
        )
        .unwrap()
        .deserialize::<i64>()
        .unwrap();

        let found = invoke(
            &webview,
            "get_channel_by_id",
            serde_json::json!({ "channelId": id }),
        )
        .unwrap()
        .deserialize::<serde_json::Value>()
        .unwrap();

        assert_eq!(found["id"], id);
        assert_eq!(found["youtube_handle"], "@chan");
        assert_eq!(found["name"], "Chan");

        // A row id that was never inserted resolves to null, not an error.
        let missing = invoke(
            &webview,
            "get_channel_by_id",
            serde_json::json!({ "channelId": id + 999 }),
        )
        .unwrap()
        .deserialize::<serde_json::Value>()
        .unwrap();
        assert!(missing.is_null());
    }

    #[test]
    fn update_channel_name_and_handle_persists_the_new_values_over_ipc() {
        let webview = test_webview(memory_db());

        let id = invoke(
            &webview,
            "insert_channel",
            serde_json::json!({ "name": "Old", "youtubeHandle": "@old", "avatarPath": null }),
        )
        .unwrap()
        .deserialize::<i64>()
        .unwrap();

        invoke(
            &webview,
            "update_channel_name_and_handle",
            serde_json::json!({ "channelId": id, "name": "New", "youtubeHandle": "@new" }),
        )
        .unwrap();

        let found = invoke(
            &webview,
            "get_channel_by_id",
            serde_json::json!({ "channelId": id }),
        )
        .unwrap()
        .deserialize::<serde_json::Value>()
        .unwrap();

        assert_eq!(found["name"], "New");
        assert_eq!(found["youtube_handle"], "@new");
    }

    #[test]
    fn update_channel_name_and_handle_rejects_a_malformed_handle_over_ipc() {
        let webview = test_webview(memory_db());

        let id = invoke(
            &webview,
            "insert_channel",
            serde_json::json!({ "name": "Chan", "youtubeHandle": "@chan", "avatarPath": null }),
        )
        .unwrap()
        .deserialize::<i64>()
        .unwrap();

        // The same handle-format guard insert_channel applies also runs on update, at the write
        // boundary rather than only in the frontend.
        let error = invoke(
            &webview,
            "update_channel_name_and_handle",
            serde_json::json!({ "channelId": id, "name": "Chan", "youtubeHandle": "plainname" }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidYoutubeHandle.as_str());
    }
}
