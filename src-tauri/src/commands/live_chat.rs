use std::path::Path;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::constants::LIBRARY_DIR_LIVE_CHAT;
use crate::services::library_guard::configured_library_dir;
use crate::services::live_chat_storage::{
    compress_existing_live_chat_files, list_live_chat_relative_paths, migrate_live_chat_files,
    stream_live_chat_lines, LIVE_CHAT_STREAM_BATCH_LINES,
};
use crate::utils::path::{
    absolute_path_from_relative, ensure_existing_path_inside_dir,
    ensure_relative_path_in_managed_dir,
};
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

/// How a streamed live chat replay reaches the frontend: a run of `batch` events, each carrying a
/// slice of raw JSON lines, terminated by a single `done` event. The frontend resolves its read
/// only on `done`, never merely when the command returns - channel messages and the invoke
/// response travel independently, so resolving on the return could race the last in-flight batch.
/// The generated binding (`src/types/generated/LiveChatStreamEvent.ts`) is what the frontend's
/// zod schema in `lib/ipc-schemas.ts` is checked against, so a change here fails `tsc` there
/// instead of silently desyncing the wire shape.
#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum LiveChatStreamEvent {
    Batch { lines: Vec<String> },
    Done,
}

/// Resolves a library-relative path to an absolute path inside the library and streams the live
/// chat replay (gunzipped) to `emit`, one batch of lines at a time. Extracted from the command so
/// the resolve-then-stream glue can be unit-tested without a Tauri `AppHandle`/`Channel`, which the
/// command needs and the IPC mock cannot host.
///
/// Two containment checks run before the file is touched, matching the sibling media/thumbnail
/// paths: the relative path is scoped to the `live_chat/` subtree (so this command cannot be
/// repointed at a video/audio/thumbnail file), and `ensure_existing_path_inside_dir` re-resolves
/// symlinks and re-checks containment (`absolute_path_from_relative` only rejects `..`/absolute
/// components lexically, so an intermediate symlink component pointing outside the library would
/// otherwise let this read a file outside the managed tree).
fn stream_live_chat_relative_sync<F>(
    library_dir: &Path,
    relative_path: &str,
    batch_lines: usize,
    emit: F,
) -> AppResult<()>
where
    F: FnMut(Vec<String>) -> AppResult<()>,
{
    ensure_relative_path_in_managed_dir(relative_path, LIBRARY_DIR_LIVE_CHAT)?;
    let absolute = absolute_path_from_relative(library_dir, relative_path)?;
    ensure_existing_path_inside_dir(&absolute, library_dir)?;
    stream_live_chat_lines(&absolute, batch_lines, emit)
}

/// Resolves a library-relative path to an absolute path inside the library and removes the live
/// chat replay file if it exists (a missing file is a no-op). Extracted for the same reason as
/// [`read_live_chat_relative_sync`]; the caller holds the library read guard.
fn delete_live_chat_relative_sync(library_dir: &Path, relative_path: &str) -> AppResult<()> {
    // Scope to the live_chat/ subtree so this delete cannot be repointed at a video/audio/thumbnail
    // file (the raw relative_path comes straight from IPC).
    ensure_relative_path_in_managed_dir(relative_path, LIBRARY_DIR_LIVE_CHAT)?;

    let absolute = absolute_path_from_relative(library_dir, relative_path)?;

    if absolute.exists() {
        // Re-resolve symlinks and re-check containment before unlinking, matching
        // delete_media_file_sync / delete_thumbnail_file_sync: absolute_path_from_relative only does
        // a lexical check, so an intermediate symlink component pointing outside the library would
        // otherwise let this remove a file outside the managed tree.
        ensure_existing_path_inside_dir(&absolute, library_dir)?;

        std::fs::remove_file(&absolute).map_err(|e| {
            AppError::from_code(
                AppErrorCode::RemoveMediaFailed,
                format!("failed to remove live chat file: {e}"),
            )
        })?;
    }

    Ok(())
}

