//! Creating a media, end to end, as one backend operation.
//!
//! Adding a media is not one step. The artifacts have to be produced (a yt-dlp download or a local
//! import, plus a thumbnail and possibly a live chat replay), and only then can the row that points
//! at them be inserted. Between those two points the files sit in the library with nothing
//! referencing them, and that window is what everything here is shaped around.
//!
//! What deliberately stayed in the renderer is everything *after* the row lands. The comment backup,
//! the live-chat notice, the duration probe. None of them is inside the window (the media is
//! registered and safe by then), and the duration probe in particular reads the file through a
//! `<video>` element, which is a webview capability rather than something to reimplement over
//! FFmpeg. It also has to stay outside the window. The probe resolves on `loadedmetadata` or
//! `error` and carries no timeout, so a source that fires neither would hang a creation that still
//! had its marker on disk.
//!
//! The ordering inside [`create_media_async`] is load-bearing in two places, and both are the same
//! rule stated twice. Never record something that is not true yet. The marker is written *after* the
//! artifacts exist, because a marker naming files that were never created would hand the startup
//! sweep paths to reconcile that no run ever wrote. And the marker is cleared *after* the row lands
//! or the cleanup has run, because clearing it earlier would drop the record precisely while it is
//! the only thing describing the state on disk.

use std::path::{Path, PathBuf};
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
use crate::utils::format::media_subdir_from_extension;
use crate::utils::path::ensure_managed_library_relative_path;
use crate::utils::path::extension_from_path;
use crate::utils::task::run_blocking;
use crate::utils::validation::ensure_valid_media_title;
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
/// here is caller-supplied and none is trusted. The library is not among them (the command fills
/// `library_path` from the settings), the title goes through the shared validator, and every produced
/// path is re-checked as a managed library-relative path before it reaches a row. The media type is
/// not asked for at all. A download reports it and a local import takes it from its extension, the
/// same rule that picks the file's subdirectory, so a row cannot say "video" about a file in
/// `audio/`.
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
    #[ts(type = "\"copy\" | \"move\"")]
    pub import_mode: ImportMode,
    /// Not sent by the renderer. `commands::media::create_media` fills it from the settings.
    #[serde(skip_deserializing)]
    #[ts(skip)]
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
/// need them. The duration probe reads `file_path`/`media_type`, the comment backup reads
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
    /// A Move import's source, still on disk until the row lands. See
    /// `library::media::StagedMediaImport`.
    pub(crate) move_source_to_remove: Option<PathBuf>,
    /// True when `file_path` is the only copy of the user's file, so neither the failure path nor
    /// the startup sweep may delete it.
    pub(crate) media_file_is_only_copy: bool,
    /// A crash marker an earlier step already recorded for these artifacts (a download records one
    /// for its file the moment it is placed). Cleared once the registration's own marker is down.
    pub(crate) interim_marker: Option<String>,
}

/// What a caller-supplied thumbnail value actually is, which decides how it is turned into a stored
/// path.
///
/// Pure and separate from the resolving, because the classification is the part with a security
/// consequence and no I/O. An absolute path is handed to the persist step, a URL to the downloader
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
/// replaced. The value can come from a database row written on another machine (an imported
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

/// Refuses a request naming a local file the backend never handed out: the media file of a local
/// import, a thumbnail on disk, or a cookies file. See `services::chosen_files`.
///
/// A string comparison only, so it runs before anything stats the paths.
pub(crate) fn ensure_request_files_were_chosen(request: &CreateMediaRequest) -> AppResult<()> {
    use crate::services::chosen_files::{ensure_chosen, ensure_chosen_if_present, ChosenFile};

    if matches!(request.source_mode, MediaSourceMode::Local) {
        ensure_chosen(ChosenFile::Source, &request.source_value)?;
    }

    if let ThumbnailSource::Local(path) =
        classify_thumbnail_source(request.thumbnail_source_path.as_deref())
    {
        ensure_chosen(ChosenFile::Source, &path)?;
    }

    ensure_chosen_if_present(ChosenFile::Source, request.cookies_path.as_deref())
}

