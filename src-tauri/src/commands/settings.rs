use tauri::State;

use crate::services::database::{
    get_app_settings_from_pool, set_app_settings_in_pool, Db, StoredAppSettings,
};
use crate::services::library_paths::resolve_existing_library_dir;
use crate::services::library_recovery;
use crate::utils::task::run_blocking;
use crate::AppResult;

#[tauri::command]
pub async fn get_app_settings(db: State<'_, Db>) -> AppResult<StoredAppSettings> {
    let pool = db.pool().await?;

    // Self-heal a library migration that was interrupted before the frontend could persist the
    // new path: if the configured library lost its content but a commit marker points at a
    // populated directory, adopt it before returning, so the frontend never sees the library as
    // "disappeared". Best effort and cheap in the common case (a single stat of a missing
    // marker); see services::library_recovery.
    if let Some(config_dir) = db.path().parent() {
        library_recovery::reconcile_interrupted_migration(&pool, config_dir).await;
    }

    get_app_settings_from_pool(&pool).await
}

/// Rejects a non-empty `library_path` that is not an existing directory (or is a filesystem
/// root). The whole security model re-derives the library directory from this stored value and
/// trusts it (see `services::library_guard`); enforcing it at the write boundary stops a
/// compromised frontend from persisting an arbitrary base path that a later delete/move command
/// would then operate inside. An empty value is the valid "not configured yet" state and the
/// legitimate flow always persists a path already created by `ensure_directory_exists`.
fn validate_settings_library_path(library_path: &str) -> AppResult<()> {
    if library_path.trim().is_empty() {
        return Ok(());
    }

    resolve_existing_library_dir(library_path).map(|_| ())
}

#[tauri::command]
pub async fn set_app_settings(
    db: State<'_, Db>,
    import_mode: String,
    library_path: String,
    load_remote_images: bool,
    check_updates_on_startup: bool,
) -> AppResult<()> {
    let trimmed_library_path = library_path.trim().to_string();

    // Validate the library path off the async runtime: resolve_existing_library_dir touches the
    // filesystem (exists / is_dir / canonicalize).
    let path_for_validation = trimmed_library_path.clone();
    run_blocking(move || validate_settings_library_path(&path_for_validation)).await?;

    let pool = db.pool().await?;
    set_app_settings_in_pool(
        &pool,
        import_mode.trim(),
        &trimmed_library_path,
        load_remote_images,
        check_updates_on_startup,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_ipc::{invoke, memory_db};
    use crate::AppErrorCode;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::Manager;

    fn unique_test_dir(suffix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        std::env::temp_dir().join(format!(
            "kavynex-settings-cmd-test-{}-{}-{}",
            std::process::id(),
            nanos,
            suffix
        ))
    }

    #[test]
    fn validate_settings_library_path_accepts_empty_as_not_configured() {
        validate_settings_library_path("").unwrap();
        validate_settings_library_path("   ").unwrap();
    }

    #[test]
    fn validate_settings_library_path_accepts_an_existing_directory() {
        let dir = unique_test_dir("existing");
        fs::create_dir_all(&dir).unwrap();

        validate_settings_library_path(&dir.to_string_lossy()).unwrap();

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_settings_library_path_rejects_a_missing_directory() {
        let missing = unique_test_dir("missing");
        let error = validate_settings_library_path(&missing.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidLibraryPath.as_str());
    }

    #[test]
    fn validate_settings_library_path_rejects_a_file() {
        let dir = unique_test_dir("file");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("not-a-dir.txt");
        fs::write(&file, b"x").unwrap();

        let error = validate_settings_library_path(&file.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidLibraryPath.as_str());

        let _ = fs::remove_dir_all(&dir);
    }

    // The settings commands now take `State<Db>` instead of `AppHandle`, so they can be driven
    // through a real IPC round trip against a mock app managing an in-memory database - the
    // wiring (arg deserialization, State injection, response serialization) that could not be
    // exercised while the pool lived in a process-wide static.

    fn test_webview(db: Db) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![get_app_settings, set_app_settings])
            .build(mock_context(noop_assets()))
            .unwrap();

        app.manage(db);

        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap()
    }

    #[test]
    fn get_app_settings_command_returns_defaults_on_an_empty_database_over_ipc() {
        let webview = test_webview(memory_db());

        let response = invoke(&webview, "get_app_settings", serde_json::json!({}))
            .unwrap()
            .deserialize::<serde_json::Value>()
            .unwrap();

        // An empty app_settings table serializes every field as null (camelCase keys via ts-rs).
        assert!(response["importMode"].is_null());
        assert!(response["libraryPath"].is_null());
        assert!(response["loadRemoteImages"].is_null());
        assert!(response["checkUpdatesOnStartup"].is_null());
    }

    #[test]
    fn set_then_get_app_settings_round_trips_through_ipc() {
        let webview = test_webview(memory_db());

        // An empty library path is the valid "not configured yet" state, so this avoids needing
        // a real directory on disk while still exercising the write path and the transaction.
        invoke(
            &webview,
            "set_app_settings",
            serde_json::json!({
                "importMode": "move",
                "libraryPath": "",
                "loadRemoteImages": false,
                "checkUpdatesOnStartup": true
            }),
        )
        .unwrap();

        let response = invoke(&webview, "get_app_settings", serde_json::json!({}))
            .unwrap()
            .deserialize::<serde_json::Value>()
            .unwrap();

        assert_eq!(response["importMode"], "move");
        assert_eq!(response["loadRemoteImages"], "false");
        assert_eq!(response["checkUpdatesOnStartup"], "true");
    }

    #[test]
    fn set_app_settings_command_rejects_an_unknown_import_mode_over_ipc() {
        let webview = test_webview(memory_db());

        let error = invoke(
            &webview,
            "set_app_settings",
            serde_json::json!({
                "importMode": "teleport",
                "libraryPath": "",
                "loadRemoteImages": true,
                "checkUpdatesOnStartup": false
            }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidInput.as_str());
    }
}
