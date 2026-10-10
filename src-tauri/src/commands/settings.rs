use crate::services::chosen_folders::FolderPurpose;
use tauri::State;

use crate::services::database::{
    bool_setting, get_app_settings_from_pool, set_app_settings_in_pool,
    set_external_backup_dir_in_pool, Db, StoredAppSettings,
};
use std::path::Path;

use crate::services::db_backup::gates::validate_external_backup_dir;
use crate::services::library;
use crate::services::library::paths::validate_settings_library_path;
use crate::utils::task::run_blocking;
use crate::AppResult;

#[tauri::command]
pub async fn get_app_settings(db: State<'_, Db>) -> AppResult<StoredAppSettings> {
    let pool = db.pool().await?;

    // Self-heal a library migration that was interrupted before the frontend could persist the
    // new path. If the configured library lost its content but a commit marker points at a
    // populated directory, adopt it before returning, so the frontend never sees the library as
    // "disappeared". Best effort and cheap in the common case (a single stat of a missing
    // marker); see services::library::recovery.
    if let Some(config_dir) = db.path().parent() {
        library::recovery::reconcile_interrupted_migration(&pool, config_dir).await;
    }

    get_app_settings_from_pool(&pool).await
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

    let pool = db.pool().await?;

    // The path already stored is written back without being checked again. It was validated when
    // it was stored, and writing it back grants nothing new. Every other settings change rewrites
    // the whole row with it, so checking it would refuse a change to the import mode or a privacy
    // toggle whenever the library's drive is not connected, which is exactly when the frontend
    // keeps the stored path instead of clearing it.
    let stored_library_path = get_app_settings_from_pool(&pool)
        .await?
        .library_path
        .unwrap_or_default();

    if trimmed_library_path != stored_library_path.trim() {
        // A new library folder has to be one the user picked. Checked before anything resolves it,
        // so a made-up `\\host\share` is refused without an SMB handshake. See
        // services::chosen_folders.
        if !trimmed_library_path.is_empty() {
            crate::services::chosen_folders::ensure_chosen(
                FolderPurpose::Library,
                &trimmed_library_path,
                &[],
            )?;
        }

        // The database file lives directly in the app config directory, so its parent is that
        // directory (the same derivation get_app_settings uses); the library must not be nested
        // inside it.
        let config_dir = db.path().parent().map(Path::to_path_buf);

        // Validate the library path off the async runtime. resolve_existing_library_dir touches
        // the filesystem (exists / is_dir / canonicalize).
        let path_for_validation = trimmed_library_path.clone();
        run_blocking(move || {
            validate_settings_library_path(&path_for_validation, config_dir.as_deref())
        })
        .await?;
    }

    // The four keys this form owns. `external_backup_dir` stays `None` on purpose. It has its own
    // command, and a `None` field is skipped rather than cleared, so saving the settings form
    // cannot wipe a configured backup folder.
    set_app_settings_in_pool(
        &pool,
        &StoredAppSettings {
            import_mode: Some(import_mode.trim().to_string()),
            library_path: Some(trimmed_library_path),
            load_remote_images: bool_setting(load_remote_images),
            check_updates_on_startup: bool_setting(check_updates_on_startup),
            external_backup_dir: None,
        },
    )
    .await
}

