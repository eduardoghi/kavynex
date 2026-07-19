use tauri::{AppHandle, Manager};

use crate::services::library_guard::verify_library_path_then_blocking;
use crate::services::library_integrity::LibraryIntegrityReport;
use crate::services::library_migration;
use crate::services::library_paths;
use crate::services::library_summary::LibrarySummaryInfo;
use crate::services::logger;
use crate::services::{library, library_integrity};
use crate::utils::task::run_blocking;
use crate::AppResult;

/// Withdraws the asset-protocol grant on a library directory the app no longer uses.
///
/// `register_library_asset_scope` only ever *adds* the configured library directory to the
/// asset scope; nothing removed the old one after a migration. Since the scope is a set of
/// glob patterns where a forbid always wins over an allow, forbidding the old directory here
/// closes the window where any file that later lands in it would still be readable through
/// `convertFileSrc` for the rest of the session. Best effort: a failure only leaves the stale
/// grant in place (the pre-existing behavior) and must not fail the migration itself.
fn revoke_directory_from_asset_scope(app: &AppHandle, dir: &str) {
    if let Err(error) = app.asset_protocol_scope().forbid_directory(dir, true) {
        logger::warn(
            "asset_scope",
            format!("failed to revoke old library directory from asset scope: {error}"),
        );
    }
}

#[tauri::command]
pub async fn resolve_default_library_directory(app: AppHandle) -> AppResult<String> {
    run_blocking(move || library_paths::resolve_default_library_directory_sync(&app)).await
}

#[tauri::command]
pub async fn ensure_directory_exists(path: String) -> AppResult<String> {
    run_blocking(move || library_paths::ensure_directory_exists_sync(&path)).await
}

#[tauri::command]
pub async fn resolve_existing_directory(path: String) -> AppResult<String> {
    run_blocking(move || library_paths::resolve_existing_directory_sync(&path)).await
}

#[tauri::command]
pub async fn is_directory_empty(path: String) -> AppResult<bool> {
    run_blocking(move || library_paths::is_directory_empty_sync(&path)).await
}

#[tauri::command]
pub async fn migrate_library_directory(
    app: AppHandle,
    old_library_path: String,
    new_library_path: String,
) -> AppResult<library_migration::MigrateLibraryDirectoryResult> {
    // Keep the old path (already the canonical form register_library_asset_scope authorized)
    // so its asset-scope grant can be withdrawn once the migration actually moves the library.
    let old_dir_for_scope = old_library_path.trim().to_string();

    // The migration removes the managed subdirectories of `old_library_path` after
    // copying, so the verified path is the old library (the one the user actually
    // configured). The settings still hold the old path at this point: the frontend only
    // persists the new one after the migration succeeds. To survive a crash in that window,
    // the migration records the new path in a commit marker next to the database just before
    // it removes the old directory; get_app_settings adopts it if the app restarts still
    // pointing at the emptied old library (see services::library_recovery).
    let config_dir = app.path().app_config_dir().ok();

    // The commit marker lives next to the database in the config directory. If that cannot be
    // resolved the migration still runs, but without the crash-recovery marker for this run - a
    // crash between the copy and the old-directory removal would then not be self-healed on the
    // next launch. Rare (a failure here implies a deeper host problem), so log it rather than
    // refusing the migration outright.
    if config_dir.is_none() {
        logger::warn(
            "library",
            "could not resolve the app config directory; the library migration will run without a crash-recovery commit marker",
        );
    }

    // Refuse to move the library into (or under) the app config directory, where the database and
    // its backups live: it would nest the managed library tree with the database and defeat the
    // "backups off the library volume" intent. Checked before any copy/remove runs. set_app_settings
    // enforces the same on the persistence path; this covers the destructive move flow.
    if let Some(config_dir) = config_dir.as_deref() {
        if library_paths::library_path_is_inside_dir(&new_library_path, config_dir) {
            return Err(crate::AppError::from_code(
                crate::AppErrorCode::InvalidLibraryPath,
                "the library folder cannot be inside the application data directory",
            ));
        }
    }

    let commit_marker = config_dir
        .as_deref()
        .map(crate::services::library_recovery::commit_marker_path);

    let result =
        verify_library_path_then_blocking(&app, old_library_path, move |old_library_path| {
            library_migration::migrate_library_directory_sync(
                &old_library_path,
                &new_library_path,
                commit_marker.as_deref(),
            )
        })
        .await?;

    // Only revoke when the library actually moved to a different directory. `changed` is also
    // true for first-time setup (no prior library), where `old_dir_for_scope` is empty and
    // there is nothing to forbid.
    if result.changed && !old_dir_for_scope.is_empty() {
        revoke_directory_from_asset_scope(&app, &old_dir_for_scope);
    }

    Ok(result)
}

