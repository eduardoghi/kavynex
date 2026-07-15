use tauri::AppHandle;

use crate::models::yt_dlp::ImportMode;
use crate::services::library_cleanup::{self, ArtifactCleanupReport};
use crate::services::library_guard::verify_library_path_then_blocking;
use crate::services::library_media;
use crate::AppResult;

#[tauri::command]
pub async fn import_media_file(
    app: AppHandle,
    path: String,
    mode: ImportMode,
    library_path: String,
) -> AppResult<String> {
    verify_library_path_then_blocking(&app, library_path, move |library_path| {
        library_media::import_media_file_sync(&path, mode, &library_path)
    })
    .await
}

/// Removes on-disk artifacts (media file, thumbnail, live chat replay) that were prepared for
/// a media creation which never inserted a row, deleting each only when no registered row
/// still references it. The reference count and the unlink happen in one command, so the
/// frontend cannot interleave another operation between them. The library directory is
/// re-derived from the persisted settings, so no untrusted base path is accepted here.
#[tauri::command]
pub async fn cleanup_unreferenced_media_artifacts(
    app: AppHandle,
    file_path: Option<String>,
    thumbnail_path: Option<String>,
    live_chat_file_path: Option<String>,
) -> AppResult<ArtifactCleanupReport> {
    library_cleanup::cleanup_unreferenced_artifacts(
        &app,
        file_path,
        thumbnail_path,
        live_chat_file_path,
    )
    .await
}

// Neither command in this file can be driven through a true IPC round trip with the
// harness `commands/library.rs` uses (`tauri::test::mock_builder` + `get_ipc_response`).
// Both take an `app: AppHandle` parameter, and `AppHandle` resolves (via its default
// generic parameter) to the concrete type `AppHandle<tauri::Wry>` - the real runtime.
// `mock_builder()` builds an `App<tauri::test::MockRuntime>`, a different concrete
// runtime, so registering either command with `tauri::generate_handler!` for that app
// fails to *compile*: there is no `CommandArg<'_, MockRuntime>` impl for
// `AppHandle<Wry>`. (This is exactly why `library.rs`'s existing IPC tests only cover
// `ensure_directory_exists` and `check_library_integrity` - the only two commands in
// that file with no `AppHandle` parameter.) The same mismatch means the underlying
// async service functions (`library_media`/`library_cleanup`) cannot be called directly
// with a mock `AppHandle` either, since their signatures take the same concrete type.
//
// The runtime mismatch above is the whole of it: the database is no longer the obstacle.
// The pool lives in managed state (`services::database::Db`, registered by `lib.rs`'s
// setup and resolved through `try_state`), and `Db::from_pool` exists precisely so a test
// can manage a `Db` backed by an in-memory schema onto a mock app - which is how the
// pool-only commands (`settings.rs`, `channels.rs`, `videos.rs`, `database.rs`) are driven
// through the real IPC boundary today. What keeps *these two* commands out is only their
// `AppHandle` parameter, not where their settings come from.
//
// `cleanup_unreferenced_media_artifacts`'s reference-counting behavior (a file shared by
// two rows is kept, an unreferenced one is deleted) is already covered thoroughly at the
// service layer by the existing tests in `services/library_cleanup.rs`
// (`cleanup_plan_deletes_orphan_artifacts_no_row_references`,
// `cleanup_plan_keeps_artifacts_still_referenced_by_a_registered_row`, etc.), which build
// their own in-memory sqlite pool and call the plan/cleanup functions directly instead of
// going through `shared_pool`.
//
// What *is* tested below is `library_media::import_media_file_sync` - a plain sync
// function taking only `&str`/`ImportMode` arguments (no `AppHandle`) - which is exactly
// what `import_media_file` runs inside `run_blocking` once its guard passes. This locks
// down the command's actual behavior: content-addressed destination naming, copy vs.
// move, and reuse of an already-imported file by content hash.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::hash::file_hash;
    use crate::AppErrorCode;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "kavynex-media-command-test-{}-{}-{}",
            prefix,
            std::process::id(),
            nanos
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

        let relative = library_media::import_media_file_sync(
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

        let relative = library_media::import_media_file_sync(
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

        let first_relative = library_media::import_media_file_sync(
            &first_source.to_string_lossy(),
            ImportMode::Copy,
            &library.to_string_lossy(),
        )
        .unwrap();

        let second_relative = library_media::import_media_file_sync(
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
        let relative = library_media::import_media_file_sync(
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
        let second_relative = library_media::import_media_file_sync(
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

        let error = library_media::import_media_file_sync(
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

        let error = library_media::import_media_file_sync(
            &source.to_string_lossy(),
            ImportMode::Copy,
            &library.to_string_lossy(),
        )
        .unwrap_err();

        assert_eq!(error.code, AppErrorCode::UnsupportedMediaExtension.as_str());

        let _ = fs::remove_dir_all(&root);
    }
}
