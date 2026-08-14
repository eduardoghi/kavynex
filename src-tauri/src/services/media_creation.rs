//! Creating a media, end to end, as one backend operation.
//!
//! Adding a media is not one step: the artifacts have to be produced (a yt-dlp download or a local
//! import, plus a thumbnail and possibly a live chat replay), and only then can the row that points
//! at them be inserted. Between those two points the files sit in the library with nothing
//! referencing them, and that window is what everything here is shaped around.
//!
//! This used to be orchestrated by the renderer, across seven IPC calls, and two properties fell out
//! of that which neither is true any more:
//!
//! - **The window crossed the process boundary.** Each hop was a place the process could stop with
//!   artifacts on disk and no row. The crash marker (`services::pending_media`) covered the part of
//!   it that a `catch` structurally cannot, and still does, but the window it has to cover is now
//!   the inside of one function rather than the span of five round trips.
//! - **The exclusion rested on the frontend.** Nothing kept two creations from resolving to the same
//!   content-addressed path except the add-media modal refusing to start a second one, which
//!   `docs/THREAT-MODEL.md` recorded as the one guarantee in that document depending on renderer behavior. It
//!   is now [`library::cleanup::media_registration_guard`], a lock the reference-counted cleanup
//!   takes too, so a queue or a batch import cannot reopen it by construction.
//!
//! What deliberately stayed in the renderer is everything *after* the row lands: the comment backup,
//! the live-chat notice, the duration probe. None of them is inside the window (the media is
//! registered and safe by then), and the duration probe in particular reads the file through a
//! `<video>` element, which is a webview capability rather than something to reimplement over
//! FFmpeg. Keeping it outside also removed a real hazard: that probe resolves on `loadedmetadata` or
//! `error` and had no timeout, so a source that produced neither used to hang the creation with the
//! marker on disk. It cannot now. The row is already in.
//!
//! The ordering inside [`create_media_async`] is load-bearing in two places, and both are the same
//! rule stated twice: never record something that is not true yet. The marker is written *after* the
//! artifacts exist, because a marker naming files that were never created would hand the startup
//! sweep paths to reconcile that no run ever wrote. And the marker is cleared *after* the row lands
//! or the cleanup has run, because clearing it earlier would drop the record precisely while it is
//! the only thing describing the state on disk.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::models::yt_dlp::{DownloadedMediaResult, ImportMode};
use crate::services::database::shared_pool;
use crate::services::library;
use crate::services::logger;
use crate::services::pending_media::{self, PendingMediaArtifacts};
use crate::services::thumbnail;
use crate::services::video_repository as repo;
use crate::services::yt_dlp;
use crate::utils::path::ensure_managed_library_relative_path;
use crate::utils::task::run_blocking;
use crate::utils::validation::{ensure_valid_media_title, ensure_valid_media_type};
use crate::{AppError, AppErrorCode, AppResult};

/// Where a media's bytes come from. The two modes differ only in how the artifacts are produced;
/// everything from the crash marker onwards is identical.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaSourceMode {
    Local,
    YtDlp,
}

/// Everything one media creation needs, as the renderer sends it.
///
/// Deliberately the same field set the frontend already assembled for its own orchestration, so the
/// move is a change of *who runs the steps* rather than of what the user is asked for. Every value
/// here is caller-supplied and none is trusted: `library_path` is checked against the persisted
/// settings by the command layer, the title and media type go through the shared validators, and
/// every produced path is re-checked as a managed library-relative path before it reaches a row.
#[derive(Debug, Clone, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct CreateMediaRequest {
    // Tauri serializes an i64 as a JSON number, so it is annotated rather than left to ts-rs's
    // `bigint` default. The same override every other exported id in this crate carries.
    #[ts(type = "number")]
    pub channel_id: i64,
    pub title: String,
    #[ts(type = "\"local\" | \"yt-dlp\"")]
    pub source_mode: MediaSourceMode,
    /// A URL for a yt-dlp run, an absolute path for a local import.
    // path-surface: an absolute path in local-import mode, so it belongs to the caller-supplied
    // path surface the command inventory gates, and no naming rule can tell. `source_value` is the
    // honest name (it is a URL in the other mode), a `source_` prefix rule would also match
    // `source_mode` right above, and renaming it would make the name lie for yt-dlp runs and churn
    // the generated binding. Removing this line shrinks what the inventory check reports, which
    // fails that check rather than passing quietly.
    pub source_value: String,
    /// A managed `thumbnails/...` path, a remote URL, or an absolute path the user picked. Absent
    /// means "derive one", from the download's own thumbnail, or from the media file itself.
    pub thumbnail_source_path: Option<String>,
    #[ts(type = "\"video\" | \"audio\"")]
    pub media_type: String,
    #[ts(type = "\"copy\" | \"move\"")]
    pub import_mode: ImportMode,
    pub library_path: String,
    pub published_at: Option<String>,
    pub yt_dlp_run_id: String,
    pub yt_dlp_format_id: String,
    /// Resolved from the format metadata before the download starts, so an already-registered video
    /// fails fast instead of after fetching the whole file.
    pub yt_dlp_youtube_video_id: Option<String>,
    pub download_live_chat: bool,
    pub cookies_browser: Option<String>,
    pub cookies_path: Option<String>,
}

/// The registered media, as the caller needs to see it.
///
/// Carries the stored paths rather than only the id because the steps that stay in the renderer
/// need them: the duration probe reads `file_path`/`media_type`, the comment backup reads
/// `youtube_video_id`, and the live-chat notice reads whether a replay was actually saved.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct CreatedMedia {
    #[ts(type = "number")]
    pub id: i64,
    pub file_path: String,
    pub thumbnail_path: Option<String>,
    #[ts(type = "\"video\" | \"audio\"")]
    pub media_type: String,
    pub youtube_video_id: Option<String>,
    pub live_chat_file_path: Option<String>,
    pub is_live: bool,
}

/// The artifacts one creation wrote into the library, before any row points at them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct PreparedArtifacts {
    pub(crate) file_path: String,
    pub(crate) thumbnail_path: Option<String>,
    pub(crate) media_type: String,
    pub(crate) youtube_video_id: Option<String>,
    pub(crate) published_at: Option<String>,
    pub(crate) is_live: bool,
    pub(crate) live_chat_file_path: Option<String>,
}

/// What a caller-supplied thumbnail value actually is, which decides how it is turned into a stored
/// path.
///
/// Pure and separate from the resolving, because the classification is the part with a security
/// consequence and no I/O: an absolute path is handed to the persist step, a URL to the downloader
/// (whose own host allow-list then applies), and a value that is already a managed `thumbnails/...`
/// path is taken as-is rather than re-persisted. Reading a remote URL as a local path, or the
/// reverse, is exactly the confusion worth pinning with a test rather than inferring from a chain of
/// regexes buried in an async function.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ThumbnailSource {
    /// Already stored in the library under `thumbnails/`; nothing to do.
    Managed(String),
    /// An `http(s)` URL to fetch.
    Remote(String),
    /// An absolute path on disk to copy into the library.
    Local(String),
    /// Nothing was supplied.
    Absent,
}

fn is_remote_url(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();

    lowered.starts_with("http://") || lowered.starts_with("https://")
}

/// True for an absolute path in either platform's spelling.
///
/// Both are recognized regardless of the host platform, matching the frontend predicate this
/// replaced: the value can come from a database row written on another machine (an imported
/// library), so a Windows path reaching a Linux build must still be classified as a path rather
/// than falling through to the managed branch.
fn is_absolute_file_path(value: &str) -> bool {
    if value.starts_with('/') || value.starts_with('\\') {
        return true;
    }

    let mut chars = value.chars();

    match (chars.next(), chars.next(), chars.next()) {
        (Some(drive), Some(':'), Some('\\' | '/')) => drive.is_ascii_alphabetic(),
        _ => false,
    }
}