/// Intentionally accepts a caller-provided `library_path` instead of the persisted setting:
/// the settings/onboarding UI uses this to preview a candidate library folder before the user
/// confirms and it is saved. The operation is read-only (it only reads directory metadata), so
/// there is nothing to protect against here beyond the first-party-webview trust model.
#[tauri::command]
pub async fn get_library_summary(library_path: String) -> AppResult<LibrarySummaryInfo> {
    run_blocking(move || library::get_library_summary_sync(&library_path)).await
}

/// Intentionally accepts a caller-provided `library_path` instead of the persisted setting:
/// this lets "open in file manager" target a candidate library folder (e.g. during onboarding,
/// before it is persisted). The operation only spawns the OS file explorer/finder on the
/// resolved path and never modifies anything, so it relies on the first-party-webview trust
/// model rather than requiring a configured library.
#[tauri::command]
pub async fn open_path_in_system(path: String, library_path: Option<String>) -> AppResult<()> {
    run_blocking(move || library::open_path_in_system_sync(&path, library_path.as_deref())).await
}

/// Intentionally accepts a caller-provided `library_path` instead of the persisted setting:
/// the settings UI uses this to check the health of a candidate library folder before it is
/// persisted. The operation only reads the filesystem to compare it against the given media
/// and thumbnail paths, so it is non-destructive and relies on the first-party-webview trust
/// model.
#[tauri::command]
pub async fn check_library_integrity(
    library_path: String,
    media_paths: Vec<String>,
    thumbnail_paths: Vec<String>,
    live_chat_paths: Vec<String>,
) -> AppResult<LibraryIntegrityReport> {
    run_blocking(move || {
        library_integrity::check_library_integrity_sync(
            &library_path,
            media_paths,
            thumbnail_paths,
            live_chat_paths,
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_ipc::invoke;
    use crate::AppErrorCode;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::test::{mock_builder, mock_context, noop_assets};

    fn unique_test_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "kavynex-integrity-test-{}-{}-{}",
            prefix,
            std::process::id(),
            nanos
        ))
    }

    fn test_webview() -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                ensure_directory_exists,
                resolve_existing_directory,
                is_directory_empty,
                get_library_summary,
                check_library_integrity,
                open_path_in_system
            ])
            .build(mock_context(noop_assets()))
            .unwrap();

        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap()
    }

    #[test]
    fn ensure_directory_exists_command_accepts_ipc_payload() {
        let dir = unique_test_dir("command-ensure");
        let webview = test_webview();

        let response = invoke(
            &webview,
            "ensure_directory_exists",
            serde_json::json!({ "path": dir.to_string_lossy() }),
        )
        .unwrap()
        .deserialize::<String>()
        .unwrap();

        assert_eq!(response, dir.canonicalize().unwrap().to_string_lossy());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn check_library_integrity_command_accepts_camel_case_ipc_payload() {
        let library = unique_test_dir("command-integrity");
        fs::create_dir_all(library.join("video")).unwrap();
        fs::create_dir_all(library.join("live_chat")).unwrap();
        fs::write(library.join("video").join("a.mp4"), b"data").unwrap();
        // Not referenced by the database -> should be reported as an orphan.
        fs::write(library.join("video").join("orphan.mp4"), b"data").unwrap();
        // A referenced live chat file that is present but zero-length -> corrupt.
        fs::write(library.join("live_chat").join("a.json.gz"), b"").unwrap();

        let webview = test_webview();

        let response = invoke(
            &webview,
            "check_library_integrity",
            serde_json::json!({
                "libraryPath": library.to_string_lossy(),
                "mediaPaths": ["video/a.mp4", "video/missing.mp4"],
                "thumbnailPaths": ["thumbnails/missing.jpg"],
                "liveChatPaths": ["live_chat/a.json.gz"]
            }),
        )
        .unwrap()
        .deserialize::<serde_json::Value>()
        .unwrap();

        assert_eq!(response["checked_media_files"], 2);
        assert_eq!(response["missing_media_files"], 1);
        assert_eq!(response["checked_thumbnail_files"], 1);
        assert_eq!(response["missing_thumbnail_files"], 1);
        assert_eq!(response["orphan_media_files"], 1);
        assert_eq!(response["orphan_media_examples"][0], "video/orphan.mp4");
        assert_eq!(response["checked_live_chat_files"], 1);
        assert_eq!(response["corrupt_live_chat_files"], 1);
        assert_eq!(
            response["corrupt_live_chat_examples"][0],
            "live_chat/a.json.gz"
        );

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn is_directory_empty_command_round_trips_a_bool_over_ipc() {
        let dir = unique_test_dir("command-empty");
        fs::create_dir_all(&dir).unwrap();

        let webview = test_webview();

        let empty = invoke(
            &webview,
            "is_directory_empty",
            serde_json::json!({ "path": dir.to_string_lossy() }),
        )
        .unwrap()
        .deserialize::<bool>()
        .unwrap();
        assert!(
            empty,
            "a freshly created directory should be reported empty"
        );

        fs::write(dir.join("a.txt"), b"data").unwrap();

        let empty = invoke(
            &webview,
            "is_directory_empty",
            serde_json::json!({ "path": dir.to_string_lossy() }),
        )
        .unwrap()
        .deserialize::<bool>()
        .unwrap();
        assert!(
            !empty,
            "a directory with a file should be reported non-empty"
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn resolve_existing_directory_command_maps_a_missing_dir_to_an_error_over_ipc() {
        let missing = unique_test_dir("command-missing");
        let webview = test_webview();

        // A non-existent path must come back as a structured AppError (code preserved across
        // the IPC boundary), not a success.
        let error = invoke(
            &webview,
            "resolve_existing_directory",
            serde_json::json!({ "path": missing.to_string_lossy() }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidDirectoryPath.as_str());
    }

    #[test]
    fn get_library_summary_command_accepts_camel_case_and_counts_files_over_ipc() {
        let library = unique_test_dir("command-summary");
        fs::create_dir_all(library.join("video")).unwrap();
        fs::write(library.join("video").join("a.mp4"), b"data").unwrap();

        let webview = test_webview();

        // The command takes `libraryPath` (camelCase over IPC) and returns a struct; both the
        // argument mapping and the response serialization are exercised here.
        let response = invoke(
            &webview,
            "get_library_summary",
            serde_json::json!({ "libraryPath": library.to_string_lossy() }),
        )
        .unwrap()
        .deserialize::<serde_json::Value>()
        .unwrap();

        assert_eq!(response["video_files"], 1);
        assert!(
            response["formatted_size"].is_string(),
            "formatted_size should serialize as a string"
        );

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn open_path_in_system_command_rejects_a_missing_library_over_ipc() {
        let webview = test_webview();

        // With no configured library the command rejects in resolve_path_inside_library, before it
        // ever spawns a file manager, and the error code must survive the IPC round trip. Also
        // exercises the `path`/`libraryPath` (camelCase Option<String>) argument deserialization -
        // the one command in this file that takes an optional argument over IPC.
        let error = invoke(
            &webview,
            "open_path_in_system",
            serde_json::json!({ "path": "video/clip.mp4", "libraryPath": null }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidMediaPath.as_str());
    }
}
