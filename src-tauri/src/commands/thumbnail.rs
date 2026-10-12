use tauri::{AppHandle, Runtime};

use crate::services::chosen_files::{self, ChosenFile};
use crate::services::library::guard::{
    configured_library_path, with_configured_library_then_blocking,
};
use crate::services::thumbnail;
use crate::services::thumbnail::display::{self, DisplayThumbnail};
use crate::utils::task::run_blocking;
use crate::AppResult;

#[tauri::command]
pub async fn generate_temporary_thumbnail<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> AppResult<String> {
    chosen_files::ensure_chosen(ChosenFile::Source, &path)?;

    // Each preview hashes the whole source and can run FFmpeg for up to a minute on the blocking
    // pool every other command offloads to. Bounded like every other place that starts a child.
    let _permit = PREVIEW_SEMAPHORE
        .acquire(crate::AppErrorCode::TooManyConcurrentMediaJobs)
        .await?;

    let preview =
        run_blocking(move || thumbnail::generate_temporary_thumbnail_sync(&app, &path)).await?;

    // The add-media form hands the preview back as the media's thumbnail.
    chosen_files::record(ChosenFile::Source, &preview);

    Ok(preview)
}

static PREVIEW_SEMAPHORE: crate::utils::bounded_semaphore::BoundedSemaphore =
    crate::utils::bounded_semaphore::BoundedSemaphore::new(2, 4);

#[tauri::command]
pub async fn persist_thumbnail_file<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> AppResult<String> {
    chosen_files::ensure_chosen(ChosenFile::Source, &path)?;

    with_configured_library_then_blocking(&app, move |library_path| {
        thumbnail::persist_thumbnail_file_sync(&path, &library_path)
    })
    .await
}

#[tauri::command]
pub async fn download_channel_avatar_from_handle<R: Runtime>(
    app: AppHandle<R>,
    youtube_handle: String,
) -> AppResult<String> {
    let library_path = configured_library_path(&app).await?;

    thumbnail::download_channel_avatar_from_handle_async(&app, &youtube_handle, &library_path).await
}

/// Resolves display-sized copies of a page of the grid's thumbnails, generating the ones that are
/// not cached yet (see `services::thumbnail::display`).
///
/// Each entry answers the corresponding `relative_paths` entry, and "no derivative" is an ordinary
/// answer rather than a failure. The caller renders the stored thumbnail for it, which is what it
/// did before this existed. The command as a whole therefore only fails when no library is
/// configured.
///
/// The answer distinguishes a miss that is worth asking about again (`budgetSpent`) from one that is
/// final (`unavailable`), because only this side can tell them apart and the caller re-asks about
/// every path it has not settled. See [`DisplayThumbnail`] for what conflating them cost.
///
/// Only one of these runs at a time. The per-call budgets inside the service bound what one call may
/// do and say nothing about how many are doing it, and this request is fire-and-forget (the grid
/// asks once per page and merely discards a result it no longer wants), so nothing else stops a
/// scroll from stacking one long-running occupant of the blocking pool per page. A call that finds
/// the slot taken answers `budgetSpent` for every path it was given, which is the answer the caller
/// already re-asks about; see `services::thumbnail::display::try_reserve_resolve_slot`.
#[tauri::command]
pub async fn resolve_display_thumbnails<R: Runtime>(
    app: AppHandle<R>,
    relative_paths: Vec<String>,
) -> AppResult<Vec<DisplayThumbnail>> {
    // Taken before the settings read rather than after it, so a refused call costs one atomic.
    //
    // `all_retryable` bounds the answer by the module's own per-call ceiling rather than by the
    // number the caller sent. Inheriting the caller's number here would make this the one place in
    // the module that did.
    let Some(_resolve_slot) = display::try_reserve_resolve_slot() else {
        return Ok(display::all_retryable(relative_paths.len()));
    };

    let app_for_resolve = app.clone();

    with_configured_library_then_blocking(&app, move |library_path| {
        thumbnail::resolve_display_thumbnails_sync(&app_for_resolve, &library_path, &relative_paths)
    })
    .await
}