pub(crate) fn classify_thumbnail_source(value: Option<&str>) -> ThumbnailSource {
    let trimmed = value.map(str::trim).unwrap_or_default();

    if trimmed.is_empty() {
        return ThumbnailSource::Absent;
    }

    if is_remote_url(trimmed) {
        return ThumbnailSource::Remote(trimmed.to_string());
    }

    if is_absolute_file_path(trimmed) {
        return ThumbnailSource::Local(trimmed.to_string());
    }

    // A relative value is only meaningful when it names the managed thumbnails directory; anything
    // else is a value this app did not write and has no way to interpret.
    if trimmed.starts_with(&format!("{}/", crate::constants::LIBRARY_DIR_THUMBNAILS)) {
        return ThumbnailSource::Managed(trimmed.to_string());
    }

    ThumbnailSource::Absent
}

/// Normalizes a caller-supplied optional string to `None` when it is blank.
fn normalized_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Validates and normalizes the request before any file is written.
///
/// Runs first, and entirely, so a rejected request produces nothing to clean up. The title and media
/// type go through the same validators every other write boundary calls; the rest is trimming, which
/// matters because a padded value would otherwise be validated in one form and stored in another.
///
/// Pure, so every refusal is one call from a test. The request arrives over IPC, so these are the
/// checks that stand between a hostile payload and a download.
pub(crate) fn normalize_create_media_request(
    request: CreateMediaRequest,
) -> AppResult<CreateMediaRequest> {
    let title = request.title.trim().to_string();
    let source_value = request.source_value.trim().to_string();
    let library_path = request.library_path.trim().to_string();

    ensure_valid_media_title(&title)?;
    ensure_valid_media_type(&request.media_type)?;

    if source_value.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidMediaCreationArguments,
            "media source is required",
        ));
    }

    if library_path.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryPath,
            "library path is empty",
        ));
    }

    let yt_dlp_run_id = request.yt_dlp_run_id.trim().to_string();
    let yt_dlp_format_id = request.yt_dlp_format_id.trim().to_string();

    // Only checked for a yt-dlp source: a local import legitimately carries neither, and demanding
    // them there would reject every local add. The values themselves are validated again, by
    // character class, in `yt_dlp::download::command` before they reach an argv.
    if request.source_mode == MediaSourceMode::YtDlp {
        if yt_dlp_run_id.is_empty() {
            return Err(AppError::from_code(
                AppErrorCode::InvalidRunId,
                "yt-dlp run id is required",
            ));
        }

        if yt_dlp_format_id.is_empty() {
            return Err(AppError::from_code(
                AppErrorCode::InvalidFormatId,
                "yt-dlp format id is required",
            ));
        }
    }

    Ok(CreateMediaRequest {
        title,
        source_value,
        library_path,
        media_type: request.media_type.trim().to_string(),
        thumbnail_source_path: normalized_optional(request.thumbnail_source_path),
        published_at: normalized_optional(request.published_at),
        yt_dlp_run_id,
        yt_dlp_format_id,
        yt_dlp_youtube_video_id: normalized_optional(request.yt_dlp_youtube_video_id),
        cookies_browser: normalized_optional(request.cookies_browser),
        cookies_path: normalized_optional(request.cookies_path),
        ..request
    })
}

/// Turns a classified thumbnail source into a stored, library-relative path.
///
/// `Managed` is returned untouched. It already names a file in the library, and re-persisting it
/// would copy a file onto itself. The other two go through the same persist/download the renderer
/// used to call directly.
async fn store_thumbnail_source(
    app: &AppHandle,
    source: ThumbnailSource,
    library_path: &str,
) -> AppResult<Option<String>> {
    match source {
        ThumbnailSource::Managed(path) => Ok(Some(path)),
        ThumbnailSource::Remote(url) => {
            thumbnail::download_thumbnail_from_url_async(app, &url, library_path)
                .await
                .map(Some)
        }
        ThumbnailSource::Local(path) => {
            let library_path = library_path.to_string();

            run_blocking(move || thumbnail::persist_thumbnail_file_sync(&path, &library_path))
                .await
                .map(Some)
        }
        ThumbnailSource::Absent => Ok(None),
    }
}

/// Generates a thumbnail from the media file itself and stores it in the library.
///
/// The preview is written to the cache directory and moved into the library from there, so the
/// temporary copy is removed either way. A failure to remove it is logged rather than raised,
/// since the preview directory is swept by age anyway and losing the media over a leftover would be
/// the wrong trade.
async fn generate_and_store_thumbnail(
    app: &AppHandle,
    source_value: &str,
    library_path: &str,
) -> AppResult<String> {
    let generated = {
        let app = app.clone();
        let source_value = source_value.to_string();

        run_blocking(move || thumbnail::generate_temporary_thumbnail_sync(&app, &source_value))
            .await?
    };

    let stored = {
        let library_path = library_path.to_string();
        let generated = generated.clone();

        run_blocking(move || thumbnail::persist_thumbnail_file_sync(&generated, &library_path))
            .await
    };

    let app_for_cleanup = app.clone();
    let generated_for_cleanup = generated.clone();
    let removed = run_blocking(move || {
        thumbnail::delete_temporary_thumbnail_sync(&app_for_cleanup, &generated_for_cleanup)
    })
    .await;

    if let Err(error) = removed {
        logger::warn(
            "media_creation",
            format!("failed to remove a temporary thumbnail after persisting it: {error}"),
        );
    }

    stored
}

/// Registers `run_id` so a local import can be cancelled, returning its flag and the guard that
/// releases the registry entry when the import ends.
///
/// `None` means this import simply is not cancellable, which is the correct answer for three
/// distinct cases and deliberately not distinguished between them: no run id was sent (an older
/// frontend, or any caller that has no Cancel button to offer), the id is not well-formed
/// (`is_valid_run_id`, the same rule a download's id has to satisfy), or the registry refused it.
/// None of the three is a reason to refuse a file the user asked to import.
///
/// The guard is returned rather than dropped here: dropping it would release the entry immediately
/// and the flag would then belong to a run `cancel_media_download` can no longer find, which is
/// exactly the shape of a Cancel button that silently does nothing.
fn local_import_cancellation(
    run_id: &str,
) -> Option<(Arc<AtomicBool>, yt_dlp::registry::DownloadRunReleaseGuard)> {
    let run_id = run_id.trim();

    if run_id.is_empty() || !yt_dlp::download::is_valid_run_id(run_id) {
        return None;
    }

    match yt_dlp::registry::register_download_run(run_id) {
        Ok(flag) => Some((flag, yt_dlp::registry::DownloadRunReleaseGuard::new(run_id))),
        Err(error) => {
            logger::warn(
                "media_creation",
                format!("this import cannot be cancelled: {error}"),
            );

            None
        }
    }
}

