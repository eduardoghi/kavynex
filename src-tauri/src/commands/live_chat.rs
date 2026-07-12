use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::services::library_guard::configured_library_dir;
use crate::services::live_chat_storage::{
    compress_existing_live_chat_files, list_live_chat_relative_paths, migrate_live_chat_files,
    read_live_chat_text,
};
use crate::utils::path::absolute_path_from_relative;
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

/// Resolves a library-relative path to an absolute path inside the library and reads the live
/// chat replay text (gunzipped). Extracted from the command so the resolve-then-read glue -
/// including its rejection of `..`/absolute paths via `absolute_path_from_relative` - can be
/// unit-tested without a Tauri `AppHandle`, which the command needs and the IPC mock cannot host.
fn read_live_chat_relative_sync(library_dir: &Path, relative_path: &str) -> AppResult<String> {
    let absolute = absolute_path_from_relative(library_dir, relative_path)?;
    read_live_chat_text(&absolute)
}

/// Resolves a library-relative path to an absolute path inside the library and removes the live
/// chat replay file if it exists (a missing file is a no-op). Extracted for the same reason as
/// [`read_live_chat_relative_sync`]; the caller holds the library read guard.
fn delete_live_chat_relative_sync(library_dir: &Path, relative_path: &str) -> AppResult<()> {
    let absolute = absolute_path_from_relative(library_dir, relative_path)?;

    if absolute.exists() {
        std::fs::remove_file(&absolute).map_err(|e| {
            AppError::from_code(
                AppErrorCode::RemoveMediaFailed,
                format!("failed to remove live chat file: {e}"),
            )
        })?;
    }

    Ok(())
}

/// Reads a live chat replay file from the library and returns its JSON text (gunzipped).
#[tauri::command]
pub async fn read_live_chat_file(app: AppHandle, relative_path: String) -> AppResult<String> {
    let library_dir = configured_library_dir(&app).await?;

    run_blocking(move || read_live_chat_relative_sync(&library_dir, &relative_path)).await
}

/// Deletes a live chat replay file from the library, if it exists.
#[tauri::command]
pub async fn delete_live_chat_file(app: AppHandle, relative_path: String) -> AppResult<()> {
    let library_dir = configured_library_dir(&app).await?;

    run_blocking(move || {
        // Serialize against a concurrent library migration (see services::library_lock).
        let _library_guard = crate::services::library_lock::library_read_guard();

        delete_live_chat_relative_sync(&library_dir, &relative_path)
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
    use std::path::PathBuf;
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

    #[test]
    fn read_live_chat_relative_sync_reads_a_file_inside_the_library() {
        let library = unique_library_dir("read");
        fs::write(
            library.join("live_chat").join("clip.live_chat.json"),
            b"{\"replayChatItemAction\":{}}",
        )
        .unwrap();

        let text = read_live_chat_relative_sync(&library, "live_chat/clip.live_chat.json").unwrap();
        assert_eq!(text, "{\"replayChatItemAction\":{}}");

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn read_live_chat_relative_sync_rejects_a_traversal_path() {
        let library = unique_library_dir("read-traversal");
        // A file planted outside the library must stay unreachable through a `..` path.
        fs::write(library.parent().unwrap().join("secret.json"), b"secret").unwrap();

        let error = read_live_chat_relative_sync(&library, "../secret.json").unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidRelativePath.as_str());

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn read_live_chat_relative_sync_errors_on_a_missing_file() {
        let library = unique_library_dir("read-missing");

        let result = read_live_chat_relative_sync(&library, "live_chat/missing.json");
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
}