/// Stages an image the user picked from the file dialog into the preview directory and returns its
/// path there, so the manual-thumbnail preview can be drawn without widening the asset scope to the
/// file the user chose.
///
/// The copy is what keeps the preview out of the asset scope, and it must stay that way. A
/// per-file grant is the shape this deliberately does not have. Tauri's scope offers no way to
/// withdraw a grant, so those accumulated for the whole session, and the obvious cleanup is worse
/// than the problem. A forbid outranks every later allow, so revoking a preview would make the same
/// image picked for a second media silently render nothing. Staging a copy in a directory that is
/// already authorized removes the grant entirely instead of managing it.
#[tauri::command]
pub async fn stage_manual_thumbnail<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> AppResult<String> {
    chosen_files::ensure_chosen(ChosenFile::Source, &path)?;

    let staged = run_blocking(move || thumbnail::stage_manual_thumbnail_sync(&app, &path)).await?;

    chosen_files::record(ChosenFile::Source, &staged);

    Ok(staged)
}

#[tauri::command]
pub async fn delete_temporary_thumbnail<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> AppResult<()> {
    run_blocking(move || thumbnail::delete_temporary_thumbnail_sync(&app, &path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_ipc::{invoke, memory_db};
    use crate::constants::LIBRARY_DIR_THUMBNAILS;
    use crate::services::database::{set_app_settings_in_pool, Db, StoredAppSettings};
    use crate::AppErrorCode;
    use std::fs;
    use std::path::{Path, PathBuf};
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::Manager;

    fn unique_test_dir(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-thumbnail-command-test-{prefix}-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

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
            .invoke_handler(tauri::generate_handler![persist_thumbnail_file])
            .build(mock_context(noop_assets()))
            .unwrap();

        app.manage(db);

        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap()
    }

    #[test]
    fn persist_thumbnail_file_command_copies_a_picked_image_into_the_library_over_ipc() {
        let root = unique_test_dir("persist");
        let library = root.join("library");
        fs::create_dir_all(&library).unwrap();
        let library = library.canonicalize().unwrap();
        let picked = root.join("picked.png");
        fs::create_dir_all(&root).unwrap();
        fs::write(&picked, b"\x89PNG\r\n\x1a\n").unwrap();
        chosen_files::record(ChosenFile::Source, &picked.to_string_lossy());

        let webview = test_webview(memory_db_with_library(&library));

        let stored = invoke(
            &webview,
            "persist_thumbnail_file",
            serde_json::json!({
                "path": picked.to_string_lossy(),
                "libraryPath": library.to_string_lossy()
            }),
        )
        .unwrap()
        .deserialize::<String>()
        .unwrap();

        assert!(stored.starts_with("thumbnails/thumb_") && stored.ends_with(".png"));
        assert!(library.join(&stored).is_file());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn persist_thumbnail_file_command_refuses_a_network_source_over_ipc() {
        // The parameter arrives raw over IPC, so stat-ing it before any check would touch a
        // caller-supplied path. The library is the configured one, so only the source can be what
        // refuses, and the refusal must come before the library's managed directory is created.
        let root = unique_test_dir("persist-unc");
        let library = root.join("library");
        fs::create_dir_all(&library).unwrap();
        let library = library.canonicalize().unwrap();

        let webview = test_webview(memory_db_with_library(&library));

        // Picked, so the network gate is what refuses it. A picker can return a network path.
        chosen_files::record(ChosenFile::Source, r"\\evil\share\cover.jpg");

        let error = invoke(
            &webview,
            "persist_thumbnail_file",
            serde_json::json!({
                "path": r"\\evil\share\cover.jpg",
                "libraryPath": library.to_string_lossy()
            }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidSourceThumbnail.as_str());
        assert!(!library.join(LIBRARY_DIR_THUMBNAILS).exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn persist_thumbnail_file_command_refuses_an_image_that_was_never_picked_over_ipc() {
        let root = unique_test_dir("persist-unpicked");
        let library = root.join("library");
        fs::create_dir_all(&library).unwrap();
        let library = library.canonicalize().unwrap();
        let unpicked = root.join("unpicked.png");
        fs::write(&unpicked, b"\x89PNG\r\n\x1a\n").unwrap();

        let webview = test_webview(memory_db_with_library(&library));

        let error = invoke(
            &webview,
            "persist_thumbnail_file",
            serde_json::json!({
                "path": unpicked.to_string_lossy(),
                "libraryPath": library.to_string_lossy()
            }),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidInput.as_str());
        assert!(!library.join(LIBRARY_DIR_THUMBNAILS).exists());

        let _ = fs::remove_dir_all(&root);
    }
}