/// Produces the artifacts for a local import: the thumbnail first, then the media file.
///
/// That order is required rather than incidental. A `move` import removes the source once it is in
/// the library, and the thumbnail for a file with no supplied one is generated *from that source*.
/// so generating it afterwards would run FFmpeg against a path that no longer exists.
async fn prepare_local_artifacts(
    app: &AppHandle,
    request: &CreateMediaRequest,
) -> AppResult<PreparedArtifacts> {
    let thumbnail_source = classify_thumbnail_source(request.thumbnail_source_path.as_deref());

    let thumbnail_path = match thumbnail_source {
        ThumbnailSource::Absent => {
            let generated =
                generate_and_store_thumbnail(app, &request.source_value, &request.library_path)
                    .await;

            match generated {
                Ok(path) => Some(path),
                // An audio file without embedded cover art is the ordinary case, not a failure, so
                // it imports without a thumbnail. A video that cannot produce one is treated the
                // same way: the media is what the user asked for, and the card falls back to its
                // no-thumbnail rendering.
                Err(error) => {
                    logger::warn(
                        "media_creation",
                        format!(
                            "could not derive a thumbnail from the imported file; importing \
                             without one: {error}"
                        ),
                    );

                    None
                }
            }
        }
        source => store_thumbnail_source(app, source, &request.library_path).await?,
    };

    // Register the run so `cancel_media_download(runId)` reaches this import, which is what gives
    // the modal's Cancel button something to do during a local add. A yt-dlp source registers
    // inside `download_media_from_url_async`; this is the local half of the same mechanism, using
    // the same registry so the cancel command has one meaning rather than two.
    //
    // A registration that fails degrades to an uncancellable import rather than failing the add.
    // The two ways it can fail say why: a duplicate id means this run is already registered, and a
    // full registry means the caller is flooding run ids, neither is a reason to refuse a file the
    // user asked to import, and losing the Cancel button is the proportionate consequence.
    let cancellation = local_import_cancellation(&request.yt_dlp_run_id);
    let cancel_flag = cancellation
        .as_ref()
        .map(|(flag, _release)| Arc::clone(flag));

    let import_mode = request.import_mode;
    let source_value = request.source_value.clone();
    let library_path = request.library_path.clone();

    let imported = run_blocking(move || {
        library::media::import_media_file_cancellable_sync(
            &source_value,
            import_mode,
            &library_path,
            cancel_flag.as_deref(),
        )
    })
    .await;

    let file_path = match imported {
        Ok(file_path) => file_path,
        Err(error) => {
            // The thumbnail is already in the library and nothing will ever point at it, so hand it
            // to the reference-counted cleanup rather than leaving it behind. Reference-counted
            // because it is content-addressed: the same image may already back a registered row.
            cleanup_artifacts_best_effort(app, None, thumbnail_path, None).await;

            return Err(error);
        }
    };

    Ok(PreparedArtifacts {
        file_path,
        thumbnail_path,
        media_type: request.media_type.clone(),
        youtube_video_id: None,
        published_at: request.published_at.clone(),
        is_live: false,
        live_chat_file_path: None,
    })
}

/// Which fetched thumbnail is left over once a supplied one has been stored, if any.
///
/// The run is told to skip its own thumbnail when the user supplied one, so a fetched file should
/// not exist here at all, but if it does, it is now referenced by nothing and belongs to the
/// reference-counted cleanup.
///
/// Pure, and extracted, because the comparison decides an *unlink*: inverted, this discards the
/// thumbnail that was actually stored and keeps the one nothing points at, which surfaces as a card
/// whose image is gone and no error anywhere. The caller needs an `AppHandle`, so that inversion
/// could not be reached by a test until the decision moved here.
pub(crate) fn fetched_thumbnail_to_discard(
    fetched: Option<String>,
    stored: Option<&str>,
) -> Option<String> {
    let fetched = fetched?;

    if Some(fetched.as_str()) == stored {
        return None;
    }

    Some(fetched)
}

/// Resolves the thumbnail for a completed yt-dlp download.
///
/// Three cases, in the order they are decided: a thumbnail the user supplied wins over the one
/// yt-dlp fetched, the fetched one is used when there is no supplied one, and a bare URL from the
/// metadata is the last resort. The first case is the one with a loose end. The run is told to skip
/// its own thumbnail when a manual one is supplied, so a fetched file should not exist, but if one
/// does it is now unreferenced and is handed to the reference-counted cleanup rather than left in
/// the library.
async fn resolve_downloaded_thumbnail(
    app: &AppHandle,
    request: &CreateMediaRequest,
    downloaded: &DownloadedMediaResult,
) -> AppResult<Option<String>> {
    let fetched = normalized_optional(downloaded.thumbnail_path.clone());
    let metadata_url = normalized_optional(downloaded.thumbnail_url.clone());

    match classify_thumbnail_source(request.thumbnail_source_path.as_deref()) {
        ThumbnailSource::Absent => match fetched {
            Some(path) => Ok(Some(path)),
            None => {
                store_thumbnail_source(
                    app,
                    classify_thumbnail_source(metadata_url.as_deref()),
                    &request.library_path,
                )
                .await
            }
        },
        supplied => {
            let stored = store_thumbnail_source(app, supplied, &request.library_path).await?;

            if let Some(discarded) = fetched_thumbnail_to_discard(fetched, stored.as_deref()) {
                cleanup_artifacts_best_effort(app, None, Some(discarded), None).await;
            }

            Ok(stored)
        }
    }
}

async fn prepare_yt_dlp_artifacts(
    app: &AppHandle,
    request: &CreateMediaRequest,
) -> AppResult<PreparedArtifacts> {
    // A supplied thumbnail makes the run's own thumbnail fetch pointless work whose output would be
    // discarded a moment later, so it is skipped rather than downloaded and cleaned up.
    let skip_auto_thumbnail = request.thumbnail_source_path.is_some();

    let downloaded = yt_dlp::download_media_from_url_async(
        app,
        &request.source_value,
        &request.library_path,
        &request.yt_dlp_run_id,
        &request.yt_dlp_format_id,
        request.download_live_chat,
        skip_auto_thumbnail,
        request.cookies_browser.as_deref(),
        request.cookies_path.as_deref(),
    )
    .await?;

    let thumbnail_path = match resolve_downloaded_thumbnail(app, request, &downloaded).await {
        Ok(thumbnail_path) => thumbnail_path,
        Err(error) => {
            // The media (and possibly its live chat replay) are already in the library with nothing
            // pointing at them, and no marker has been written yet (this is still the preparation
            // phase), so clean them up here rather than stranding them.
            cleanup_artifacts_best_effort(
                app,
                Some(downloaded.file_path.clone()),
                None,
                downloaded.live_chat_file_path.clone(),
            )
            .await;

            return Err(error);
        }
    };

    Ok(PreparedArtifacts {
        file_path: downloaded.file_path,
        thumbnail_path,
        media_type: downloaded.media_type,
        youtube_video_id: normalized_optional(downloaded.youtube_video_id),
        published_at: normalized_optional(downloaded.published_at)
            .or_else(|| request.published_at.clone()),
        is_live: downloaded.is_live,
        live_chat_file_path: normalized_optional(downloaded.live_chat_file_path),
    })
}

/// True when no artifact was named, i.e. when there is nothing for the cleanup to do.
///
/// Pure, and extracted, because weakening the original `&&` chain to `||` turned it into "return
/// early if any of the three is absent", and the common shape is a creation that produced a media
/// file and no live chat replay, so the cleanup would be skipped exactly when it has real work. The
/// caller is `AppHandle`-bound, so nothing could observe that until the predicate moved here.
///
/// Phrased negatively so the caller reads `if nothing_to_clean_up(..) { return; }` with no `!`. That
/// is not style: a `!` at the call site is a restatement of this function's polarity, and deleting
/// it is a mutant that inverts the guard inside a function no unit test can drive. Removing the
/// restatement removes the mutant, which beats excluding it. The same resolution as
/// `thumbnail::display::take_generation_slot`.
pub(crate) fn nothing_to_clean_up(
    file_path: Option<&str>,
    thumbnail_path: Option<&str>,
    live_chat_file_path: Option<&str>,
) -> bool {
    file_path.is_none() && thumbnail_path.is_none() && live_chat_file_path.is_none()
}

