use std::path::Path;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime};

use crate::constants::LIBRARY_DIR_LIVE_CHAT;
use crate::services::library::guard::configured_library_dir;
use crate::services::live_chat_storage::{
    acquire_read_permit, compress_existing_live_chat_files, list_live_chat_relative_paths,
    migrate_live_chat_files, stream_live_chat_lines, LIVE_CHAT_STREAM_BATCH_LINES,
};
use crate::utils::path::{
    absolute_path_from_relative, ensure_existing_path_inside_dir,
    ensure_relative_path_in_managed_dir, ManagedSubtree,
};
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

/// How a streamed live chat replay reaches the frontend: a run of `batch` events, each carrying a
/// slice of raw JSON lines, terminated by a single `done` event. The frontend resolves its read
/// only on `done`, never merely when the command returns. Channel messages and the invoke
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
    let absolute =
        absolute_path_from_relative(library_dir, relative_path, ManagedSubtree::LiveChat)?;
    ensure_existing_path_inside_dir(&absolute, library_dir)?;
    stream_live_chat_lines(&absolute, batch_lines, emit)
}

/// Streams a live chat replay file from the library to the frontend over `on_batch`, one batch of
/// lines at a time (transparently gunzipped), so a long replay is never materialized as one giant
/// string on either side of the IPC boundary. A terminal `Done` event follows the last batch.
#[tauri::command]
pub async fn stream_live_chat_file<R: Runtime>(
    app: AppHandle<R>,
    relative_path: String,
    on_batch: Channel<LiveChatStreamEvent>,
) -> AppResult<()> {
    let library_dir = configured_library_dir(&app).await?;

    // Bind the permit for the whole read (see live_chat_storage::acquire_read_permit). Binding it
    // (rather than writing `acquire_read_permit().await?;`) is the load-bearing part: a temporary
    // dropped at the end of its own statement would release the slot before `run_blocking` even
    // starts, leaving a gate that admits everyone and a counter that is always zero. It is taken
    // after the library guard so a request for a path that is not the configured library is refused
    // as that, rather than queueing for a slot it will not use.
    let _read_permit = acquire_read_permit().await?;

    // Deliberately does NOT take library::lock::library_read_guard(), unlike delete/migrate above.
    // That gate serializes writes and deletes against a migration's copy/remove phase, because
    // only those can lose data (a file written into the old tree between copy and remove). A pure
    // read cannot: the worst a concurrent migration does to it is move the file mid-read, which
    // surfaces as a LiveChatFileUnreadable error, never corruption. Holding a read guard for the
    // whole streamed read would instead block a migration for the entire duration of a (possibly
    // large) replay, which is worse than the transient error it would prevent. See services::library::lock.
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

/// Lists stored live chat files as library-relative paths, for diagnostics.
#[tauri::command]
pub async fn list_live_chat_files<R: Runtime>(app: AppHandle<R>) -> AppResult<Vec<String>> {
    let library_dir = configured_library_dir(&app).await?;
    run_blocking(move || list_live_chat_relative_paths(&library_dir)).await
}

/// Moves any live chat files still in the old app-data location into the library and
/// compresses legacy uncompressed files. Idempotent, so it is safe to call on every startup
/// once the library path is known.
#[tauri::command]
pub async fn migrate_live_chat_to_library<R: Runtime>(app: AppHandle<R>) -> AppResult<()> {
    let library_dir = configured_library_dir(&app).await?;

    let app_data_dir = app.path().app_data_dir().map_err(|e| {
        AppError::from_code(
            AppErrorCode::DataDirectoryResolveFailed,
            format!("failed to resolve app data directory: {e}"),
        )
    })?;

    run_blocking(move || {
        // Serialize this library write against a concurrent migration (see
        // services::library::lock). Held across both steps; neither reacquires the guard.
        let _library_guard = crate::services::library::lock::library_read_guard();

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

    fn unique_library_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kavynex-live-chat-cmd-{tag}-{}",
            crate::utils::naming::unique_temp_suffix()
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
}
