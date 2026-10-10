//! Putting a finished download into the library, and keeping it when that fails.
//!
//! Split out of `download/mod.rs` so the steps that decide where a downloaded file ends up, and
//! what happens to it when it cannot get there, read apart from the process supervision. Every
//! one of them runs after yt-dlp has exited and before the run reports success.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Runtime};

use crate::services::filesystem::replace_file_safely;
use crate::services::logger;
use crate::services::yt_dlp::events::emit_download_log_infallible;
use crate::utils::format::is_allowed_media_extension;
use crate::utils::naming::unique_temp_suffix;
use crate::utils::path::ensure_path_parent_inside_dir;
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

/// Returns the process-wide lock guarding a specific destination path, creating it on first use.
/// Two concurrent downloads that resolve to the same final file (the same video+format added to
/// two channels at once) then serialize their check-then-place instead of both writing it. The
/// registry drops entries whose lock is no longer held by any download, so it stays bounded
/// across a long session.
pub(super) fn destination_placement_lock(path: &Path) -> Arc<std::sync::Mutex<()>> {
    static LOCKS: std::sync::OnceLock<
        std::sync::Mutex<HashMap<PathBuf, std::sync::Weak<std::sync::Mutex<()>>>>,
    > = std::sync::OnceLock::new();

    let registry = LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let mut map = registry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if let Some(existing) = map.get(path).and_then(std::sync::Weak::upgrade) {
        return existing;
    }

    let lock = Arc::new(std::sync::Mutex::new(()));
    map.insert(path.to_path_buf(), Arc::downgrade(&lock));
    // Drop dead entries so the registry does not grow unbounded as files are downloaded.
    map.retain(|_, weak| weak.strong_count() > 0);
    lock
}

/// Picks the media file among what yt-dlp left in the run's directory under `file_name_prefix`.
///
/// The directory also holds the live chat replay (`<prefix>.live_chat.json`), and can hold a
/// subtitle or a format's leftover part. A merged format (`137+140`) matches no single entry of the
/// metadata, so there is usually no expected extension to go by. Choosing the newest file let the
/// replay win whenever yt-dlp dated the merged video by the server's Last-Modified (its `--mtime`
/// option, the default in older releases), and the JSON was then stored as the video. Only a media
/// extension is a candidate now. The expected one comes first, then the largest, which is the merged
/// file whenever its parts were left behind.
pub(super) fn pick_downloaded_media(
    candidates: Vec<(PathBuf, u64)>,
    expected_ext: Option<&str>,
) -> Option<PathBuf> {
    let extension_of = |path: &Path| {
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
    };
    let expected_ext = expected_ext.map(|value| value.trim_start_matches('.').to_ascii_lowercase());

    candidates
        .into_iter()
        .filter(|(path, _)| {
            extension_of(path).is_some_and(|extension| is_allowed_media_extension(&extension))
        })
        .max_by_key(|(path, len)| {
            let is_expected = expected_ext.is_some() && extension_of(path) == expected_ext;
            (is_expected, *len)
        })
        .map(|(path, _)| path)
}

pub(super) fn find_downloaded_media_file(
    temp_dir: &Path,
    file_name_prefix: &str,
    expected_ext: Option<&str>,
) -> AppResult<PathBuf> {
    let not_found = || {
        AppError::from_code(
            AppErrorCode::YtDlpDownloadedFileNotFound,
            "download completed but the final file was not found",
        )
    };

    let candidates = fs::read_dir(temp_dir)
        .map_err(|_| not_found())?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(file_name_prefix))
        })
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then(|| (entry.path(), metadata.len()))
        })
        .collect();

    pick_downloaded_media(candidates, expected_ext).ok_or_else(not_found)
}

/// Returns the final path and whether a library file with the same content was kept (the fresh
/// download was discarded). The caller surfaces the second value to the user.
///
/// The library copy is named after its content (`media_<sha256>.<ext>`), like a local import. That
/// name is what the deep verification checks a file against, and it settles what a file already at
/// that name means. One whose bytes still hash to the name holds this exact content already (the
/// same video saved for another channel), so the fresh copy is dropped. One whose bytes do not is a
/// damaged copy, and the fresh download replaces it, which is the repair a second download is for.
/// Every row naming the file points at the right bytes either way.
pub(super) fn place_downloaded_file(
    downloaded_temp: &Path,
    media_dir: &Path,
    library_dir: &Path,
) -> AppResult<(PathBuf, bool)> {
    // The backstop for pick_downloaded_media. Nothing but a media file may land in `video/` or
    // `audio/`, whatever chose it.
    let is_media = downloaded_temp
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(is_allowed_media_extension);

    if !is_media {
        return Err(AppError::from_code(
            AppErrorCode::InvalidDownloadedFile,
            "the downloaded file is not a media file the library accepts",
        ));
    }

    // Hashed before any lock is taken, since it reads the whole file.
    let digest = crate::utils::hash::file_hash(downloaded_temp)?;
    let extension = crate::utils::path::extension_from_path(downloaded_temp);

    // Serialize the placement into the library against a concurrent migration (see library::lock)
    // so a just-finished download cannot land in the old directory while the migration is
    // copying/removing it.
    let _library_guard = crate::services::library::lock::library_read_guard();

    let final_destination = media_dir
        .join(crate::services::library::media::content_addressed_media_name(&digest, &extension));
    ensure_path_parent_inside_dir(&final_destination, library_dir)?;

    // Serialize concurrent placements of this exact destination (the same content finishing for two
    // channels at once) so they cannot both pass the existence check and write the file. Distinct
    // from the library guard above, which only serializes against a migration.
    let placement_lock = destination_placement_lock(&final_destination);
    let _placement_guard = placement_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let kept_existing = final_destination.is_file()
        && crate::utils::hash::file_hash(&final_destination).is_ok_and(|stored| stored == digest);

    if !kept_existing {
        replace_file_safely(downloaded_temp, &final_destination)?;
    }

    Ok((final_destination, kept_existing))
}