/// Logs whatever the reference-counted cleanup reported, and swallows any failure.
///
/// Every caller is already unwinding a failure, so a cleanup that itself fails must not replace the
/// error the user needs to see. What is left behind in that case is an unreferenced file, which
/// Diagnostics reports. The recoverable outcome.
///
/// Shared by both wrappers below rather than written twice: the two differ only in which cleanup
/// they call (one holds the registration lock, one takes it), and duplicating the reporting would
/// duplicate a `warn` whose only observable effect is the log line.
fn report_cleanup_outcome(outcome: AppResult<library::cleanup::ArtifactCleanupReport>) {
    match outcome {
        Ok(report) if !report.failed_paths.is_empty() => logger::warn(
            "media_creation",
            format!(
                "{} artifact(s) prepared for a failed media creation could not be removed; they \
                 are reported by Diagnostics as unreferenced files",
                report.failed_paths.len()
            ),
        ),
        Ok(_) => {}
        Err(error) => logger::warn(
            "media_creation",
            format!("failed to clean up the artifacts of a failed media creation: {error}"),
        ),
    }
}

/// Hands artifacts to the reference-counted cleanup, taking the registration lock.
async fn cleanup_artifacts_best_effort(
    app: &AppHandle,
    file_path: Option<String>,
    thumbnail_path: Option<String>,
    live_chat_file_path: Option<String>,
) {
    if nothing_to_clean_up(
        file_path.as_deref(),
        thumbnail_path.as_deref(),
        live_chat_file_path.as_deref(),
    ) {
        return;
    }

    report_cleanup_outcome(
        library::cleanup::cleanup_unreferenced_artifacts(
            app,
            file_path,
            thumbnail_path,
            live_chat_file_path,
        )
        .await,
    );
}

/// The same cleanup, for a caller that already holds the registration lock. Takes the whole
/// `PreparedArtifacts` because that caller always has one, and it always names a media file, so
/// there is nothing for [`nothing_to_clean_up`] to decide here.
async fn cleanup_artifacts_best_effort_locked<R: Runtime>(
    app: &AppHandle<R>,
    prepared: &PreparedArtifacts,
) {
    report_cleanup_outcome(
        library::cleanup::cleanup_unreferenced_artifacts_locked(
            app,
            Some(prepared.file_path.clone()),
            prepared.thumbnail_path.clone(),
            prepared.live_chat_file_path.clone(),
        )
        .await,
    );
}

/// Re-checks every produced path as a managed library-relative path before it can reach a row.
///
/// The paths come from this crate's own producers, so this should never fire, which is the reason
/// it is here rather than trusted. The deletion path acts on whatever these rows hold, so a stored
/// path that escaped the managed layout would turn a later delete into an operation outside it, and
/// this is the last point at which that can still be refused for free.
fn ensure_managed_prepared_paths(prepared: &PreparedArtifacts) -> AppResult<()> {
    ensure_managed_library_relative_path(&prepared.file_path)?;

    if let Some(path) = prepared.thumbnail_path.as_deref() {
        ensure_managed_library_relative_path(path)?;
    }

    if let Some(path) = prepared.live_chat_file_path.as_deref() {
        ensure_managed_library_relative_path(path)?;
    }

    Ok(())
}

/// Writes the crash marker for artifacts that exist but have no row yet.
///
/// Best effort, exactly as it was when the renderer called it: the artifacts are already in the
/// library and the user asked for them, so failing to record the recovery hint is strictly better
/// than failing the creation over it. What is lost when it fails is one launch's automatic
/// reconciliation, and Diagnostics still reports the files.
async fn record_marker_best_effort<R: Runtime>(
    app: &AppHandle<R>,
    prepared: &PreparedArtifacts,
) -> Option<String> {
    let app = app.clone();
    let artifacts = PendingMediaArtifacts {
        file_path: Some(prepared.file_path.clone()),
        thumbnail_path: prepared.thumbnail_path.clone(),
        live_chat_file_path: prepared.live_chat_file_path.clone(),
        // The sweep's own retry bookkeeping; a fresh record always starts at zero, which
        // `record_pending_media_artifacts` enforces regardless of what is passed here.
        attempts: 0,
    };

    let recorded =
        run_blocking(move || pending_media::record_pending_media_artifacts(&app, artifacts)).await;

    match recorded {
        Ok(marker) => Some(marker),
        Err(error) => {
            logger::warn(
                "media_creation",
                format!("could not record the pending media marker: {error}"),
            );

            None
        }
    }
}

async fn clear_marker_best_effort<R: Runtime>(app: &AppHandle<R>, marker: Option<String>) {
    let Some(marker) = marker else {
        return;
    };

    let app = app.clone();
    let cleared =
        run_blocking(move || pending_media::clear_pending_media_artifacts(&app, &marker)).await;

    if let Err(error) = cleared {
        logger::warn(
            "media_creation",
            format!("could not clear the pending media marker: {error}"),
        );
    }
}

/// Registers prepared artifacts as a media row.
///
/// This is the critical section, and the whole of it runs under
/// [`library::cleanup::media_registration_guard`]: from before the marker is written until after the
/// row lands (or its artifacts have been cleaned up). Holding it here is what keeps a concurrent
/// reference-counted cleanup from observing these artifacts as unreferenced in the one window where
/// they truly are. The window a second creation resolving to the same content-addressed path would
/// otherwise be able to act in.
///
/// It is deliberately short. The download and the import happen before it, so nothing a user waits
/// on is serialized by this lock; what is inside is a marker write, one query and one insert.
/// Generic over the runtime, and `pub(crate)` rather than private, because this is the half of a
/// creation a test can actually drive: `AppHandle` alone is `AppHandle<Wry>`, and
/// `tauri::test::mock_builder` produces a `MockRuntime` app, so naming the bare alias anywhere in
/// this chain put the ordering below out of reach of every test in the crate.
///
/// The artifact *production* above it stays runtime-bound and is not covered by this. It runs
/// yt-dlp, FFmpeg and an HTTP fetch, none of which a unit test drives. What is covered is the part
/// where an ordering mistake costs a user their data.
pub(crate) async fn register_prepared_media<R: Runtime>(
    app: &AppHandle<R>,
    request: &CreateMediaRequest,
    prepared: PreparedArtifacts,
) -> AppResult<CreatedMedia> {
    ensure_managed_prepared_paths(&prepared)?;

    let _guard = library::cleanup::media_registration_guard().await;

    let marker = record_marker_best_effort(app, &prepared).await;

    let inserted = insert_prepared_media(app, request, &prepared).await;

    match inserted {
        Ok(id) => {
            clear_marker_best_effort(app, marker).await;

            Ok(CreatedMedia {
                id,
                file_path: prepared.file_path,
                thumbnail_path: prepared.thumbnail_path,
                media_type: prepared.media_type,
                youtube_video_id: prepared.youtube_video_id,
                live_chat_file_path: prepared.live_chat_file_path,
                is_live: prepared.is_live,
            })
        }
        Err(error) => {
            // The cleanup runs while the lock is still held, so the count it takes cannot race a
            // creation that would have adopted these same paths, and the marker is cleared only
            // afterwards, if the process dies in between, the marker is what reconciles them.
            cleanup_artifacts_best_effort_locked(app, &prepared).await;
            clear_marker_best_effort(app, marker).await;

            Err(error)
        }
    }
}

