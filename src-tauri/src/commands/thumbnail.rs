use tauri::AppHandle;

use crate::constants::LIBRARY_DIR_THUMBNAILS;
use crate::services::library::guard::{
    ensure_configured_library_path, verify_library_path_then_blocking,
};
use crate::services::thumbnail;
use crate::services::thumbnail::display::{self, DisplayThumbnail};
use crate::utils::path::ensure_relative_path_in_managed_dir;
use crate::utils::task::run_blocking;
use crate::AppResult;

#[tauri::command]
pub async fn generate_temporary_thumbnail(app: AppHandle, path: String) -> AppResult<String> {
    run_blocking(move || thumbnail::generate_temporary_thumbnail_sync(&app, &path)).await
}

#[tauri::command]
pub async fn persist_thumbnail_file(
    app: AppHandle,
    path: String,
    library_path: String,
) -> AppResult<String> {
    verify_library_path_then_blocking(&app, library_path, move |library_path| {
        thumbnail::persist_thumbnail_file_sync(&path, &library_path)
    })
    .await
}

#[tauri::command]
pub async fn download_channel_avatar_from_handle(
    app: AppHandle,
    youtube_handle: String,
    library_path: String,
) -> AppResult<String> {
    ensure_configured_library_path(&app, &library_path).await?;

    thumbnail::download_channel_avatar_from_handle_async(&app, &youtube_handle, &library_path).await
}

/// Resolves display-sized copies of a page of the grid's thumbnails, generating the ones that are
/// not cached yet (see `services::thumbnail::display`).
///
/// Each entry answers the corresponding `relative_paths` entry, and "no derivative" is an ordinary
/// answer rather than a failure. The caller renders the stored thumbnail for it, which is what it
/// did before this existed. The command as a whole therefore only fails if the library path itself
/// does not check out.
///
/// The answer distinguishes a miss that is worth asking about again (`budgetSpent`) from one that is
/// final (`unavailable`), because only this side can tell them apart and the caller re-asks about
/// every path it has not settled. See [`DisplayThumbnail`] for what conflating them cost.
///
/// The library path goes through `verify_library_path_then_blocking` like every other library read,
/// so a caller cannot point this at a directory the user has not configured.
///
/// Only one of these runs at a time. The per-call budgets inside the service bound what one call may
/// do and say nothing about how many are doing it, and this request is fire-and-forget (the grid
/// asks once per page and merely discards a result it no longer wants), so nothing else stops a
/// scroll from stacking one long-running occupant of the blocking pool per page. A call that finds
/// the slot taken answers `budgetSpent` for every path it was given, which is the answer the caller
/// already re-asks about; see `services::thumbnail::display::try_reserve_resolve_slot`.
#[tauri::command]
pub async fn resolve_display_thumbnails(
    app: AppHandle,
    relative_paths: Vec<String>,
    library_path: String,
) -> AppResult<Vec<DisplayThumbnail>> {
    // Taken before the library-path check rather than after it, so a refused call costs one atomic
    // rather than a settings read. That ordering is safe only because the refusal reveals nothing: it
    // is the same answer for a valid and an invalid library path, and no path is touched either way.
    //
    // `all_retryable` bounds the answer by the module's own per-call ceiling rather than by the
    // number the caller sent, which this exit used to inherit. The one place in the module that did.
    let Some(_resolve_slot) = display::try_reserve_resolve_slot() else {
        return Ok(display::all_retryable(relative_paths.len()));
    };

    let app_for_resolve = app.clone();

    verify_library_path_then_blocking(&app, library_path, move |library_path| {
        thumbnail::resolve_display_thumbnails_sync(&app_for_resolve, &library_path, &relative_paths)
    })
    .await
}

/// Stages an image the user picked from the file dialog into the preview directory and returns its
/// path there, so the manual-thumbnail preview can be drawn without widening the asset scope to the
/// file the user chose.
///
/// The copy is what keeps the preview out of the asset scope, and it must stay that way: a
/// per-file grant is the shape this deliberately does not have. Tauri's scope offers no way to
/// withdraw a grant, so those accumulated for the whole session, and the obvious cleanup is worse
/// than the problem: a forbid outranks every later allow, so revoking a preview would make the same
/// image picked for a second media silently render nothing. Staging a copy in a directory that is
/// already authorized removes the grant entirely instead of managing it.
#[tauri::command]
pub async fn stage_manual_thumbnail(app: AppHandle, path: String) -> AppResult<String> {
    run_blocking(move || thumbnail::stage_manual_thumbnail_sync(&app, &path)).await
}

#[tauri::command]
pub async fn delete_temporary_thumbnail(app: AppHandle, path: String) -> AppResult<()> {
    run_blocking(move || thumbnail::delete_temporary_thumbnail_sync(&app, &path)).await
}

#[tauri::command]
pub async fn delete_thumbnail_file(
    app: AppHandle,
    thumbnail_path: String,
    library_path: String,
) -> AppResult<()> {
    // `verify_library_path_then_blocking` settles `library_path`, and nothing settled
    // `thumbnail_path`. `delete_thumbnail_file_sync` confines it to the library *root*
    // (`absolute_path_from_relative` plus `ensure_existing_path_inside_dir`), which stops a
    // traversal but not a bare name: `contract.docx` resolves inside the library and is unlinked.
    // The library folder is one the user picked and is not required to be empty, so that is their
    // own file, and unlike the reference-counted cleanup this path has no database check in front
    // of it at all. Requiring the managed directory is the same rule `resolve_display_thumbnails`
    // already applies to the very same kind of value (`services/thumbnail/display.rs`), and the one
    // `cleanup_unreferenced_media_artifacts` gained for the same reason.
    ensure_relative_path_in_managed_dir(&thumbnail_path, LIBRARY_DIR_THUMBNAILS)?;

    verify_library_path_then_blocking(&app, library_path, move |library_path| {
        thumbnail::delete_thumbnail_file_sync(&thumbnail_path, &library_path)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppErrorCode;

    // Every command in this file takes an `AppHandle`, so none can be driven through the
    // mock-runtime IPC harness (see the note in commands/media.rs). What is pinned here is the one
    // decision `delete_thumbnail_file` makes before any of that: which paths it will act on at all.

    #[test]
    fn deleting_a_thumbnail_accepts_only_the_managed_thumbnails_directory() {
        ensure_relative_path_in_managed_dir("thumbnails/thumb_abc.jpg", LIBRARY_DIR_THUMBNAILS)
            .expect("the layout the app writes must be accepted");
    }

    #[test]
    fn deleting_a_thumbnail_refuses_a_path_outside_the_managed_directory() {
        // The reason the guard exists. Confinement to the library root, which is all the delete
        // itself does, admits every one of these: they resolve inside the folder the user chose as
        // their library and would be unlinked with no database check in front of them.
        for path in [
            "contract.docx",
            "photos/wedding.jpg",
            // A sibling managed directory is refused too: this command deletes thumbnails, and
            // reaching a media file through it would be a different operation than the one asked
            // for. The generic managed check would have allowed these four.
            "video/media_abc.mp4",
            "audio/media_abc.mp3",
            "live_chat/media_abc.json.gz",
            // Inherited from sanitize_relative_path_strict, asserted at this entry point anyway.
            "../outside.jpg",
            "thumbnails/../../outside.jpg",
        ] {
            let Err(error) = ensure_relative_path_in_managed_dir(path, LIBRARY_DIR_THUMBNAILS)
            else {
                panic!("a path outside thumbnails/ must be refused: {path}");
            };

            assert_eq!(error.code, AppErrorCode::InvalidRelativePath.as_str());
        }
    }
}
