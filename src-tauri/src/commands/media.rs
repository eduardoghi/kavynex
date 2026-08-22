use tauri::{AppHandle, Runtime};

use crate::services::library::guard::ensure_configured_library_path;
use crate::services::media_creation::{self, CreateMediaRequest, CreatedMedia};
use crate::AppResult;

/// Creates a media: produces its artifacts, records the crash marker, inserts the row and clears
/// the marker, as one operation.
///
/// One command rather than the seven the renderer used to chain, and that is the point rather than
/// a tidy-up: the window in which artifacts exist with no row pointing at them no longer crosses the
/// process boundary, and the exclusion that keeps two creations off the same content-addressed path
/// is a lock in `library::cleanup` instead of the add-media modal refusing to open twice. See
/// `services::media_creation` for the ordering and `docs/THREAT-MODEL.md` for what that changed about the
/// trust boundary.
///
/// The library path is checked against the persisted settings here, before any file is written, like
/// every other command that writes into the library.
#[tauri::command]
pub async fn create_media<R: Runtime>(
    app: AppHandle<R>,
    request: CreateMediaRequest,
) -> AppResult<CreatedMedia> {
    ensure_configured_library_path(&app, &request.library_path).await?;

    media_creation::create_media_async(&app, request).await
}

// The rule this file holds, for a command added later: the IPC surface exposes an operation, not
// its steps. `services::pending_media`, `services::yt_dlp` and `services::library::media` hold the
// steps of a media creation, and the backend is their only caller.
//
// The crash-marker pair shows why that matters most clearly. A marker names library artifacts and
// the startup sweep acts on what it names, so a caller able to write one could name files it never
// created and have the next launch reconcile them, while a caller able to clear one could drop the
// record of a creation that really did die. The same argument, one step down, covers the download
// and the import: both write into the library, so reaching either directly produces the
// artifacts-with-no-row state this module exists to bound, with no marker behind it.
//
// See `docs/decisions/2026-07-30-ipc-exposes-operations-not-steps.md`.