/// The duplicate check and the insert, both against the shared pool.
///
/// The pre-insert lookup exists for its message rather than for correctness: `(channel_id,
/// file_path)` is unique in the schema, so a duplicate would be refused either way, just as a
/// constraint violation rather than as "this media is already registered for the selected channel".
async fn insert_prepared_media<R: Runtime>(
    app: &AppHandle<R>,
    request: &CreateMediaRequest,
    prepared: &PreparedArtifacts,
) -> AppResult<i64> {
    let pool = shared_pool(app).await?;

    if repo::find_media_by_channel_and_file_path(&pool, request.channel_id, &prepared.file_path)
        .await?
        .is_some()
    {
        return Err(AppError::from_code(
            AppErrorCode::VideoAlreadyExistsForChannel,
            "this media is already registered for the selected channel",
        ));
    }

    repo::insert_media(
        &pool,
        request.channel_id,
        &request.title,
        &prepared.file_path,
        prepared.thumbnail_path.as_deref(),
        &prepared.media_type,
        prepared.youtube_video_id.as_deref(),
        prepared.published_at.as_deref(),
        // Left unset on purpose: the duration is probed by the renderer once the row exists, through
        // the media element that can actually decode the file, and written back with
        // `update_media_duration`. Probing it here would mean an FFmpeg run per import, and probing
        // it *before* the insert (which is where it used to happen), put an un-timeout-ed promise
        // inside the window this function exists to keep short.
        None,
        prepared.is_live,
        prepared.live_chat_file_path.as_deref(),
    )
    .await
}

/// Refuses a yt-dlp source whose video is already registered for this channel, before downloading it.
///
/// The id comes from the metadata fetch the format picker already ran, so this costs one query and
/// saves a whole download. The guarantee is the partial unique index on
/// `(channel_id, youtube_video_id)`. This is the difference between failing now and failing
/// after a gigabyte.
/// True when the pre-check applies: a yt-dlp source whose video id was resolved up front.
///
/// Pure, and extracted, because inverting the mode comparison is silent in both directions. A local
/// import would run a query that always answers "no" (it carries no video id), and a re-added
/// YouTube video would download in full before the unique index refused it. Neither is a crash, and
/// the caller needs an `AppHandle`, so nothing observed the flip until this moved here.
pub(crate) fn needs_youtube_duplicate_pre_check(request: &CreateMediaRequest) -> bool {
    request.source_mode == MediaSourceMode::YtDlp && request.yt_dlp_youtube_video_id.is_some()
}

async fn ensure_youtube_media_is_new(
    app: &AppHandle,
    request: &CreateMediaRequest,
) -> AppResult<()> {
    let Some(video_id) = request.yt_dlp_youtube_video_id.as_deref() else {
        return Ok(());
    };

    let pool = shared_pool(app).await?;

    if repo::media_exists_for_channel_and_youtube_id(&pool, request.channel_id, video_id).await? {
        return Err(AppError::from_code(
            AppErrorCode::VideoAlreadyExistsForChannel,
            "this media is already registered for the selected channel",
        ));
    }

    Ok(())
}

