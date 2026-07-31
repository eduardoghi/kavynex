use tauri::{AppHandle, Manager, State};

use crate::services::database::Db;
use crate::services::library;
use crate::services::library::guard::{
    verify_library_path_then_blocking, verify_library_path_then_blocking_in_pool,
};
use crate::services::library::integrity::LibraryIntegrityReport;
use crate::services::library::summary::LibrarySummaryInfo;
use crate::services::logger;
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
    // A forbid is permanent for the rest of the session - Tauri's scope checks the forbidden
    // patterns first and offers no way to withdraw one - so record what is being given up before
    // doing it. Migrating back to this library later would otherwise re-grant it to no effect and
    // leave every thumbnail and video silently unreadable; register_library_asset_scope reads this
    // and refuses with a "restart required" instead. Recorded first so the two cannot disagree even
    // if a forbid below fails partway.
    crate::commands::security::record_forbidden_library_dirs(std::path::Path::new(dir));

    // register_library_asset_scope grants the four managed subdirectories, not the root, so forbid
    // the same set here. A forbid always wins over an allow, closing the window where a file that
    // later lands in the old library's managed trees would still be readable through convertFileSrc.
    for managed_dir in
        crate::commands::security::managed_asset_scope_dirs(std::path::Path::new(dir))
    {
        if let Err(error) = app
            .asset_protocol_scope()
            .forbid_directory(&managed_dir, true)
        {
            logger::warn(
                "asset_scope",
                format!(
                    "failed to revoke old library subdirectory {} from asset scope: {error}",
                    logger::redact_path(&managed_dir)
                ),
            );
        }
    }
}

#[tauri::command]
pub async fn resolve_default_library_directory(app: AppHandle) -> AppResult<String> {
    run_blocking(move || library::paths::resolve_default_library_directory_sync(&app)).await
}

#[tauri::command]
pub async fn ensure_directory_exists(path: String) -> AppResult<String> {
    run_blocking(move || library::paths::ensure_directory_exists_sync(&path)).await
}

#[tauri::command]
pub async fn resolve_existing_directory(path: String) -> AppResult<String> {
    run_blocking(move || library::paths::resolve_existing_directory_sync(&path)).await
}

#[tauri::command]
pub async fn is_directory_empty(path: String) -> AppResult<bool> {
    run_blocking(move || library::paths::is_directory_empty_sync(&path)).await
}

