use tauri::State;

use crate::services::database::{
    get_app_settings_from_pool, set_app_settings_in_pool, set_external_backup_dir_in_pool, Db,
    StoredAppSettings,
};
use std::path::Path;

use crate::services::library_paths::{library_path_is_inside_dir, resolve_existing_library_dir};
use crate::services::library_recovery;
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

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
fn validate_settings_library_path(library_path: &str, config_dir: Option<&Path>) -> AppResult<()> {
    if library_path.trim().is_empty() {
        return Ok(());
    }

    resolve_existing_library_dir(library_path)?;

    // Refuse a library that lives in (or under) the app's config directory, where the database and
    // every backup generation are kept. Nesting it there would defeat the "backups off the library
    // volume" intent and run the managed-subdirectory cleanup in the same tree as the database.
    if let Some(config_dir) = config_dir {
        if library_path_is_inside_dir(library_path, config_dir) {
            return Err(AppError::from_code(
                AppErrorCode::InvalidLibraryPath,
                "the library folder cannot be inside the application data directory",
            ));
        }
    }

    Ok(())
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

    // The database file lives directly in the app config directory, so its parent is that directory
    // (the same derivation get_app_settings uses); the library must not be nested inside it.
    let config_dir = db.path().parent().map(Path::to_path_buf);

    // Validate the library path off the async runtime: resolve_existing_library_dir touches the
    // filesystem (exists / is_dir / canonicalize).
    let path_for_validation = trimmed_library_path.clone();
    run_blocking(move || {
        validate_settings_library_path(&path_for_validation, config_dir.as_deref())
    })
    .await?;

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

/// Rejects a non-empty external backup directory that is not an existing directory. An empty value
/// is the valid "off" state. Unlike the library path, this directory is only ever *written to* (an
/// atomic export drops a `kavynex-backup.db` mirror into it); it is never read back through the
/// asset scope or a delete/move command, so an existing-directory check is the whole requirement.
fn validate_external_backup_dir(external_backup_dir: &str) -> AppResult<()> {
    let trimmed = external_backup_dir.trim();

    if trimmed.is_empty() {
        return Ok(());
    }

    if std::fs::metadata(trimmed)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
    {
        return Ok(());
    }

    Err(AppError::from_code(
        AppErrorCode::InvalidInput,
        "the external backup folder must be an existing directory",
    ))
}

#[tauri::command]
pub async fn set_external_backup_dir(db: State<'_, Db>, path: String) -> AppResult<()> {
    let trimmed = path.trim().to_string();

    // Validate off the async runtime: std::fs::metadata touches the filesystem (and can block on a
    // slow external/network path).
    let path_for_validation = trimmed.clone();
    run_blocking(move || validate_external_backup_dir(&path_for_validation)).await?;

    let pool = db.pool().await?;
    set_external_backup_dir_in_pool(&pool, &trimmed).await
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
        validate_settings_library_path("", None).unwrap();
        validate_settings_library_path("   ", None).unwrap();
    }

    #[test]
    fn validate_settings_library_path_accepts_an_existing_directory() {
        let dir = unique_test_dir("existing");
        fs::create_dir_all(&dir).unwrap();

        validate_settings_library_path(&dir.to_string_lossy(), None).unwrap();

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_settings_library_path_rejects_a_missing_directory() {
        let missing = unique_test_dir("missing");
        let error = validate_settings_library_path(&missing.to_string_lossy(), None).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidLibraryPath.as_str());
    }

    #[test]
    fn validate_settings_library_path_rejects_a_directory_inside_the_config_dir() {
        // A library nested in the app config directory (where the database and its backups live) is
        // refused so library maintenance never runs in the same tree as the database.
        let config_dir = unique_test_dir("config");
        let library = config_dir.join("library");
        fs::create_dir_all(&library).unwrap();

        let error = validate_settings_library_path(&library.to_string_lossy(), Some(&config_dir))
            .unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidLibraryPath.as_str());

        let _ = fs::remove_dir_all(&config_dir);
    }

    #[test]
    fn validate_settings_library_path_accepts_a_directory_outside_the_config_dir() {
        let config_dir = unique_test_dir("config-sibling");
        let library = unique_test_dir("library-sibling");
        fs::create_dir_all(&config_dir).unwrap();
        fs::create_dir_all(&library).unwrap();

        validate_settings_library_path(&library.to_string_lossy(), Some(&config_dir)).unwrap();

        let _ = fs::remove_dir_all(&config_dir);
        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn validate_external_backup_dir_accepts_empty_as_off() {
        validate_external_backup_dir("").unwrap();
        validate_external_backup_dir("   ").unwrap();
    }

    #[test]
    fn validate_external_backup_dir_accepts_an_existing_directory() {
        let dir = unique_test_dir("ext-existing");
        fs::create_dir_all(&dir).unwrap();

        validate_external_backup_dir(&dir.to_string_lossy()).unwrap();

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_external_backup_dir_rejects_a_missing_directory() {
        let missing = unique_test_dir("ext-missing");
        let error = validate_external_backup_dir(&missing.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidInput.as_str());
    }

    #[test]
    fn validate_settings_library_path_rejects_a_file() {
        let dir = unique_test_dir("file");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("not-a-dir.txt");
        fs::write(&file, b"x").unwrap();

        let error = validate_settings_library_path(&file.to_string_lossy(), None).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidLibraryPath.as_str());

        let _ = fs::remove_dir_all(&dir);
    }

    // The settings commands now take `State<Db>` instead of `AppHandle`, so they can be driven
    // through a real IPC round trip against a mock app managing an in-memory database - the
    // wiring (arg deserialization, State injection, response serialization) that could not be
    // exercised while the pool lived in a process-wide static.

    fn test_webview(db: Db) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                get_app_settings,
                set_app_settings,
                set_external_backup_dir
            ])
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

    #[test]
    fn set_external_backup_dir_persists_and_reads_back_over_ipc() {
        let dir = unique_test_dir("ext-ipc");
        fs::create_dir_all(&dir).unwrap();

        let webview = test_webview(memory_db());

        invoke(
            &webview,
            "set_external_backup_dir",
            serde_json::json!({ "path": dir.to_string_lossy() }),
        )
        .unwrap();

        let response = invoke(&webview, "get_app_settings", serde_json::json!({}))
            .unwrap()
            .deserialize::<serde_json::Value>()
            .unwrap();

        assert_eq!(
            response["externalBackupDir"],
            dir.to_string_lossy().as_ref()
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_external_backup_dir_rejects_a_missing_directory_over_ipc() {
        let missing = unique_test_dir("ext-ipc-missing");
        let webview = test_webview(memory_db());

        let error = invoke(
            &webview,
            "set_external_backup_dir",
            serde_json::json!({ "path": missing.to_string_lossy() }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidInput.as_str());
    }
}
