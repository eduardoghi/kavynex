//! What a download stores after its media is in the library. The live chat replay and the
//! thumbnail, both best effort, since the media is what the user asked for and outlives either.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use tauri::{AppHandle, Runtime};

use crate::models::yt_dlp::YtDlpMetadata;
use crate::services::logger;
use crate::services::thumbnail::download::download_media_thumbnail_async;
use crate::services::yt_dlp::events::emit_download_log_infallible;
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

/// The live chat replay yt-dlp finished writing for `file_prefix`, if there is one.
///
/// Only a name ending in `.json`. A replay cut short leaves `.part` or `.ytdl` files beside it, and
/// storing one of those as the replay kept the broken copy for good, since a later download never
/// replaces a replay that is already stored.
pub(super) fn find_live_chat_temp_file(temp_dir: &Path, file_prefix: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(temp_dir).ok()?;

    for entry in entries.flatten() {
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        let file_name = path.file_name()?.to_string_lossy().to_string();
        let normalized_name = file_name.to_lowercase();

        if normalized_name.starts_with(&file_prefix.to_lowercase())
            && normalized_name.contains("live_chat")
            && normalized_name.ends_with(".json")
        {
            return Some(path);
        }
    }

    None
}

/// Where the library keeps live chat replays. Not created here (see [`store_live_chat`]).
pub(super) fn live_chat_dir_in(library_dir: &Path) -> PathBuf {
    library_dir.join("live_chat")
}

pub(super) fn build_live_chat_relative_path(file_name: &Path) -> String {
    Path::new("live_chat")
        .join(file_name)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Downloads the media's thumbnail, and on failure says so in the terminal and returns `None`.
///
/// The error is shown rather than only logged because a media saved without the thumbnail the user
/// expected is otherwise silent, and the reason (a CDN outage, a firewall) is something they can
/// act on.
pub(super) async fn download_thumbnail_best_effort<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    library_path: &str,
    metadata: &YtDlpMetadata,
    cancel_flag: &AtomicBool,
) -> Option<String> {
    match download_media_thumbnail_async(app, library_path, metadata, Some(cancel_flag)).await {
        Ok(Some(path)) => {
            emit_download_log_infallible(
                app,
                run_id,
                "Thumbnail downloaded successfully",
                "system",
            );
            Some(path)
        }
        // The search also ends early on a cancel, which says nothing about the video.
        Ok(None) if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) => None,
        Ok(None) => {
            emit_download_log_infallible(
                app,
                run_id,
                "No thumbnail available for this media",
                "system",
            );
            None
        }
        Err(error) => {
            logger::warn(
                "yt_dlp",
                format!("thumbnail download failed, saving the media without one: {error}"),
            );
            emit_download_log_infallible(
                app,
                run_id,
                format!(
                    "The thumbnail could not be downloaded, so the media was saved without one: {}",
                    error.message
                ),
                "system",
            );
            None
        }
    }
}

/// Stores the stream's live chat replay in the library, and on failure says so in the terminal and
/// returns `None`, the way the thumbnail does.
///
/// It runs once the media is already in the library. Failing the whole creation over it (a replay
/// past the decompression ceiling, a full disk) used to leave a download of hours in `video/` with
/// no row and no crash marker to clean it up, and the user with an error for a video that had
/// arrived. The replay is the smaller loss of the two.
pub(super) async fn store_live_chat_best_effort<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    temp_dir: &Path,
    file_prefix: &str,
    live_chat_dir: Option<&Path>,
) -> Option<String> {
    match store_live_chat(app, run_id, temp_dir, file_prefix, live_chat_dir).await {
        Ok(path) => path,
        Err(error) => {
            logger::warn(
                "yt_dlp",
                format!(
                    "live chat replay could not be stored, saving the media without it: {error}"
                ),
            );
            emit_download_log_infallible(
                app,
                run_id,
                format!(
                    "The live chat replay could not be saved, so the media was saved without it: {}",
                    error.message
                ),
                "system",
            );
            None
        }
    }
}

/// The library-relative path of the stored replay, or `None` when yt-dlp wrote none.
pub(super) async fn store_live_chat<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    temp_dir: &Path,
    file_prefix: &str,
    live_chat_dir: Option<&Path>,
) -> AppResult<Option<String>> {
    let Some(temp_live_chat_file) = find_live_chat_temp_file(temp_dir, file_prefix) else {
        return Ok(None);
    };

    let live_chat_file_name = temp_live_chat_file.file_name().ok_or_else(|| {
        AppError::from_code(
            AppErrorCode::InvalidDownloadedFile,
            "live chat file has no valid name",
        )
    })?;

    let live_chat_dir = live_chat_dir.ok_or_else(|| {
        AppError::from_code(
            AppErrorCode::DataDirectoryResolveFailed,
            "app live chat directory was not initialized",
        )
    })?;

    let final_live_chat_destination = live_chat_dir.join(live_chat_file_name);

    // Store live chat replays gzip-compressed to save disk; the frontend reader transparently
    // decompresses them. On the blocking pool, since a long stream's replay is tens of MB to gzip
    // and that held an async runtime thread for the whole compression. Serialize this library write
    // against a concurrent migration (see library::lock); the guard lives inside the blocking
    // closure, never across an await.
    let kept_existing_live_chat = {
        let source = temp_live_chat_file.clone();
        let destination = final_live_chat_destination.clone();

        run_blocking(move || {
            let _library_guard = crate::services::library::lock::library_read_guard();

            // Created now, and only inside a library folder that is still there.
            if let Some(dir) = destination.parent() {
                let library_dir = dir.parent().unwrap_or(dir);

                crate::services::library::paths::create_dir_in_existing_library(library_dir, dir)
                    .map_err(|error| {
                    AppError::from_code(
                        AppErrorCode::CreateDirectoryFailed,
                        format!("failed to create live chat directory: {error}"),
                    )
                })?;
            }

            // Never overwrite an already-stored replay, matching place_downloaded_file's "keep the
            // catalogued bytes" rule for the main media file. The name is deterministic per
            // video+run, so an existing file is the same replay; without this guard
            // compress_file_to (via replace_file_safely) would silently discard it on a
            // re-download.
            if destination.exists() {
                return Ok(true);
            }

            crate::services::live_chat_storage::compress_file_to(&source, &destination)?;
            Ok(false)
        })
        .await?
    };

    if kept_existing_live_chat {
        // Same visibility rule as the kept-existing media log. Keeping the stored replay is
        // correct, but doing it silently reads as "the fresh replay was saved" when it was
        // discarded.
        emit_download_log_infallible(
            app,
            run_id,
            "A live chat replay for this video already existed in the library; kept the existing copy and discarded the new one.",
            "system",
        );
    }

    Ok(Some(build_live_chat_relative_path(Path::new(
        live_chat_file_name,
    ))))
}