#[tauri::command]
pub async fn migrate_library_directory(
    app: AppHandle,
    old_library_path: String,
    new_library_path: String,
) -> AppResult<library::migration::MigrateLibraryDirectoryResult> {
    // Keep the old path (already the canonical form register_library_asset_scope authorized)
    // so its asset-scope grant can be withdrawn once the migration actually moves the library.
    let old_dir_for_scope = old_library_path.trim().to_string();

    // The migration removes the managed subdirectories of `old_library_path` after
    // copying, so the verified path is the old library (the one the user actually
    // configured). The settings still hold the old path at this point: the frontend only
    // persists the new one after the migration succeeds. To survive a crash in that window,
    // the migration records the new path in a commit marker next to the database just before
    // it removes the old directory; get_app_settings adopts it if the app restarts still
    // pointing at the emptied old library (see services::library::recovery).
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
        if library::paths::library_path_is_inside_dir(&new_library_path, config_dir) {
            return Err(crate::AppError::from_code(
                crate::AppErrorCode::InvalidLibraryPath,
                "the library folder cannot be inside the application data directory",
            ));
        }
    }

    let commit_marker = config_dir
        .as_deref()
        .map(crate::services::library::recovery::commit_marker_path);

    let result =
        verify_library_path_then_blocking(&app, old_library_path, move |old_library_path| {
            library::migration::migrate_library_directory_sync(
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

/// Reports the size and file counts of the configured library directory.
///
/// `library_path` arrives over IPC but is verified against the persisted setting before anything
/// is read, like every other command that takes one. It used to be trusted on its own, documented
/// as a first-party-webview concession so the settings UI could preview a folder before it was
/// saved - but no caller ever did that: the settings modal and the diagnostics summary both pass
/// `settings.libraryPath`, which is the persisted value, and the folder-change flow
/// (`use-cases/change-library-path.ts`) previews a candidate with `is_directory_empty` instead.
/// The concession bought nothing and cost the one rule the whole backend rests on.
#[tauri::command]
pub async fn get_library_summary(
    db: State<'_, Db>,
    library_path: String,
) -> AppResult<LibrarySummaryInfo> {
    let pool = db.pool().await?;

    verify_library_path_then_blocking_in_pool(&pool, library_path, |library_path| {
        library::get_library_summary_sync(&library_path)
    })
    .await
}

/// Reveals a path inside the configured library in the OS file manager.
///
/// Verified against the persisted setting for the reason given on `get_library_summary`, and with
/// one of its own: `resolve_path_inside_library` confines `path` to `library_path`, so a caller
/// that supplies *both* makes that containment check self-referential - passing a drive root as
/// each would satisfy it trivially. The guard is what makes the containment mean something. A
/// missing `library_path` is rejected here rather than deeper in, so the failure names the real
/// cause.
#[tauri::command]
pub async fn open_path_in_system(
    db: State<'_, Db>,
    path: String,
    library_path: Option<String>,
) -> AppResult<()> {
    let pool = db.pool().await?;

    verify_library_path_then_blocking_in_pool(
        &pool,
        library_path.unwrap_or_default(),
        move |library_path| library::open_path_in_system_sync(&path, Some(&library_path)),
    )
    .await
}

/// Compares the database's stored paths against the files in the configured library.
///
/// Verified against the persisted setting for the reason given on `get_library_summary`. This one
/// mattered most of the three: the report carries up to five *real filenames* per category
/// (`orphan_media_examples` and friends), collected by walking `<library_path>/video`, `/audio`,
/// `/thumbnails` and `/live_chat`. With the path trusted, that made this command a directory
/// enumerator for any such tree on disk. The names are worth reporting - Diagnostics shows the
/// user which of their own files are unreferenced - so the fix is the guard, not a poorer report.
#[tauri::command]
pub async fn check_library_integrity(
    db: State<'_, Db>,
    library_path: String,
    media_paths: Vec<String>,
    thumbnail_paths: Vec<String>,
    live_chat_paths: Vec<String>,
) -> AppResult<LibraryIntegrityReport> {
    let pool = db.pool().await?;

    verify_library_path_then_blocking_in_pool(&pool, library_path, move |library_path| {
        library::integrity::check_library_integrity_sync(
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
    use crate::commands::test_ipc::{invoke, memory_db};
    use crate::services::database::{set_app_settings_in_pool, StoredAppSettings};
    use crate::AppErrorCode;
    use std::fs;
    use std::path::{Path, PathBuf};
    use tauri::test::{mock_builder, mock_context, noop_assets};

    fn unique_test_dir(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-integrity-test-{prefix}-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    /// A [`Db`] over an in-memory database whose `app_settings` row already names `library_dir` as
    /// the configured library. That row is what the guard on the three library-reading commands
    /// compares against, so without it every one of them fails before doing any work.
    fn memory_db_with_library(library_dir: &Path) -> Db {
        let db = memory_db();
        let library_path = library_dir.to_string_lossy().to_string();

        tauri::async_runtime::block_on(async {
            let pool = db.pool().await.expect("open the in-memory pool");

            set_app_settings_in_pool(
                &pool,
                &StoredAppSettings {
                    library_path: Some(library_path),
                    ..Default::default()
                },
            )
            .await
            .expect("persist the configured library path");
        });

        db
    }

    fn test_webview(db: Db) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
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

        app.manage(db);

        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap()
    }

    #[test]
    fn ensure_directory_exists_command_accepts_ipc_payload() {
        let dir = unique_test_dir("command-ensure");
        // Takes no library path and runs before one is configured (it is what the folder-change
        // flow calls on a candidate), so it needs no settings row behind it.
        let webview = test_webview(memory_db());

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

        let webview = test_webview(memory_db_with_library(&library));

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

        let webview = test_webview(memory_db());

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
        let webview = test_webview(memory_db());

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

        let webview = test_webview(memory_db_with_library(&library));

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
        let webview = test_webview(memory_db());

        // With no library path supplied the command rejects in the configured-library guard,
        // before it ever spawns a file manager, and the error code must survive the IPC round
        // trip. Also exercises the `path`/`libraryPath` (camelCase Option<String>) argument
        // deserialization - the one command in this file that takes an optional argument over IPC.
        let error = invoke(
            &webview,
            "open_path_in_system",
            serde_json::json!({ "path": "video/clip.mp4", "libraryPath": null }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidLibraryPath.as_str());
    }

    // The three commands below take a `library_path` over IPC and verify it against the persisted
    // setting. Each one is pinned separately rather than through a shared loop: they differ in
    // what a trusted path would have bought an attacker, and the report one of them returns is the
    // reason this matters at all.

    #[test]
    fn get_library_summary_command_rejects_a_path_that_is_not_the_configured_library() {
        let configured = unique_test_dir("summary-configured");
        let elsewhere = unique_test_dir("summary-elsewhere");
        fs::create_dir_all(configured.join("video")).unwrap();
        fs::create_dir_all(elsewhere.join("video")).unwrap();
        fs::write(elsewhere.join("video").join("private.mp4"), b"data").unwrap();

        let webview = test_webview(memory_db_with_library(&configured));

        let error = invoke(
            &webview,
            "get_library_summary",
            serde_json::json!({ "libraryPath": elsewhere.to_string_lossy() }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidLibraryPath.as_str());

        let _ = fs::remove_dir_all(&configured);
        let _ = fs::remove_dir_all(&elsewhere);
    }

    #[test]
    fn check_library_integrity_command_rejects_a_path_that_is_not_the_configured_library() {
        // The one that mattered most: the report carries up to five real filenames per category,
        // so a trusted `library_path` made this a directory enumerator for any tree holding a
        // `video/`, `audio/`, `thumbnails/` or `live_chat/` subdirectory. The planted file below is
        // what such a call would have named back; the guard has to refuse before the walk runs.
        let configured = unique_test_dir("integrity-configured");
        let elsewhere = unique_test_dir("integrity-elsewhere");
        fs::create_dir_all(&configured).unwrap();
        fs::create_dir_all(elsewhere.join("video")).unwrap();
        fs::write(elsewhere.join("video").join("private.mp4"), b"data").unwrap();

        let webview = test_webview(memory_db_with_library(&configured));

        let error = invoke(
            &webview,
            "check_library_integrity",
            serde_json::json!({
                "libraryPath": elsewhere.to_string_lossy(),
                "mediaPaths": [],
                "thumbnailPaths": [],
                "liveChatPaths": []
            }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidLibraryPath.as_str());

        let _ = fs::remove_dir_all(&configured);
        let _ = fs::remove_dir_all(&elsewhere);
    }

    #[test]
    fn open_path_in_system_command_rejects_a_path_that_is_not_the_configured_library() {
        // `resolve_path_inside_library` confines `path` to `library_path`, so a caller supplying
        // both makes that containment self-referential - passing the same outside directory as
        // each would satisfy it. The guard is what stops the spawn, which is why this asserts the
        // library-path code rather than a containment failure.
        let configured = unique_test_dir("open-configured");
        let elsewhere = unique_test_dir("open-elsewhere");
        fs::create_dir_all(&configured).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();

        let webview = test_webview(memory_db_with_library(&configured));

        let error = invoke(
            &webview,
            "open_path_in_system",
            serde_json::json!({
                "path": elsewhere.to_string_lossy(),
                "libraryPath": elsewhere.to_string_lossy()
            }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidLibraryPath.as_str());

        let _ = fs::remove_dir_all(&configured);
        let _ = fs::remove_dir_all(&elsewhere);
    }
}