/// Streams a live chat replay file from the library to the frontend over `on_batch`, one batch of
/// lines at a time (transparently gunzipped), so a long replay is never materialized as one giant
/// string on either side of the IPC boundary. A terminal `Done` event follows the last batch.
#[tauri::command]
pub async fn stream_live_chat_file(
    app: AppHandle,
    relative_path: String,
    on_batch: Channel<LiveChatStreamEvent>,
) -> AppResult<()> {
    let library_dir = configured_library_dir(&app).await?;

    // Deliberately does NOT take library_lock::library_read_guard(), unlike delete/migrate above.
    // That gate serializes writes and deletes against a migration's copy/remove phase, because
    // only those can lose data (a file written into the old tree between copy and remove). A pure
    // read cannot: the worst a concurrent migration does to it is move the file mid-read, which
    // surfaces as a LiveChatFileUnreadable error, never corruption. Holding a read guard for the
    // whole streamed read would instead block a migration for the entire duration of a (possibly
    // large) replay, which is worse than the transient error it would prevent. See services::library_lock.
    run_blocking(move || {
        stream_live_chat_relative_sync(
            &library_dir,
            &relative_path,
            LIVE_CHAT_STREAM_BATCH_LINES,
            |lines| {
                on_batch
                    .send(LiveChatStreamEvent::Batch { lines })
                    .map_err(|error| {
                        AppError::from_code(
                            AppErrorCode::LiveChatFileUnreadable,
                            format!("failed to stream live chat batch: {error}"),
                        )
                    })
            },
        )?;

        on_batch.send(LiveChatStreamEvent::Done).map_err(|error| {
            AppError::from_code(
                AppErrorCode::LiveChatFileUnreadable,
                format!("failed to signal live chat stream completion: {error}"),
            )
        })
    })
    .await
}

/// Rewords a failed unlink after the database reference was already cleared: a bare "failed to
/// remove" reads as "nothing happened, retry the delete", when the entry is in fact gone and the
/// file (if still present) is an orphan for the library diagnostics to reconcile. Only the unlink
/// failure is reworded - a containment rejection happens before anything is touched and keeps its
/// own error. Extracted from the command so the code gate is unit-testable (the command itself
/// needs an AppHandle the IPC mock cannot host).
fn reword_unlink_error_after_reference_clear(error: AppError) -> AppError {
    if error.code == AppErrorCode::RemoveMediaFailed.as_str() {
        AppError::from_code(
            AppErrorCode::RemoveMediaFailed,
            format!(
                "the live chat entry was removed from the library, but its file could \
                 not be deleted and was left behind - run Diagnostics to clean it up \
                 ({})",
                error.message
            ),
        )
    } else {
        error
    }
}

/// Deletes a live chat replay file from the library, if it exists, and clears the live-chat columns
/// on the video row that referenced it.
#[tauri::command]
pub async fn delete_live_chat_file(app: AppHandle, relative_path: String) -> AppResult<()> {
    let library_dir = configured_library_dir(&app).await?;
    let pool = crate::services::database::shared_pool(&app).await?;

    // Clear the referencing row's live-chat columns before removing the file. A crash between the
    // two steps then leaves only an orphaned file (which the library diagnostics reconcile), never a
    // row flagged has_live_chat = 1 pointing at a deleted file - a path-without-file state the v13
    // CHECK constraint does not catch.
    crate::services::video_repository::clear_live_chat_reference(&pool, relative_path.trim()).await?;

    run_blocking(move || {
        // Serialize against a concurrent library migration (see services::library_lock).
        let _library_guard = crate::services::library_lock::library_read_guard();

        delete_live_chat_relative_sync(&library_dir, &relative_path)
            .map_err(reword_unlink_error_after_reference_clear)
    })
    .await
}

/// Lists stored live chat files as library-relative paths, for diagnostics.
#[tauri::command]
pub async fn list_live_chat_files(app: AppHandle) -> AppResult<Vec<String>> {
    let library_dir = configured_library_dir(&app).await?;
    run_blocking(move || list_live_chat_relative_paths(&library_dir)).await
}