/// Held shared by every media creation for its whole run, and exclusively by the orphan removal.
///
/// A creation writes its artifacts into the library before the row that references them lands, so
/// for that stretch they look exactly like orphans. A count checked once when the removal starts is
/// not enough, since a creation starting a moment later could place its file while the removal is
/// still listing the folder. With the gate, a creation that starts during a removal waits for it,
/// and a removal that finds a creation running is refused (`try_exclude_creations`).
static CREATION_GATE: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

/// The exclusive side of [`CREATION_GATE`], or `None` while a creation is running.
pub(crate) fn try_exclude_creations() -> Option<tokio::sync::RwLockWriteGuard<'static, ()>> {
    CREATION_GATE.try_write().ok()
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

    // Only checked for a yt-dlp source. A local import legitimately carries neither, and demanding
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

    // A calendar date, the shape the form's date field produces and the one a yt-dlp upload date is
    // normalized to. The sort by publication date compares the column as text, so anything else
    // stored here would sort somewhere arbitrary.
    let published_at = normalized_optional(request.published_at);

    if let Some(date) = published_at.as_deref() {
        if chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() || date.len() != 10 {
            return Err(AppError::from_code(
                AppErrorCode::InvalidMediaCreationArguments,
                "the publication date must be a date written as YYYY-MM-DD",
            ));
        }
    }

    Ok(CreateMediaRequest {
        title,
        source_value,
        library_path,
        thumbnail_source_path: normalized_optional(request.thumbnail_source_path),
        published_at,
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
async fn store_thumbnail_source<R: Runtime>(
    app: &AppHandle<R>,
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
async fn generate_and_store_thumbnail<R: Runtime>(
    app: &AppHandle<R>,
    source_value: &str,
    library_path: &str,
    cancel: Option<Arc<AtomicBool>>,
) -> AppResult<String> {
    let generated = {
        let app = app.clone();
        let source_value = source_value.to_string();

        run_blocking(move || {
            thumbnail::temp::generate_temporary_thumbnail_cancellable_sync(
                &app,
                &source_value,
                cancel.as_deref(),
            )
        })
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
/// distinct cases and deliberately not distinguished between them. No run id was sent (an older
/// frontend, or any caller that has no Cancel button to offer), the id is not well-formed
/// (`is_valid_run_id`, the same rule a download's id has to satisfy), or the registry refused it.
/// None of the three is a reason to refuse a file the user asked to import.
///
/// The guard is returned rather than dropped here. Dropping it would release the entry immediately
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

/// Produces the artifacts for a local import. The thumbnail first, then the media file.
///
/// That order is required rather than incidental. On a volume without hard links a `move` import
/// renames the source into the library, and the thumbnail for a file with no supplied one is
/// generated *from that source*, so generating it afterwards would run FFmpeg against a path that
/// no longer exists.
async fn prepare_local_artifacts<R: Runtime>(
    app: &AppHandle<R>,
    request: &CreateMediaRequest,
) -> AppResult<PreparedArtifacts> {
    // Registered first, so Cancel reaches the thumbnail too. It hashes the whole source to name the
    // preview, which for a long recording is the slowest step of the import.
    //
    // A registration that fails degrades to an uncancellable import rather than failing the add.
    // The two ways it can fail say why. A duplicate id means this run is already registered, and a
    // full registry means the caller is flooding run ids, neither is a reason to refuse a file the
    // user asked to import, and losing the Cancel button is the proportionate consequence.
    let cancellation = local_import_cancellation(&request.yt_dlp_run_id);
    let cancel_flag = cancellation
        .as_ref()
        .map(|(flag, _release)| Arc::clone(flag));

    let thumbnail_source = classify_thumbnail_source(request.thumbnail_source_path.as_deref());

    let thumbnail_path = match thumbnail_source {
        ThumbnailSource::Absent => {
            let generated = generate_and_store_thumbnail(
                app,
                &request.source_value,
                &request.library_path,
                cancel_flag.clone(),
            )
            .await;

            match generated {
                Ok(path) => Some(path),
                // An audio file without embedded cover art is the ordinary case, not a failure, so
                // it imports without a thumbnail. A video that cannot produce one is treated the
                // same way. The media is what the user asked for, and the card falls back to its
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

    // The run registered above is what `cancel_media_download(runId)` reaches, which is what gives
    // the modal's Cancel button something to do during a local add. A yt-dlp source registers
    // inside `download_media_from_url_async`; this is the local half of the same mechanism, using
    // the same registry so the cancel command has one meaning rather than two. A cancel heard while
    // the thumbnail was made reaches the import below, which checks the flag before it reads.
    let import_mode = request.import_mode;
    let source_value = request.source_value.clone();
    let library_path = request.library_path.clone();

    // Staged rather than imported outright. A Move leaves the source in place until
    // `register_prepared_media` has a row pointing at the library copy, so a refused insert or a
    // crash before it never costs the user their file.
    let staged = run_blocking(move || {
        library::media::stage_media_import_cancellable_sync(
            &source_value,
            import_mode,
            &library_path,
            cancel_flag.as_deref(),
        )
    })
    .await;

    let staged = match staged {
        Ok(staged) => staged,
        Err(error) => {
            // The thumbnail is already in the library and nothing will ever point at it, so hand it
            // to the reference-counted cleanup rather than leaving it behind. Reference-counted
            // because it is content-addressed. The same image may already back a registered row.
            cleanup_artifacts_best_effort(app, None, thumbnail_path, None).await;

            return Err(error);
        }
    };

    // The subdirectory names are the two media types, and the extension decides both through the
    // one function, so the row agrees with where the file landed.
    let media_type =
        media_subdir_from_extension(&extension_from_path(Path::new(&staged.relative_path)))
            .to_string();

    Ok(PreparedArtifacts {
        file_path: staged.relative_path,
        thumbnail_path,
        media_type,
        youtube_video_id: None,
        published_at: request.published_at.clone(),
        is_live: false,
        live_chat_file_path: None,
        move_source_to_remove: staged.source_to_remove,
        media_file_is_only_copy: staged.library_holds_only_copy,
        interim_marker: None,
    })
}

/// Which fetched thumbnail is left over once a supplied one has been stored, if any.
///
/// The run is told to skip its own thumbnail when the user supplied one, so a fetched file should
/// not exist here at all, but if it does, it is now referenced by nothing and belongs to the
/// reference-counted cleanup.
///
/// Pure, and extracted, because the comparison decides an *unlink*. Inverted, this discards the
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
/// Two cases. A thumbnail the user supplied wins over the one the download fetched, and the fetched
/// one is used otherwise, including when there is none. The download already tried every thumbnail
/// URL the metadata named, so a missing one is not retried here; retrying would also be the one
/// thumbnail failure able to discard a finished download.
///
/// The supplied case is the one with a loose end. The run is told to skip its own thumbnail when a
/// manual one is supplied, so a fetched file should not exist, but if one does it is now
/// unreferenced and is handed to the reference-counted cleanup rather than left in the library.
///
/// A supplied thumbnail that cannot be stored (a full disk, a preview that expired, a file that
/// went away) leaves the media without one, said in the terminal and the log. The download is
/// already in the library by then, and an image is no reason to throw it away. The live chat and
/// the fetched thumbnail follow the same rule.
async fn resolve_downloaded_thumbnail<R: Runtime>(
    app: &AppHandle<R>,
    request: &CreateMediaRequest,
    downloaded: &DownloadedMediaResult,
) -> Option<String> {
    let fetched = normalized_optional(downloaded.thumbnail_path.clone());

    match classify_thumbnail_source(request.thumbnail_source_path.as_deref()) {
        ThumbnailSource::Absent => fetched,
        supplied => match store_thumbnail_source(app, supplied, &request.library_path).await {
            Ok(stored) => {
                if let Some(discarded) = fetched_thumbnail_to_discard(fetched, stored.as_deref()) {
                    cleanup_artifacts_best_effort(app, None, Some(discarded), None).await;
                }

                stored
            }
            Err(error) => {
                logger::warn(
                    "media_creation",
                    format!("the chosen thumbnail could not be stored, saving the media without it: {error}"),
                );

                crate::services::yt_dlp::events::emit_download_log_infallible(
                    app,
                    &request.yt_dlp_run_id,
                    "The chosen thumbnail could not be saved, so the media was added without one.",
                    "system",
                );

                fetched
            }
        },
    }
}

async fn prepare_yt_dlp_artifacts<R: Runtime>(
    app: &AppHandle<R>,
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

    let thumbnail_path = resolve_downloaded_thumbnail(app, request, &downloaded).await;

    Ok(PreparedArtifacts {
        file_path: downloaded.file_path,
        thumbnail_path,
        media_type: downloaded.media_type,
        youtube_video_id: normalized_optional(downloaded.youtube_video_id),
        published_at: normalized_optional(downloaded.published_at)
            .or_else(|| request.published_at.clone()),
        is_live: downloaded.is_live,
        live_chat_file_path: normalized_optional(downloaded.live_chat_file_path),
        move_source_to_remove: None,
        media_file_is_only_copy: false,
        interim_marker: downloaded.placement_marker,
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
/// Shared by both wrappers below rather than written twice. The two differ only in which cleanup
/// they call (one holds the registration lock, one takes it), and duplicating the reporting would
/// duplicate a `warn` whose only observable effect is the log line.
fn report_cleanup_outcome(outcome: &AppResult<library::cleanup::ArtifactCleanupReport>) {
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
async fn cleanup_artifacts_best_effort<R: Runtime>(
    app: &AppHandle<R>,
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
        &library::cleanup::cleanup_unreferenced_artifacts(
            app,
            file_path,
            thumbnail_path,
            live_chat_file_path,
        )
        .await,
    );
}

/// The media file a failed registration may hand to the cleanup, or to the startup sweep through the
/// marker. `None` when the library file is the only copy of the user's file.
///
/// Pure, and shared by both, because a wrong answer here deletes the user's file. The cleanup removes
/// whatever no row references, which after a refused insert includes the only copy. Left behind
/// instead, the file is reported by Diagnostics as unreferenced and nothing is lost.
pub(crate) fn deletable_media_file(prepared: &PreparedArtifacts) -> Option<String> {
    if prepared.media_file_is_only_copy {
        return None;
    }

    Some(prepared.file_path.clone())
}

/// The same cleanup, for a caller that already holds the registration lock. Takes the whole
/// `PreparedArtifacts` because that caller always has one. Returns whether it left nothing behind
/// (see `pending_media::cleanup_reconciled`), which decides whether the marker can go.
async fn cleanup_artifacts_best_effort_locked<R: Runtime>(
    app: &AppHandle<R>,
    prepared: &PreparedArtifacts,
) -> bool {
    let file_path = deletable_media_file(prepared);

    if nothing_to_clean_up(
        file_path.as_deref(),
        prepared.thumbnail_path.as_deref(),
        prepared.live_chat_file_path.as_deref(),
    ) {
        return true;
    }

    // Into the library's trash rather than unlinked. A finished download whose insert failed may be
    // of something no longer on YouTube.
    let outcome = library::cleanup::trash_unreferenced_artifacts_locked(
        app,
        file_path,
        prepared.thumbnail_path.clone(),
        prepared.live_chat_file_path.clone(),
    )
    .await;
    report_cleanup_outcome(&outcome);

    pending_media::cleanup_reconciled(&outcome)
}

/// Removes a Move import's source now that a row points at the library copy.
///
/// Best effort. The media is registered and complete either way, so a source that cannot be removed
/// (another program holding it open on Windows, a read-only folder) is left where it was and
/// logged, which turns this one Move into a Copy rather than failing a creation that succeeded.
async fn remove_move_source_best_effort(source: Option<PathBuf>) {
    let Some(source) = source else {
        return;
    };

    let removed =
        run_blocking(move || library::media::remove_moved_import_source_sync(&source)).await;

    if let Err(error) = removed {
        logger::warn(
            "media_creation",
            format!("the media was imported, but its original file could not be removed: {error}"),
        );
    }
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
/// Best effort, exactly as it was when the renderer called it. The artifacts are already in the
/// library and the user asked for them, so failing to record the recovery hint is strictly better
/// than failing the creation over it. What is lost when it fails is one launch's automatic
/// reconciliation, and Diagnostics still reports the files.
async fn record_marker_best_effort<R: Runtime>(
    app: &AppHandle<R>,
    prepared: &PreparedArtifacts,
) -> Option<String> {
    // The sweep deletes what a marker names once nothing references it, so the only copy of a
    // user's file is left out. With nothing else to name there is no marker to write at all, and
    // asking for an empty one would only log a refusal.
    let file_path = deletable_media_file(prepared);

    if nothing_to_clean_up(
        file_path.as_deref(),
        prepared.thumbnail_path.as_deref(),
        prepared.live_chat_file_path.as_deref(),
    ) {
        return None;
    }

    let app = app.clone();
    let artifacts = PendingMediaArtifacts {
        file_path,
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
/// [`library::cleanup::media_registration_guard`]. From before the marker is written until after the
/// row lands (or its artifacts have been cleaned up). Holding it here is what keeps a concurrent
/// reference-counted cleanup from observing these artifacts as unreferenced in the one window where
/// they truly are. The window a second creation resolving to the same content-addressed path would
/// otherwise be able to act in.
///
/// It is deliberately short. The download and the import happen before it, so nothing a user waits
/// on is serialized by this lock; what is inside is a marker write, one query and one insert.
/// Generic over the runtime, and `pub(crate)` rather than private, because this is the half of a
/// creation a test can actually drive. `AppHandle` alone is `AppHandle<Wry>`, and
/// `tauri::test::mock_builder` produces a `MockRuntime` app, so naming the bare alias anywhere in
/// this chain put the ordering below out of reach of every test in the crate.
///
/// The artifact *production* above it stays runtime-bound and is not covered by this. It runs
/// yt-dlp, FFmpeg and an HTTP fetch, none of which a unit test drives. What is covered is the part
/// where an ordering mistake costs a user their data.
pub(crate) async fn register_prepared_media<R: Runtime>(
    app: &AppHandle<R>,
    request: &CreateMediaRequest,
    mut prepared: PreparedArtifacts,
) -> AppResult<CreatedMedia> {
    ensure_managed_prepared_paths(&prepared)?;

    let _guard = library::cleanup::media_registration_guard().await;

    let marker = record_marker_best_effort(app, &prepared).await;

    // The marker above names everything the interim one did and more, so the interim one goes once
    // it is down. If it could not be written, the interim one is still covering the media file and
    // stays until the outcome below.
    let interim_marker = if marker.is_some() {
        clear_marker_best_effort(app, prepared.interim_marker.take()).await;
        None
    } else {
        prepared.interim_marker.take()
    };

    let inserted = insert_prepared_media(app, request, &mut prepared).await;

    match inserted {
        Ok(id) => {
            clear_marker_best_effort(app, marker).await;
            clear_marker_best_effort(app, interim_marker).await;

            // Only now, with a row pointing at the library copy, is the Move source no longer the
            // thing standing between the user and losing the file.
            remove_move_source_best_effort(prepared.move_source_to_remove).await;

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
            // afterwards, if the process dies in between, the marker is what reconciles them. A Move
            // source is untouched here, since the source is what the user still has.
            //
            // A cleanup that could not move everything keeps the markers instead, since they are
            // then the only record of files still on disk, and the next launch's sweep retries them.
            if cleanup_artifacts_best_effort_locked(app, &prepared).await {
                clear_marker_best_effort(app, marker).await;
                clear_marker_best_effort(app, interim_marker).await;
            } else {
                for kept in [marker, interim_marker].into_iter().flatten() {
                    pending_media::leave_marker_for_next_sweep(&kept);
                }
            }

            Err(error)
        }
    }
}

/// The existence re-checks, the duplicate check and the insert.
///
/// The pre-insert lookup exists for its message rather than for correctness. `(channel_id,
/// file_path)` is unique in the schema, so a duplicate would be refused either way, just as a
/// constraint violation rather than as "this media is already registered for the selected channel".
///
/// The existence re-checks are the ones about correctness, and they are here rather than in
/// `prepare_*` precisely because they have to run **inside** the critical section. The artifacts land
/// before [`register_prepared_media`] takes the lock, so a concurrent delete unlinking a
/// content-addressed file this creation is adopting is not excluded by the lock and cannot be.
/// Covering that window would mean holding the lock across a download, which the lock's own
/// documentation rules out. `library::cleanup::execute_plan` now takes the same lock, so nothing can
/// unlink between these checks and the insert below. What the earlier window can still cost is a
/// refused creation when the media file went, or a media registered without its thumbnail or live
/// chat replay when one of those went, never a row pointing at a file that is gone.
///
/// A vanished thumbnail or replay is dropped from `prepared` rather than failing the creation. The
/// media is what the user asked for and outlives either, and the caller reports what was registered.
async fn insert_prepared_media<R: Runtime>(
    app: &AppHandle<R>,
    request: &CreateMediaRequest,
    prepared: &mut PreparedArtifacts,
) -> AppResult<i64> {
    let library_dir = library::guard::configured_library_dir(app).await?;
    let media_file = library_dir.join(&prepared.file_path);
    let thumbnail = prepared.thumbnail_path.clone();
    let live_chat = prepared.live_chat_file_path.clone();

    let (media_exists, thumbnail_gone, live_chat_gone) = run_blocking(move || {
        Ok((
            media_file.exists(),
            is_gone_from_library(&library_dir, thumbnail.as_deref()),
            is_gone_from_library(&library_dir, live_chat.as_deref()),
        ))
    })
    .await?;

    if !media_exists {
        return Err(AppError::from_code(
            AppErrorCode::MediaFileNotFound,
            "the prepared media file is no longer in the library; it was removed before the row \
             could be inserted",
        ));
    }

    if thumbnail_gone {
        drop_vanished_sidecar(&mut prepared.thumbnail_path, "thumbnail");
    }

    if live_chat_gone {
        drop_vanished_sidecar(&mut prepared.live_chat_file_path, "live chat replay");
    }

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
        // Left unset on purpose. The duration is probed by the renderer once the row exists, through
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

/// True when `relative` names a file the library no longer holds. `None` has nothing to lose.
fn is_gone_from_library(library_dir: &Path, relative: Option<&str>) -> bool {
    relative.is_some_and(|relative| !library_dir.join(relative).is_file())
}

fn drop_vanished_sidecar(slot: &mut Option<String>, kind: &str) {
    if let Some(relative) = slot.take() {
        logger::warn(
            "media_creation",
            format!(
                "registering the media without its {kind}: {} was removed from the library while \
                 the media was being prepared",
                logger::redact_path(&relative)
            ),
        );
    }
}

/// True when the pre-check applies. A yt-dlp source whose video id was resolved up front.
///
/// Pure, and extracted, because inverting the mode comparison is silent in both directions. A local
/// import would run a query that always answers "no" (it carries no video id), and a re-added
/// YouTube video would download in full before the unique index refused it. Neither is a crash, and
/// the caller needs an `AppHandle`, so nothing observed the flip until this moved here.
pub(crate) fn needs_youtube_duplicate_pre_check(request: &CreateMediaRequest) -> bool {
    request.source_mode == MediaSourceMode::YtDlp && request.yt_dlp_youtube_video_id.is_some()
}

/// Refuses a creation for a channel that does not exist, before anything is imported or downloaded.
///
/// The foreign key refuses the insert anyway, but only after the whole file has been copied or
/// fetched. Checked here, the user hears it before waiting on a transfer that was never going to
/// land.
async fn ensure_channel_exists<R: Runtime>(app: &AppHandle<R>, channel_id: i64) -> AppResult<()> {
    let pool = shared_pool(app).await?;

    if crate::services::channel_repository::get_channel_by_id(&pool, channel_id)
        .await?
        .is_none()
    {
        return Err(AppError::from_code(
            AppErrorCode::ChannelNotFound,
            "the channel this media was being added to no longer exists",
        ));
    }

    Ok(())
}

/// Refuses a yt-dlp source whose video is already registered for this channel, before downloading it.
///
/// The id comes from the metadata fetch the format picker already ran, so this costs one query and
/// saves a whole download. The guarantee is the partial unique index on
/// `(channel_id, youtube_video_id)`. This is the difference between failing now and failing
/// after a gigabyte.
async fn ensure_youtube_media_is_new<R: Runtime>(
    app: &AppHandle<R>,
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

/// Creates a media. Produces its artifacts, records the crash marker, inserts the row, clears the
/// marker.
///
/// `library_path` is verified against the persisted settings by the command layer before this runs,
/// like every other library write.
pub async fn create_media_async<R: Runtime>(
    app: &AppHandle<R>,
    request: CreateMediaRequest,
) -> AppResult<CreatedMedia> {
    let _creation = CREATION_GATE.read().await;
    let request = normalize_create_media_request(request)?;

    ensure_channel_exists(app, request.channel_id).await?;

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
mod tests;