// `create_media` is driven through a real IPC round trip below, under the mock runtime, and that
// was not possible until every function on its path was generic over `R: Runtime`. The bare
// `AppHandle` alias is `AppHandle<tauri::Wry>`, and `tauri::test::mock_builder` produces an
// `App<MockRuntime>`, so a command naming the alias could not even be registered with
// `tauri::generate_handler!` for a mock app (no `CommandArg<'_, MockRuntime>` impl for it). The
// services were generalized first; the commands followed, which is what the IPC test here rests on.
//
// The local-import end of the creation is the half that can run offline: a real temp library, a
// real source file, a picked thumbnail (so nothing reaches FFmpeg), and the row lands in an in-memory
// database. The yt-dlp end still cannot, for the reason `commands/yt_dlp.rs` gives: it spawns the
// binary. What the sync test below pins on top is `library::media::import_media_file_sync` on its
// own (content-addressed naming, copy vs move, reuse by hash), which is the step the command runs
// once its guard passes.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_ipc::{invoke, memory_db};
    use crate::models::yt_dlp::ImportMode;
    use crate::services::database::{set_app_settings_in_pool, Db, StoredAppSettings};
    use crate::services::library;
    use crate::utils::hash::file_hash;
    use crate::AppErrorCode;
    use std::fs;
    use std::path::{Path, PathBuf};
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::Manager;

    /// A [`Db`] whose settings name `library_dir` as the configured library and which holds one
    /// channel, returned with that channel's id. The guard on `create_media` compares the request's
    /// `library_path` against this row, so without it the command refuses before any file moves.
    fn memory_db_with_library_and_channel(library_dir: &Path) -> (Db, i64) {
        let db = memory_db();
        let library_path = library_dir.to_string_lossy().to_string();

        let channel_id = tauri::async_runtime::block_on(async {
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

            crate::services::channel_repository::insert_channel(&pool, "Channel", "@channel", None)
                .await
                .expect("insert the channel")
        });

        (db, channel_id)
    }

    fn test_webview(db: Db) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![create_media])
            .build(mock_context(noop_assets()))
            .unwrap();

        app.manage(db);

        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap()
    }

    /// The request as the renderer sends it (camelCase over IPC), for a local import with a picked
    /// thumbnail. Every field `CreateMediaRequest` has is spelled out, so a rename on the Rust side
    /// breaks here rather than silently at runtime.
    fn local_request(
        channel_id: i64,
        source: &Path,
        thumbnail: Option<&Path>,
        library: &Path,
        import_mode: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "request": {
                "channelId": channel_id,
                "title": "Imported clip",
                "sourceMode": "local",
                "sourceValue": source.to_string_lossy(),
                "thumbnailSourcePath": thumbnail.map(|path| path.to_string_lossy().to_string()),
                "mediaType": "video",
                "importMode": import_mode,
                "libraryPath": library.to_string_lossy(),
                "publishedAt": null,
                "ytDlpRunId": "ipc-create-media-test",
                "ytDlpFormatId": "",
                "ytDlpYoutubeVideoId": null,
                "downloadLiveChat": false,
                "cookiesBrowser": null,
                "cookiesPath": null
            }
        })
    }

    #[test]
    fn create_media_command_imports_a_local_file_and_registers_the_row_over_ipc() {
        // The whole operation the command exposes, end to end: the guard accepts the configured
        // library, the file is copied under its content-addressed name, the picked thumbnail is
        // persisted beside it, and the response carries the stored paths the renderer reads back.
        let root = unique_test_dir("ipc-create");
        let library = root.join("library");
        fs::create_dir_all(&library).unwrap();
        let library = library.canonicalize().unwrap();
        let source = write_temp_file(&root.join("source"), "clip.mp4", b"ipc-import-bytes");
        let cover = write_temp_file(&root.join("source"), "cover.jpg", b"\xff\xd8\xff");

        let (db, channel_id) = memory_db_with_library_and_channel(&library);
        let webview = test_webview(db);

        let response = invoke(
            &webview,
            "create_media",
            local_request(channel_id, &source, Some(&cover), &library, "copy"),
        )
        .unwrap()
        .deserialize::<serde_json::Value>()
        .unwrap();

        let file_path = response["filePath"].as_str().expect("filePath is a string");
        assert_eq!(
            file_path,
            format!("video/media_{}.mp4", file_hash(&source).unwrap()),
            "the import is content-addressed under the managed video directory"
        );
        assert!(library.join(file_path).is_file());
        assert!(source.exists(), "copy mode leaves the source where it was");

        let thumbnail_path = response["thumbnailPath"]
            .as_str()
            .expect("the picked thumbnail is persisted");
        assert!(thumbnail_path.starts_with("thumbnails/thumb_"));
        assert!(library.join(thumbnail_path).is_file());

        assert_eq!(response["mediaType"], "video");
        assert!(response["id"].is_number());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn create_media_command_rejects_a_library_that_is_not_the_configured_one_over_ipc() {
        // The guard runs before any file is written. The library the request names exists and is
        // writable, and it must still be refused because it is not the one the settings hold.
        let root = unique_test_dir("ipc-create-guard");
        let configured = root.join("configured");
        let elsewhere = root.join("elsewhere");
        fs::create_dir_all(&configured).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();
        let source = write_temp_file(&root.join("source"), "clip.mp4", b"never-imported");

        let (db, channel_id) =
            memory_db_with_library_and_channel(&configured.canonicalize().unwrap());
        let webview = test_webview(db);

        let error = invoke(
            &webview,
            "create_media",
            local_request(channel_id, &source, None, &elsewhere, "copy"),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidLibraryPath.as_str());
        assert!(
            !elsewhere.join("video").exists(),
            "nothing may be written into a library the guard refused"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn create_media_command_refuses_a_network_thumbnail_source_over_ipc() {
        // The local thumbnail branch is where the UNC refusal was missing, and this is the command
        // that carries the value in. The media file is a real local file, so only the thumbnail can
        // be what refuses the creation, and the refusal has to leave the library untouched: no
        // media copied, no row, nothing for the crash-marker sweep to reconcile.
        let root = unique_test_dir("ipc-create-unc");
        let library = root.join("library");
        fs::create_dir_all(&library).unwrap();
        let library = library.canonicalize().unwrap();
        let source = write_temp_file(&root.join("source"), "clip.mp4", b"never-imported");

        let (db, channel_id) = memory_db_with_library_and_channel(&library);
        let webview = test_webview(db);

        let error = invoke(
            &webview,
            "create_media",
            local_request(
                channel_id,
                &source,
                Some(Path::new(r"\\evil\share\cover.jpg")),
                &library,
                "copy",
            ),
        )
        .unwrap_err();

        assert_eq!(error["code"], AppErrorCode::InvalidSourceThumbnail.as_str());

        let _ = fs::remove_dir_all(&root);
    }

    fn unique_test_dir(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-media-command-test-{prefix}-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    fn write_temp_file(dir: &PathBuf, name: &str, content: &[u8]) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn import_media_file_sync_copies_into_content_addressed_path_and_keeps_source() {
        let root = unique_test_dir("copy");
        let library = root.join("library");
        let source = write_temp_file(&root.join("source"), "clip.mp4", b"copy-me");

        let relative = library::media::import_media_file_sync(
            &source.to_string_lossy(),
            ImportMode::Copy,
            &library.to_string_lossy(),
        )
        .unwrap();

        let expected_hash = file_hash(&source).unwrap();
        assert_eq!(relative, format!("video/media_{expected_hash}.mp4"));

        let destination = library.join(&relative);
        assert!(destination.exists());
        assert_eq!(fs::read(&destination).unwrap(), b"copy-me");
        // Copy mode must leave the original source file in place.
        assert!(source.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn import_media_file_sync_moves_source_into_library() {
        let root = unique_test_dir("move");
        let library = root.join("library");
        let source = write_temp_file(&root.join("source"), "clip.mp3", b"move-me");

        let relative = library::media::import_media_file_sync(
            &source.to_string_lossy(),
            ImportMode::Move,
            &library.to_string_lossy(),
        )
        .unwrap();

        assert!(relative.starts_with("audio/media_"));

        let destination = library.join(&relative);
        assert!(destination.exists());
        assert_eq!(fs::read(&destination).unwrap(), b"move-me");
        // Move mode must remove the original source file.
        assert!(!source.exists());

        let _ = fs::remove_dir_all(&root);
    }

    // Locks down the content-addressing behavior the reference-counted cleanup depends
    // on: two different source files with identical bytes converge on the same
    // destination path instead of being duplicated in the library.
    #[test]
    fn import_media_file_sync_reuses_existing_content_addressed_file() {
        let root = unique_test_dir("dedupe");
        let library = root.join("library");
        let source_dir = root.join("source");
        let first_source = write_temp_file(&source_dir, "first.mp4", b"same-bytes");
        let second_source = write_temp_file(&source_dir, "second.mp4", b"same-bytes");

        let first_relative = library::media::import_media_file_sync(
            &first_source.to_string_lossy(),
            ImportMode::Copy,
            &library.to_string_lossy(),
        )
        .unwrap();

        let second_relative = library::media::import_media_file_sync(
            &second_source.to_string_lossy(),
            ImportMode::Copy,
            &library.to_string_lossy(),
        )
        .unwrap();

        assert_eq!(first_relative, second_relative);

        let destination = library.join(&first_relative);
        assert_eq!(fs::read(&destination).unwrap(), b"same-bytes");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn import_media_file_sync_move_removes_source_when_destination_already_exists() {
        let root = unique_test_dir("move-existing");
        let library = root.join("library");

        // First import establishes the content-addressed destination.
        let first = write_temp_file(&root.join("source"), "first.mp4", b"same-bytes");
        let relative = library::media::import_media_file_sync(
            &first.to_string_lossy(),
            ImportMode::Copy,
            &library.to_string_lossy(),
        )
        .unwrap();
        let destination = library.join(&relative);
        assert!(destination.exists());

        // A second, distinct file with identical content imported in Move mode: the destination
        // already exists, but the redundant source must still be removed to complete the move.
        let second = write_temp_file(&root.join("source"), "second.mp4", b"same-bytes");
        let second_relative = library::media::import_media_file_sync(
            &second.to_string_lossy(),
            ImportMode::Move,
            &library.to_string_lossy(),
        )
        .unwrap();

        assert_eq!(second_relative, relative);
        assert!(!second.exists(), "Move must remove the redundant source");
        assert!(destination.exists());
        assert_eq!(fs::read(&destination).unwrap(), b"same-bytes");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn import_media_file_sync_rejects_missing_source_file() {
        let root = unique_test_dir("missing-source");
        let library = root.join("library");
        let missing_source = root.join("does-not-exist.mp4");

        let error = library::media::import_media_file_sync(
            &missing_source.to_string_lossy(),
            ImportMode::Copy,
            &library.to_string_lossy(),
        )
        .unwrap_err();

        assert_eq!(error.code, AppErrorCode::SourceMediaNotFound.as_str());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn import_media_file_sync_rejects_unsupported_extension() {
        let root = unique_test_dir("bad-ext");
        let library = root.join("library");
        let source = write_temp_file(&root.join("source"), "notes.txt", b"not media");

        let error = library::media::import_media_file_sync(
            &source.to_string_lossy(),
            ImportMode::Copy,
            &library.to_string_lossy(),
        )
        .unwrap_err();

        assert_eq!(error.code, AppErrorCode::UnsupportedMediaExtension.as_str());

        let _ = fs::remove_dir_all(&root);
    }
}