/// Moves any live chat files still in the old app-data location into the library and
/// compresses legacy uncompressed files. Idempotent, so it is safe to call on every startup
/// once the library path is known.
#[tauri::command]
pub async fn migrate_live_chat_to_library(app: AppHandle) -> AppResult<()> {
    let library_dir = configured_library_dir(&app).await?;

    let app_data_dir = app.path().app_data_dir().map_err(|e| {
        AppError::from_code(
            AppErrorCode::DataDirectoryResolveFailed,
            format!("failed to resolve app data directory: {e}"),
        )
    })?;

    run_blocking(move || {
        // Serialize this library write against a concurrent migration (see
        // services::library_lock). Held across both steps; neither reacquires the guard.
        let _library_guard = crate::services::library_lock::library_read_guard();

        migrate_live_chat_files(&app_data_dir, &library_dir)?;
        compress_existing_live_chat_files(&library_dir.join("live_chat"))?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_library_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        let dir = std::env::temp_dir().join(format!(
            "kavynex-live-chat-cmd-{tag}-{}-{}",
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(dir.join("live_chat")).unwrap();
        dir
    }

    /// Collects every streamed line from the resolve-then-stream glue into one vector.
    fn collect_relative(library: &Path, relative_path: &str) -> AppResult<Vec<String>> {
        let mut lines = Vec::new();

        stream_live_chat_relative_sync(library, relative_path, 500, |batch| {
            lines.extend(batch);
            Ok(())
        })?;

        Ok(lines)
    }

    #[test]
    fn live_chat_stream_event_serializes_to_the_shape_the_frontend_expects() {
        // The wire contract the tests mock away: this must match the LiveChatStreamEvent union in
        // lib/tauri-client.ts exactly, or the frontend's channel handler would misread every batch.
        let batch = serde_json::to_value(LiveChatStreamEvent::Batch {
            lines: vec!["a".to_string(), "b".to_string()],
        })
        .unwrap();
        assert_eq!(
            batch,
            serde_json::json!({ "kind": "batch", "lines": ["a", "b"] })
        );

        let done = serde_json::to_value(LiveChatStreamEvent::Done).unwrap();
        assert_eq!(done, serde_json::json!({ "kind": "done" }));
    }

    #[test]
    fn stream_live_chat_relative_sync_reads_a_file_inside_the_library() {
        let library = unique_library_dir("read");
        fs::write(
            library.join("live_chat").join("clip.live_chat.json"),
            b"{\"replayChatItemAction\":{}}\n",
        )
        .unwrap();

        let lines = collect_relative(&library, "live_chat/clip.live_chat.json").unwrap();
        assert_eq!(lines, vec!["{\"replayChatItemAction\":{}}".to_string()]);

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn stream_live_chat_relative_sync_rejects_a_traversal_path() {
        let library = unique_library_dir("read-traversal");
        // A file planted outside the library must stay unreachable through a `..` path.
        fs::write(library.parent().unwrap().join("secret.json"), b"secret").unwrap();

        let error = collect_relative(&library, "../secret.json").unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidRelativePath.as_str());

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn stream_live_chat_relative_sync_errors_on_a_missing_file() {
        let library = unique_library_dir("read-missing");

        let result = collect_relative(&library, "live_chat/missing.json");
        assert!(result.is_err());

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn delete_live_chat_relative_sync_removes_an_existing_file() {
        let library = unique_library_dir("delete");
        let file = library.join("live_chat").join("clip.live_chat.json");
        fs::write(&file, b"{}").unwrap();

        delete_live_chat_relative_sync(&library, "live_chat/clip.live_chat.json").unwrap();
        assert!(!file.exists());

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn delete_live_chat_relative_sync_is_a_no_op_for_a_missing_file() {
        let library = unique_library_dir("delete-missing");

        // Deleting a file that is not there succeeds without error (idempotent).
        delete_live_chat_relative_sync(&library, "live_chat/missing.json").unwrap();

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn delete_live_chat_relative_sync_rejects_a_traversal_path() {
        let library = unique_library_dir("delete-traversal");
        let outside = library.parent().unwrap().join("keep.json");
        fs::write(&outside, b"keep").unwrap();

        let error = delete_live_chat_relative_sync(&library, "../keep.json").unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidRelativePath.as_str());
        // The traversal was rejected before any removal, so the outside file is untouched.
        assert!(outside.exists());

        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn a_failed_unlink_is_reworded_after_the_reference_was_cleared() {
        let error = AppError::from_code(
            AppErrorCode::RemoveMediaFailed,
            "failed to remove live chat file: access denied",
        );

        let reworded = reword_unlink_error_after_reference_clear(error);
        assert_eq!(reworded.code, AppErrorCode::RemoveMediaFailed.as_str());
        assert!(
            reworded.message.contains("was removed from the library"),
            "the message must say the reference is already gone: {}",
            reworded.message
        );
        assert!(reworded.message.contains("access denied"));
    }

    #[test]
    fn a_containment_rejection_keeps_its_own_error() {
        let error = AppError::from_code(AppErrorCode::InvalidRelativePath, "path escapes library");

        let unchanged = reword_unlink_error_after_reference_clear(error);
        assert_eq!(unchanged.code, AppErrorCode::InvalidRelativePath.as_str());
        assert_eq!(unchanged.message, "path escapes library");
    }

    #[test]
    fn stream_live_chat_relative_sync_rejects_a_non_live_chat_managed_path() {
        // A path inside the library but outside live_chat/ (a real media file) must be rejected:
        // the command must not double as a reader for arbitrary library files.
        let library = unique_library_dir("read-scope");
        fs::create_dir_all(library.join("video")).unwrap();
        fs::write(library.join("video").join("media.mp4"), b"data").unwrap();

        let error = collect_relative(&library, "video/media.mp4").unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidRelativePath.as_str());

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn delete_live_chat_relative_sync_rejects_a_non_live_chat_managed_path() {
        // The delete must not be repointable at a video/audio/thumbnail file.
        let library = unique_library_dir("delete-scope");
        fs::create_dir_all(library.join("video")).unwrap();
        let file = library.join("video").join("media.mp4");
        fs::write(&file, b"data").unwrap();

        let error = delete_live_chat_relative_sync(&library, "video/media.mp4").unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidRelativePath.as_str());
        assert!(file.exists(), "a non-live-chat file must not be deleted");

        let _ = fs::remove_dir_all(&library);
    }
}
