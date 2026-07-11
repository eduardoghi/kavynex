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
    // persists the new one after the migration succeeds.
    let result =
        verify_library_path_then_blocking(&app, old_library_path, move |old_library_path| {
            library_migration::migrate_library_directory_sync(&old_library_path, &new_library_path)
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
) -> AppResult<LibraryIntegrityReport> {
    run_blocking(move || {
        library_integrity::check_library_integrity_sync(&library_path, media_paths, thumbnail_paths)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

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
                check_library_integrity
            ])
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
    fn ensure_directory_exists_command_accepts_ipc_payload() {
        let dir = unique_test_dir("command-ensure");
        let webview = test_webview();

        let response = invoke_command(
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
        fs::write(library.join("video").join("a.mp4"), b"data").unwrap();
        // Not referenced by the database -> should be reported as an orphan.
        fs::write(library.join("video").join("orphan.mp4"), b"data").unwrap();

        let webview = test_webview();

        let response = invoke_command(
            &webview,
            "check_library_integrity",
            serde_json::json!({
                "libraryPath": library.to_string_lossy(),
                "mediaPaths": ["video/a.mp4", "video/missing.mp4"],
                "thumbnailPaths": ["thumbnails/missing.jpg"]
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

        let _ = fs::remove_dir_all(&library);
    }
}