#[tauri::command]
pub async fn set_external_backup_dir(db: State<'_, Db>, path: String) -> AppResult<()> {
    let trimmed = path.trim().to_string();

    // Turning the mirror off needs no folder. Any other value has to be one the user picked, or the
    // one already stored. The mirror writes the whole database there every day, and a share is a
    // supported target, which is why the value cannot simply be refused for being a network path.
    // See services::chosen_folders.
    if !trimmed.is_empty() {
        let pool = db.pool().await?;
        let stored = get_app_settings_from_pool(&pool).await?;

        crate::services::chosen_folders::ensure_chosen(
            FolderPurpose::ExternalBackup,
            &trimmed,
            &[stored.external_backup_dir.as_deref()],
        )?;
    }

    // The database file lives directly in the app config directory, so its parent is that directory
    // (the same derivation set_app_settings uses); the external mirror must not be nested inside it.
    let config_dir = db.path().parent().map(Path::to_path_buf);

    // Validate off the async runtime. std::fs::metadata touches the filesystem (and can block on a
    // slow external/network path).
    let path_for_validation = trimmed.clone();
    run_blocking(move || validate_external_backup_dir(&path_for_validation, config_dir.as_deref()))
        .await?;

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
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::Manager;

    fn unique_test_dir(suffix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-settings-cmd-test-{suffix}-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    // The settings commands now take `State<Db>` instead of `AppHandle`, so they can be driven
    // through a real IPC round trip against a mock app managing an in-memory database. The
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

    fn set_settings_over_ipc(
        webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        import_mode: &str,
        library_path: &str,
    ) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
        invoke(
            webview,
            "set_app_settings",
            serde_json::json!({
                "importMode": import_mode,
                "libraryPath": library_path,
                "loadRemoteImages": false,
                "checkUpdatesOnStartup": true
            }),
        )
    }

    #[test]
    fn set_app_settings_keeps_working_while_the_stored_library_folder_is_gone() {
        // The library's drive is not connected. The frontend keeps the stored path rather than
        // clearing it, and every other settings change writes it back with the rest of the row, so
        // refusing it here would make the import mode and the privacy toggles unchangeable until the
        // drive came back.
        let library = unique_test_dir("stored-gone");
        fs::create_dir_all(&library).unwrap();
        let library_path = library.to_string_lossy().to_string();
        crate::services::chosen_folders::record(
            crate::services::chosen_folders::FolderPurpose::Library,
            &library_path,
        );

        let webview = test_webview(memory_db());

        set_settings_over_ipc(&webview, "copy", &library_path).expect("store the library");
        fs::remove_dir_all(&library).unwrap();

        set_settings_over_ipc(&webview, "move", &library_path)
            .expect("the stored path is written back unchecked");

        let response = invoke(&webview, "get_app_settings", serde_json::json!({}))
            .unwrap()
            .deserialize::<serde_json::Value>()
            .unwrap();

        assert_eq!(response["importMode"], "move");
        assert_eq!(response["libraryPath"], library_path.as_str());
    }

    #[test]
    fn set_app_settings_still_refuses_a_new_library_folder_that_does_not_exist() {
        // The exemption above covers the value already stored and nothing else.
        let stored = unique_test_dir("stored-present");
        fs::create_dir_all(&stored).unwrap();
        let missing = unique_test_dir("new-missing");
        crate::services::chosen_folders::record(
            crate::services::chosen_folders::FolderPurpose::Library,
            &stored.to_string_lossy(),
        );
        // Picked, so what refuses it below is the folder being gone, not where it came from.
        crate::services::chosen_folders::record(
            crate::services::chosen_folders::FolderPurpose::Library,
            &missing.to_string_lossy(),
        );

        let webview = test_webview(memory_db());

        set_settings_over_ipc(&webview, "copy", &stored.to_string_lossy()).expect("store");

        let error = set_settings_over_ipc(&webview, "copy", &missing.to_string_lossy())
            .expect_err("a different, missing folder must be refused");

        assert_eq!(error["code"], AppErrorCode::InvalidLibraryPath.as_str());

        let _ = fs::remove_dir_all(&stored);
    }

    #[test]
    fn set_app_settings_refuses_a_library_folder_that_was_not_picked() {
        // What a compromised renderer would send to point the library at a share it controls. The
        // spellings the cross-cutting path rule asks every such command to be tested with.
        let webview = test_webview(memory_db());

        for path in [
            r"\\attacker\share\library",
            "//attacker/share/library",
            r"\\?\UNC\attacker\share\library",
        ] {
            let error = set_settings_over_ipc(&webview, "copy", path)
                .expect_err("a folder the user did not pick must be refused");

            assert_eq!(error["code"], AppErrorCode::InvalidInput.as_str(), "{path}");
        }

        let response = invoke(&webview, "get_app_settings", serde_json::json!({}))
            .unwrap()
            .deserialize::<serde_json::Value>()
            .unwrap();
        assert!(response["libraryPath"].is_null(), "nothing was stored");
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
        crate::services::chosen_folders::record(
            crate::services::chosen_folders::FolderPurpose::ExternalBackup,
            &dir.to_string_lossy(),
        );

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
        // Picked, so what refuses it is the folder being gone.
        crate::services::chosen_folders::record(
            crate::services::chosen_folders::FolderPurpose::ExternalBackup,
            &missing.to_string_lossy(),
        );
        let webview = test_webview(memory_db());

        let error = invoke(
            &webview,
            "set_external_backup_dir",
            serde_json::json!({ "path": missing.to_string_lossy() }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidInput.as_str());
    }

    #[test]
    fn set_external_backup_dir_refuses_a_folder_that_was_not_picked() {
        // The mirror writes the whole database there every day, so a made-up share is refused
        // before anything resolves it, and nothing is stored.
        let webview = test_webview(memory_db());

        let error = invoke(
            &webview,
            "set_external_backup_dir",
            serde_json::json!({ "path": r"\\attacker\share\backups" }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidInput.as_str());

        let response = invoke(&webview, "get_app_settings", serde_json::json!({}))
            .unwrap()
            .deserialize::<serde_json::Value>()
            .unwrap();
        assert!(response["externalBackupDir"].is_null());

        // Turning the mirror off needs no folder.
        invoke(
            &webview,
            "set_external_backup_dir",
            serde_json::json!({ "path": "" }),
        )
        .expect("an empty value turns the mirror off");
    }
}