/// Creates a media: produces its artifacts, records the crash marker, inserts the row, clears the
/// marker.
///
/// `library_path` is verified against the persisted settings by the command layer before this runs,
/// like every other library write.
pub async fn create_media_async(
    app: &AppHandle,
    request: CreateMediaRequest,
) -> AppResult<CreatedMedia> {
    let request = normalize_create_media_request(request)?;

    if needs_youtube_duplicate_pre_check(&request) {
        ensure_youtube_media_is_new(app, &request).await?;
    }

    let prepared = match request.source_mode {
        MediaSourceMode::YtDlp => prepare_yt_dlp_artifacts(app, &request).await?,
        MediaSourceMode::Local => prepare_local_artifacts(app, &request).await?,
    };

    register_prepared_media(app, &request, prepared).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(source_mode: MediaSourceMode) -> CreateMediaRequest {
        CreateMediaRequest {
            channel_id: 1,
            title: "A title".to_string(),
            source_mode,
            source_value: "https://www.youtube.com/watch?v=abc".to_string(),
            thumbnail_source_path: None,
            media_type: "video".to_string(),
            import_mode: ImportMode::Copy,
            library_path: "/library".to_string(),
            published_at: None,
            yt_dlp_run_id: "run-1".to_string(),
            yt_dlp_format_id: "137+140".to_string(),
            yt_dlp_youtube_video_id: None,
            download_live_chat: false,
            cookies_browser: None,
            cookies_path: None,
        }
    }

    fn with_video_id(source_mode: MediaSourceMode, video_id: Option<&str>) -> CreateMediaRequest {
        CreateMediaRequest {
            yt_dlp_youtube_video_id: video_id.map(str::to_string),
            ..request(source_mode)
        }
    }

    #[test]
    fn a_managed_thumbnail_path_is_taken_as_it_is() {
        // The one case that must not be re-persisted: it already names a file in the library, so
        // treating it as a local path would copy that file onto itself under a new hash.
        assert_eq!(
            classify_thumbnail_source(Some("thumbnails/thumb_abc.jpg")),
            ThumbnailSource::Managed("thumbnails/thumb_abc.jpg".to_string())
        );

        // Padding is stripped, because the value is used as a stored path from here on.
        assert_eq!(
            classify_thumbnail_source(Some("  thumbnails/thumb_abc.jpg  ")),
            ThumbnailSource::Managed("thumbnails/thumb_abc.jpg".to_string())
        );
    }

    #[test]
    fn a_remote_url_is_classified_before_anything_treats_it_as_a_path() {
        // Reading a URL as a local path would hand it to the persist step, which would refuse it as
        // a missing file, so the failure would be confusing rather than dangerous. The reverse
        // (a path read as a URL) is the one that matters, which is why both directions are pinned.
        for value in [
            "https://i.ytimg.com/vi/abc/maxresdefault.jpg",
            "http://i.ytimg.com/vi/abc/hqdefault.jpg",
            "HTTPS://I.YTIMG.COM/vi/abc/maxresdefault.jpg",
        ] {
            assert!(
                matches!(
                    classify_thumbnail_source(Some(value)),
                    ThumbnailSource::Remote(_)
                ),
                "{value} should be classified as a remote URL"
            );
        }
    }

    #[test]
    fn an_absolute_path_is_classified_on_either_platforms_spelling() {
        // The value can come off a row written on another machine (an imported library), so a
        // Windows path reaching a Linux build must still read as a path rather than falling through
        // to "absent" and silently dropping the user's chosen thumbnail.
        for value in [
            "/home/me/cover.png",
            r"C:\Users\me\cover.png",
            "C:/Users/me/cover.png",
            r"\\?\C:\Users\me\cover.png",
        ] {
            assert!(
                matches!(
                    classify_thumbnail_source(Some(value)),
                    ThumbnailSource::Local(_)
                ),
                "{value} should be classified as a local path"
            );
        }
    }

    #[test]
    fn a_value_that_names_nothing_the_app_wrote_is_absent() {
        // A bare relative name is not a managed path and not something this app can resolve, so it
        // reads as "no thumbnail supplied" and the normal derivation runs instead.
        for value in [
            None,
            Some(""),
            Some("   "),
            Some("cover.png"),
            Some("video/media_abc.mp4"),
            Some("thumbnails"),
        ] {
            assert_eq!(
                classify_thumbnail_source(value),
                ThumbnailSource::Absent,
                "should be absent: {value:?}"
            );
        }
    }

    #[test]
    fn normalizing_trims_every_stored_value() {
        // A padded value validated in one form and stored in another is the validate-here/act-there
        // gap the database export gate documents; the same rule applies to everything persisted from
        // a creation.
        let padded = CreateMediaRequest {
            title: "  A title  ".to_string(),
            source_value: "  https://www.youtube.com/watch?v=abc  ".to_string(),
            library_path: "  /library  ".to_string(),
            thumbnail_source_path: Some("  thumbnails/thumb_abc.jpg  ".to_string()),
            published_at: Some("  2026-01-01  ".to_string()),
            yt_dlp_run_id: "  run-1  ".to_string(),
            yt_dlp_format_id: "  137  ".to_string(),
            yt_dlp_youtube_video_id: Some("  abc  ".to_string()),
            cookies_browser: Some("  firefox  ".to_string()),
            cookies_path: Some("  /tmp/cookies.txt  ".to_string()),
            ..request(MediaSourceMode::YtDlp)
        };

        let padded = CreateMediaRequest {
            media_type: "  video  ".to_string(),
            ..padded
        };

        let normalized = normalize_create_media_request(padded).unwrap();

        assert_eq!(normalized.title, "A title");
        // The media type is stored verbatim and compared verbatim by the `CHECK (media_type IN
        // ('video', 'audio'))` constraint, so a padded value would be validated (the validator
        // trims) and then rejected by the schema, or, worse on an older database without the
        // constraint, stored as a type nothing matches.
        assert_eq!(normalized.media_type, "video");
        assert_eq!(
            normalized.source_value,
            "https://www.youtube.com/watch?v=abc"
        );
        assert_eq!(normalized.library_path, "/library");
        assert_eq!(
            normalized.thumbnail_source_path.as_deref(),
            Some("thumbnails/thumb_abc.jpg")
        );
        assert_eq!(normalized.published_at.as_deref(), Some("2026-01-01"));
        assert_eq!(normalized.yt_dlp_run_id, "run-1");
        assert_eq!(normalized.yt_dlp_format_id, "137");
        assert_eq!(normalized.yt_dlp_youtube_video_id.as_deref(), Some("abc"));
        assert_eq!(normalized.cookies_browser.as_deref(), Some("firefox"));
        assert_eq!(normalized.cookies_path.as_deref(), Some("/tmp/cookies.txt"));
    }

    #[test]
    fn a_blank_optional_value_normalizes_to_absent_rather_than_an_empty_string() {
        // An empty string is not the same as "not supplied" downstream: a blank youtube id stored
        // verbatim would sit in the partial unique index as a present value and collide with the
        // next blank one, which is exactly what insert_media normalizes away on its own side.
        let blanks = CreateMediaRequest {
            thumbnail_source_path: Some("   ".to_string()),
            published_at: Some("".to_string()),
            yt_dlp_youtube_video_id: Some("  ".to_string()),
            cookies_browser: Some("".to_string()),
            cookies_path: Some("   ".to_string()),
            ..request(MediaSourceMode::YtDlp)
        };

        let normalized = normalize_create_media_request(blanks).unwrap();

        assert_eq!(normalized.thumbnail_source_path, None);
        assert_eq!(normalized.published_at, None);
        assert_eq!(normalized.yt_dlp_youtube_video_id, None);
        assert_eq!(normalized.cookies_browser, None);
        assert_eq!(normalized.cookies_path, None);
    }

    #[test]
    fn a_request_is_refused_before_anything_is_written() {
        // Each of these used to be checked by the frontend alone. They run here now, and they run
        // first: a rejected request must produce nothing to clean up, which is only true while no
        // download or import has started.
        let empty_title = CreateMediaRequest {
            title: "   ".to_string(),
            ..request(MediaSourceMode::Local)
        };
        assert_eq!(
            normalize_create_media_request(empty_title)
                .unwrap_err()
                .code,
            AppErrorCode::InvalidMediaTitle.as_str()
        );

        let bad_type = CreateMediaRequest {
            media_type: "image".to_string(),
            ..request(MediaSourceMode::Local)
        };
        assert_eq!(
            normalize_create_media_request(bad_type).unwrap_err().code,
            AppErrorCode::InvalidMediaCreationArguments.as_str()
        );

        let no_source = CreateMediaRequest {
            source_value: "  ".to_string(),
            ..request(MediaSourceMode::Local)
        };
        assert_eq!(
            normalize_create_media_request(no_source).unwrap_err().code,
            AppErrorCode::InvalidMediaCreationArguments.as_str()
        );

        let no_library = CreateMediaRequest {
            library_path: "".to_string(),
            ..request(MediaSourceMode::Local)
        };
        assert_eq!(
            normalize_create_media_request(no_library).unwrap_err().code,
            AppErrorCode::InvalidLibraryPath.as_str()
        );
    }

    #[test]
    fn the_yt_dlp_arguments_are_required_only_for_a_yt_dlp_source() {
        // A local import carries neither a run id nor a format id, so demanding them would reject
        // every local add, and not demanding them for a download would let an empty value reach the
        // argv builder, where the character-class filter is the next thing that would catch it.
        let local = CreateMediaRequest {
            source_mode: MediaSourceMode::Local,
            source_value: "/home/me/clip.mp4".to_string(),
            yt_dlp_run_id: String::new(),
            yt_dlp_format_id: String::new(),
            ..request(MediaSourceMode::Local)
        };
        normalize_create_media_request(local).expect("a local import needs no yt-dlp arguments");

        let no_run_id = CreateMediaRequest {
            yt_dlp_run_id: "   ".to_string(),
            ..request(MediaSourceMode::YtDlp)
        };
        assert_eq!(
            normalize_create_media_request(no_run_id).unwrap_err().code,
            AppErrorCode::InvalidRunId.as_str()
        );

        let no_format_id = CreateMediaRequest {
            yt_dlp_format_id: "".to_string(),
            ..request(MediaSourceMode::YtDlp)
        };
        assert_eq!(
            normalize_create_media_request(no_format_id)
                .unwrap_err()
                .code,
            AppErrorCode::InvalidFormatId.as_str()
        );
    }

    #[test]
    fn every_prepared_path_has_to_be_a_managed_library_path() {
        // The last refusal before a path reaches a row. These paths come from this crate's own
        // producers, so it should never fire, and it is here rather than trusted because the
        // deletion path acts on whatever the row holds.
        let good = PreparedArtifacts {
            file_path: "video/media_abc.mp4".to_string(),
            thumbnail_path: Some("thumbnails/thumb_abc.jpg".to_string()),
            live_chat_file_path: Some("live_chat/abc.live_chat.json.gz".to_string()),
            media_type: "video".to_string(),
            ..PreparedArtifacts::default()
        };
        ensure_managed_prepared_paths(&good).unwrap();

        for escaping in [
            PreparedArtifacts {
                file_path: "../escape.mp4".to_string(),
                ..good.clone()
            },
            PreparedArtifacts {
                thumbnail_path: Some("/etc/passwd".to_string()),
                ..good.clone()
            },
            PreparedArtifacts {
                live_chat_file_path: Some("Documents/secret.txt".to_string()),
                ..good.clone()
            },
        ] {
            assert!(
                ensure_managed_prepared_paths(&escaping).is_err(),
                "a path outside the managed layout must never reach a row"
            );
        }
    }

    #[test]
    fn a_fetched_thumbnail_is_discarded_only_when_it_is_not_the_one_that_was_stored() {
        // The direction that matters: this answer becomes an unlink. Inverted, it discards the
        // thumbnail the row is about to point at and keeps the one nothing references, which shows
        // up as a card with no image and nothing logged anywhere.
        assert_eq!(
            fetched_thumbnail_to_discard(
                Some("thumbnails/thumb_fetched.jpg".to_string()),
                Some("thumbnails/thumb_supplied.jpg")
            ),
            Some("thumbnails/thumb_fetched.jpg".to_string())
        );

        // The two resolved to the same content-addressed file, so there is nothing left over.
        // discarding it here would unlink the file the row points at.
        assert_eq!(
            fetched_thumbnail_to_discard(
                Some("thumbnails/thumb_same.jpg".to_string()),
                Some("thumbnails/thumb_same.jpg")
            ),
            None
        );

        // Nothing was fetched: the run skipped its own thumbnail, which is the normal case when the
        // user supplied one.
        assert_eq!(
            fetched_thumbnail_to_discard(None, Some("thumbnails/thumb_supplied.jpg")),
            None
        );

        // Nothing was stored, so the fetched file is unreferenced and does go.
        assert_eq!(
            fetched_thumbnail_to_discard(Some("thumbnails/thumb_fetched.jpg".to_string()), None),
            Some("thumbnails/thumb_fetched.jpg".to_string())
        );

        assert_eq!(fetched_thumbnail_to_discard(None, None), None);
    }

    #[test]
    fn a_cleanup_is_skipped_only_when_no_artifact_was_named_at_all() {
        // Every combination that names something has to answer true. The failure this guards is the
        // `&&`/`||` flip: with `||` the guard reads "skip if any is absent", and the ordinary
        // creation (a media file with no live chat replay) would skip its cleanup entirely,
        // stranding the file it just wrote.
        assert!(nothing_to_clean_up(None, None, None));

        assert!(!nothing_to_clean_up(Some("video/media_a.mp4"), None, None));
        assert!(!nothing_to_clean_up(
            None,
            Some("thumbnails/thumb_a.jpg"),
            None
        ));
        assert!(!nothing_to_clean_up(
            None,
            None,
            Some("live_chat/a.json.gz")
        ));
        assert!(!nothing_to_clean_up(
            Some("video/media_a.mp4"),
            Some("thumbnails/thumb_a.jpg"),
            None
        ));
        assert!(!nothing_to_clean_up(
            Some("video/media_a.mp4"),
            Some("thumbnails/thumb_a.jpg"),
            Some("live_chat/a.json.gz")
        ));
    }

    #[test]
    fn the_duplicate_pre_check_applies_only_to_a_yt_dlp_source_with_a_resolved_video_id() {
        // Both halves, because both flips are silent: run it for a local import and the query
        // always answers "no" (there is no video id to match), skip it for a yt-dlp source and the
        // whole video downloads before the unique index refuses it.
        assert!(needs_youtube_duplicate_pre_check(&with_video_id(
            MediaSourceMode::YtDlp,
            Some("abc")
        )));

        assert!(!needs_youtube_duplicate_pre_check(&with_video_id(
            MediaSourceMode::YtDlp,
            None
        )));

        assert!(!needs_youtube_duplicate_pre_check(&with_video_id(
            MediaSourceMode::Local,
            Some("abc")
        )));

        assert!(!needs_youtube_duplicate_pre_check(&with_video_id(
            MediaSourceMode::Local,
            None
        )));
    }

    /// A run id no other test in this process uses, so registering it cannot collide with a
    /// concurrently running test's entry in the process-wide download registry.
    fn unique_run_id(label: &str) -> String {
        format!(
            "import-{label}-{}",
            crate::utils::naming::unique_temp_suffix()
        )
    }

    #[test]
    fn a_well_formed_run_id_makes_a_local_import_cancellable() {
        // What the Cancel button rests on: the run has to reach the registry, because that is what
        // `cancel_media_download(runId)` looks the flag up in. Returning `None` here is a Cancel
        // button that silently does nothing. No error, no log the user sees, just a click that
        // does not land.
        //
        // The guard is bound rather than dropped immediately: dropping it unregisters the run, and
        // the flag would then belong to an id the cancel command can no longer find, which is the
        // same silent failure by a different route.
        let run_id = unique_run_id("valid");

        let cancellation = local_import_cancellation(&run_id)
            .expect("a well-formed run id should register and be cancellable");

        let (flag, _release) = cancellation;

        assert!(
            !flag.load(std::sync::atomic::Ordering::SeqCst),
            "a freshly registered run starts uncancelled"
        );
    }

    #[test]
    fn a_malformed_run_id_is_refused_without_reaching_the_registry() {
        // The non-empty half of the guard, and the reason it is `||` rather than `&&`. An empty id
        // is refused either way, so it proves nothing: with `&&` the two conditions both hold for
        // `""` and the refusal still happens. Only a value that is *present but malformed* tells
        // the two apart (weakened to `&&` this falls through and registers a run id that
        // `is_valid_run_id` exists to keep out of a temp-directory name.
        // `..` is deliberately absent: it satisfies `is_valid_run_id`, and correctly so), the id
        // only ever becomes one component of `{run_id}-{suffix}`, so `..-<suffix>` is an ordinary
        // directory name and never a parent reference. What the rule keeps out is a separator.
        for malformed in ["has space", "a/b", "../evil", "x".repeat(200).as_str()] {
            assert!(
                local_import_cancellation(malformed).is_none(),
                "{malformed:?} should not be registered as a cancellable run"
            );
        }
    }

    #[test]
    fn a_blank_run_id_simply_is_not_cancellable() {
        // The three ways a caller legitimately has no run id: an older frontend that sends none, a
        // caller with no Cancel button to offer, and whitespace that trims to nothing. None is an
        // error (the import still runs, it just cannot be cancelled), so this pins that the
        // function answers `None` rather than refusing the import.
        assert!(local_import_cancellation("").is_none());
        assert!(local_import_cancellation("   ").is_none());
    }

    #[test]
    fn the_same_run_id_cannot_be_registered_twice() {
        // A duplicate id means this run is already registered, which the registry refuses, and the
        // documented response is an uncancellable import rather than a refused one. Holding the
        // first guard is what keeps the entry alive for the second call to collide with.
        let run_id = unique_run_id("duplicate");

        let first = local_import_cancellation(&run_id).expect("the first registration succeeds");

        assert!(
            local_import_cancellation(&run_id).is_none(),
            "a second registration of a live run id degrades to uncancellable"
        );

        drop(first);

        // Released with the guard, so the id is usable again. Otherwise a retried import of the
        // same file would be permanently uncancellable for the rest of the session.
        assert!(local_import_cancellation(&run_id).is_some());
    }

    #[test]
    fn the_source_mode_deserializes_from_the_wire_spelling() {
        // The frontend has always sent these two literals; the enum has to accept exactly them, and
        // nothing else. An unrecognized mode must fail to deserialize rather than default to one.
        assert_eq!(
            serde_json::from_str::<MediaSourceMode>("\"local\"").unwrap(),
            MediaSourceMode::Local
        );
        assert_eq!(
            serde_json::from_str::<MediaSourceMode>("\"yt-dlp\"").unwrap(),
            MediaSourceMode::YtDlp
        );
        assert!(serde_json::from_str::<MediaSourceMode>("\"ytdlp\"").is_err());
        assert!(serde_json::from_str::<MediaSourceMode>("\"YtDlp\"").is_err());
    }

    // The registration half of a creation, driven end to end on a mock runtime.
    //
    // Everything above this point tests a pure decision. This block tests the *ordering* (the crash
    // marker written after the artifacts and cleared only once the row has landed or their cleanup
    // has run), which is the part of this module a mistake in costs a user their data, and which had
    // no test at all. It could not have one: `AppHandle` alone is `AppHandle<Wry>`, so every
    // function in the chain was unreachable from `tauri::test::mock_builder`'s `MockRuntime` app.
    // Widening the chain to `R: Runtime` is what these assert against.
    //
    // Deliberately not covered here: the artifact *production* above it. That runs yt-dlp, FFmpeg
    // and an HTTP fetch, none of which belongs in a unit test, and it is also the half where a
    // failure is loud. The registration is the quiet one.
    mod registration {
        use super::*;
        use crate::services::database::{get_app_settings_from_pool, set_app_settings_in_pool, Db};
        use crate::services::video_repository;
        use std::path::{Path, PathBuf};
        use tauri::test::{mock_builder, mock_context, noop_assets};
        use tauri::Manager;

        type MockApp = tauri::App<tauri::test::MockRuntime>;

        /// A mock app holding an in-memory database with the real schema and one channel, plus a
        /// library directory on disk whose path is persisted in settings.
        ///
        /// The library is real rather than mocked because the failure path unlinks from it: a
        /// cleanup that could not reach the library would report "unavailable" and the test would
        /// pass without proving anything was removed.
        /// `async` rather than blocking on the setup: these are `#[tokio::test]`s, so a
        /// `block_on` here starts a runtime from inside one and panics before any assertion runs.
        async fn app_with_library(label: &str) -> (MockApp, PathBuf) {
            let library = std::env::temp_dir().join(format!(
                "kavynex_mediareg_{label}_{}",
                crate::utils::naming::unique_temp_suffix()
            ));
            std::fs::create_dir_all(library.join(crate::constants::LIBRARY_DIR_VIDEO)).unwrap();

            let app = mock_builder().build(mock_context(noop_assets())).unwrap();

            let pool = sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            crate::services::db_schema::ensure_schema(&pool)
                .await
                .unwrap();

            sqlx::query("INSERT INTO channels (id, name, youtube_handle) VALUES (1, 'C', '@c')")
                .execute(&pool)
                .await
                .unwrap();

            let mut settings = get_app_settings_from_pool(&pool).await.unwrap();
            settings.library_path = Some(library.to_string_lossy().to_string());
            set_app_settings_in_pool(&pool, &settings).await.unwrap();

            app.manage(Db::from_pool(pool));

            (app, library)
        }

        /// Writes a media file into the library and returns the artifacts naming it, exactly as the
        /// production step would have left them.
        fn artifacts_on_disk(library: &Path, name: &str) -> PreparedArtifacts {
            let relative = format!("{}/{name}", crate::constants::LIBRARY_DIR_VIDEO);
            std::fs::write(library.join(&relative), b"media bytes").unwrap();

            PreparedArtifacts {
                file_path: relative,
                thumbnail_path: None,
                media_type: "video".to_string(),
                youtube_video_id: None,
                published_at: None,
                is_live: false,
                live_chat_file_path: None,
            }
        }

        /// How many crash markers currently name `file_path`.
        ///
        /// Matched on the marker's contents rather than counted, because the cache directory is the
        /// real per-OS one: another test in this process (or a running app) has markers there too,
        /// and a bare count would make this assert about them.
        fn markers_naming(app: &MockApp, file_path: &str) -> usize {
            let dir = match app.path().app_cache_dir() {
                Ok(cache) => cache.join(crate::constants::TEMP_DIR_PENDING_MEDIA),
                Err(_) => return 0,
            };

            let Ok(entries) = std::fs::read_dir(&dir) else {
                return 0;
            };

            entries
                .flatten()
                .filter(|entry| {
                    std::fs::read_to_string(entry.path())
                        .is_ok_and(|contents| contents.contains(file_path))
                })
                .count()
        }

        #[tokio::test]
        async fn a_registered_media_lands_as_a_row_and_leaves_no_marker_behind() {
            // The happy path's whole contract in one place: the row exists afterwards, and the
            // marker that described the window before it does not. A marker left behind is not
            // cosmetic. The startup sweep reads it and hands its paths to a cleanup that unlinks
            // files, so a creation that succeeded but failed to clear its marker is a video the next
            // launch may delete.
            let (app, library) = app_with_library("registered").await;
            let prepared = artifacts_on_disk(&library, "media_ok.mp4");
            let file_path = prepared.file_path.clone();

            let created =
                register_prepared_media(app.handle(), &request(MediaSourceMode::Local), prepared)
                    .await
                    .expect("a valid registration should succeed");

            assert_eq!(created.file_path, file_path);
            assert!(created.id > 0);

            let pool = crate::services::database::shared_pool(app.handle())
                .await
                .unwrap();
            assert!(
                video_repository::find_media_by_channel_and_file_path(&pool, 1, &file_path)
                    .await
                    .unwrap()
                    .is_some(),
                "the row the artifacts were registered as must exist"
            );

            assert_eq!(
                markers_naming(&app, &file_path),
                0,
                "a creation that reached its row must not leave a crash marker behind"
            );
            assert!(
                library.join(&file_path).exists(),
                "a successful registration must not touch the artifacts"
            );

            let _ = std::fs::remove_dir_all(&library);
        }

        #[tokio::test]
        async fn a_refused_duplicate_keeps_the_file_the_existing_row_points_at() {
            // A refused registration cleans up "its" artifacts, and this pins what that must not
            // mean. The artifacts are content-addressed, so the duplicate the insert refuses
            // resolves to the *same file* the row already there points at, and the cleanup is
            // reference-counted precisely so it keeps that one. Deleting it would take the existing
            // media's file away as a side effect of refusing to add it twice, which is the worst
            // outcome available on this path: an error the user shrugs off, and a video gone.
            let (app, library) = app_with_library("duplicate").await;
            let prepared = artifacts_on_disk(&library, "media_dup.mp4");
            let file_path = prepared.file_path.clone();

            let pool = crate::services::database::shared_pool(app.handle())
                .await
                .unwrap();
            video_repository::insert_media(
                &pool,
                1,
                "Already there",
                &file_path,
                None,
                "video",
                None,
                None,
                None,
                false,
                None,
            )
            .await
            .unwrap();

            let error =
                register_prepared_media(app.handle(), &request(MediaSourceMode::Local), prepared)
                    .await
                    .expect_err("a file path this channel already holds must be refused");

            assert_eq!(
                error.code,
                AppErrorCode::VideoAlreadyExistsForChannel.as_str()
            );
            assert!(
                library.join(&file_path).exists(),
                "the file the registered row points at must survive the refusal"
            );
            assert_eq!(
                markers_naming(&app, &file_path),
                0,
                "the marker must be cleared once the cleanup it covered has run"
            );

            let _ = std::fs::remove_dir_all(&library);
        }

        #[tokio::test]
        async fn a_registration_that_cannot_insert_removes_the_artifacts_nothing_references() {
            // The other half of the failure path: an insert that fails with no row anywhere pointing
            // at the file, so the reference count really is zero and the artifacts have to go. The
            // channel is gone (deleted while the download ran, which is how this happens in
            // practice), so the insert fails on the foreign key.
            //
            // All three consequences are asserted together because any one alone can pass while the
            // ordering is wrong: the error reaches the caller, the unreferenced file is gone, and
            // the marker is cleared. The marker last, because until the cleanup has run it is the
            // only record of what is on disk.
            let (app, library) = app_with_library("orphaned").await;
            let prepared = artifacts_on_disk(&library, "media_orphan.mp4");
            let file_path = prepared.file_path.clone();

            let missing_channel = CreateMediaRequest {
                channel_id: 4242,
                ..request(MediaSourceMode::Local)
            };

            register_prepared_media(app.handle(), &missing_channel, prepared)
                .await
                .expect_err("an insert against a channel that does not exist must fail");

            assert!(
                !library.join(&file_path).exists(),
                "artifacts no row references must not be left in the library"
            );
            assert_eq!(
                markers_naming(&app, &file_path),
                0,
                "the marker must be cleared once the cleanup it covered has run"
            );

            let _ = std::fs::remove_dir_all(&library);
        }

        #[tokio::test]
        async fn a_path_outside_the_managed_layout_is_refused_before_a_marker_exists() {
            // `ensure_managed_prepared_paths` runs before the lock and before the marker, and that
            // order is the point: a marker naming a path the layout does not own would hand the
            // startup sweep something to reconcile that this run should never have produced. So the
            // refusal has to leave nothing at all behind, not merely fail.
            let (app, library) = app_with_library("escaped").await;
            let prepared = PreparedArtifacts {
                file_path: "../outside/media_escape.mp4".to_string(),
                media_type: "video".to_string(),
                ..PreparedArtifacts::default()
            };

            let error =
                register_prepared_media(app.handle(), &request(MediaSourceMode::Local), prepared)
                    .await
                    .expect_err("a path outside the managed layout must be refused");

            assert_eq!(
                markers_naming(&app, "media_escape.mp4"),
                0,
                "nothing may be recorded for a request refused before the marker is written"
            );
            assert!(!error.code.is_empty());

            let _ = std::fs::remove_dir_all(&library);
        }
    }
}
