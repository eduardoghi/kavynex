use tauri::AppHandle;

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
pub async fn create_media(app: AppHandle, request: CreateMediaRequest) -> AppResult<CreatedMedia> {
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

// No command in this file can be driven through a true IPC round trip with the
// harness `commands/library.rs` uses (`tauri::test::mock_builder` + `get_ipc_response`).
// Each takes an `app: AppHandle` parameter, and `AppHandle` resolves (via its default
// generic parameter) to the concrete type `AppHandle<tauri::Wry>`. The real runtime.
// `mock_builder()` builds an `App<tauri::test::MockRuntime>`, a different concrete
// runtime, so registering any of them with `tauri::generate_handler!` for that app
// fails to *compile*: there is no `CommandArg<'_, MockRuntime>` impl for
// `AppHandle<Wry>`. (This is exactly why `library.rs`'s existing IPC tests only cover
// `ensure_directory_exists` and `check_library_integrity` (the only two commands in
// that file with no `AppHandle` parameter.) The same mismatch means the underlying
// async service functions (`library::media`/`library::cleanup`/`media_creation`) cannot be
// called directly with a mock `AppHandle` either, since their signatures take the same
// concrete type.
//
// The runtime mismatch above is the whole of it: the database is no longer the obstacle.
// The pool lives in managed state (`services::database::Db`, registered by `lib.rs`'s
// setup and resolved through `try_state`), and `Db::from_pool` exists precisely so a test
// can manage a `Db` backed by an in-memory schema onto a mock app), which is how the
// pool-only commands (`settings.rs`, `channels.rs`, `videos.rs`, `database.rs`) are driven
// through the real IPC boundary today. What keeps *these* commands out is only their
// `AppHandle` parameter, not where their settings come from.
//
// `create_media`'s own shape follows from that: the decisions it makes that a test can pin
// are pure and live in `services::media_creation` (request normalization, thumbnail-source
// classification, the managed-path re-check), tested there; what is left in the command is
// the library-path guard plus the orchestration, and neither can run without a live handle.
//
// What *is* tested below is `library::media::import_media_file_sync` (a plain sync
// function taking only `&str`/`ImportMode` arguments (no `AppHandle`)), which is exactly
// what `import_media_file` runs inside `run_blocking` once its guard passes, and what a
// local `create_media` runs to place the file. This locks down that behavior:
// content-addressed destination naming, copy vs. move, and reuse of an already-imported
// file by content hash.
#[cfg(test)]
mod tests {
    use crate::models::yt_dlp::ImportMode;
    use crate::services::library;
    use crate::utils::hash::file_hash;
    use crate::AppErrorCode;
    use std::fs;
    use std::path::PathBuf;

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