/// Runs `place_downloaded_file` (a cross-device move can fall back to a full `fs::copy` of a
/// multi-GB video) on the blocking thread pool, so this heavy I/O never runs directly on an
/// async task.
pub(super) async fn place_downloaded_file_async(
    downloaded_temp: PathBuf,
    media_dir: PathBuf,
    library_dir: PathBuf,
) -> AppResult<(PathBuf, bool)> {
    run_blocking(move || place_downloaded_file(&downloaded_temp, &media_dir, &library_dir)).await
}

/// Records a crash marker naming a download's file, the moment it is in the library. Best effort,
/// like the registration's own marker. A marker that cannot be written costs one launch's automatic
/// reconciliation, and Diagnostics still reports the file.
pub(super) async fn record_placement_marker<R: Runtime>(
    app: &AppHandle<R>,
    file_path: &str,
) -> Option<String> {
    let app = app.clone();
    let artifacts = crate::services::pending_media::PendingMediaArtifacts {
        file_path: Some(file_path.to_string()),
        ..Default::default()
    };

    let recorded = run_blocking(move || {
        crate::services::pending_media::record_pending_media_artifacts(&app, artifacts)
    })
    .await;

    match recorded {
        Ok(marker) => Some(marker),
        Err(error) => {
            logger::warn(
                "yt_dlp",
                format!("could not record the crash marker for a placed download: {error}"),
            );

            None
        }
    }
}

/// Moves `file` into `dir` under its own name, or under a prefixed one when that name is taken, and
/// returns where it went.
pub(super) fn move_into_dir_without_overwriting(file: &Path, dir: &Path) -> AppResult<PathBuf> {
    let file_name = file.file_name().ok_or_else(|| {
        AppError::from_code(
            AppErrorCode::InvalidDownloadedFile,
            "downloaded file has no valid name",
        )
    })?;

    let mut destination = dir.join(file_name);

    if destination.exists() {
        destination = dir.join(format!(
            "{}-{}",
            unique_temp_suffix(),
            file_name.to_string_lossy()
        ));
    }

    fs::rename(file, &destination).map_err(|e| {
        AppError::fs_error(
            AppErrorCode::FileRenameFailed,
            "failed to keep the downloaded file",
            &destination,
            &e,
        )
    })?;

    Ok(destination)
}

/// Keeps a finished download that could not be placed into the library, and returns `error` with
/// where the file went added to its details.
///
/// The run's temp directory is removed when the run ends, and the download in it is often the
/// expensive part, sometimes the only chance at all (a video since removed, a replay that expired).
/// A disconnected library drive or a full disk is a reason to fail the creation, not to throw the
/// file away, so it is moved to `recovered-downloads/` in the cache, which nothing sweeps.
pub(super) async fn keep_unplaced_download<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    downloaded_temp: PathBuf,
    error: AppError,
) -> AppError {
    let kept = match crate::services::temp_paths::recovered_downloads_dir(app) {
        Ok(dir) => {
            run_blocking(move || move_into_dir_without_overwriting(&downloaded_temp, &dir)).await
        }
        Err(dir_error) => Err(dir_error),
    };

    match kept {
        Ok(kept_at) => {
            let name = logger::redact_path(&kept_at);

            emit_download_log_infallible(
                app,
                run_id,
                format!(
                    "The download could not be added to the library. The file was kept as {name} in the recovered-downloads folder of the app's cache directory."
                ),
                "system",
            );

            let details = match error.details.as_deref() {
                Some(details) if !details.trim().is_empty() => {
                    format!("{details}. The downloaded file was kept as recovered-downloads/{name}")
                }
                _ => format!("the downloaded file was kept as recovered-downloads/{name}"),
            };

            AppError {
                details: Some(details),
                ..error
            }
        }
        Err(keep_error) => {
            logger::warn(
                "yt_dlp",
                format!("could not keep a download that failed to reach the library: {keep_error}"),
            );

            error
        }
    }
}
