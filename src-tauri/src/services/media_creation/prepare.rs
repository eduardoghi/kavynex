//! Producing a creation's artifacts in the library, from a local import or a yt-dlp download, with
//! the thumbnail that goes with them.

use super::*;

/// Turns a classified thumbnail source into a stored, library-relative path.
///
/// `Managed` is returned untouched. It already names a file in the library, and re-persisting it
/// would copy a file onto itself. The other two go through the persist/download functions.
pub(super) async fn store_thumbnail_source<R: Runtime>(
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
pub(super) async fn generate_and_store_thumbnail<R: Runtime>(
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
pub(super) fn local_import_cancellation(
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
pub(super) async fn prepare_local_artifacts<R: Runtime>(
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
    // inside `download_media_from_url_async`. This is the local half of the same mechanism, using
    // the same registry so the cancel command has one meaning rather than two. A cancel heard while
    // the thumbnail was made reaches the import below, which checks the flag before it reads.
    let import_mode = request.import_mode;
    let source_value = request.source_value.clone();
    let library_path = request.library_path.clone();
    let marker_app = app.clone();
    let moved_marker: Arc<std::sync::Mutex<Option<String>>> = Arc::default();
    let marker_slot = Arc::clone(&moved_marker);

    // Staged rather than imported outright. A Move leaves the source in place until
    // `register_prepared_media` has a row pointing at the library copy, so a refused insert or a
    // crash before it never costs the user their file. Where the volume cannot link and the move
    // has to rename the file in, a marker written just before says where it came from, and the
    // startup sweep puts it back if the app closes before the row lands.
    let staged = run_blocking(move || {
        let record = |relative: &str, source: &Path, mode: ImportMode| {
            let recorded = match mode {
                ImportMode::Move => {
                    pending_media::record_moved_import(&marker_app, relative, source)
                }
                // A copy leaves the source where it is, so the library file is an ordinary
                // artifact the sweep may trash if this creation never registers.
                ImportMode::Copy => pending_media::record_pending_media_artifacts(
                    &marker_app,
                    PendingMediaArtifacts {
                        file_path: Some(relative.to_string()),
                        ..PendingMediaArtifacts::default()
                    },
                ),
            };

            match recorded {
                Ok(name) => {
                    *marker_slot
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(name);
                }
                Err(error) => logger::warn(
                    "media_creation",
                    format!("could not record the import marker: {error}"),
                ),
            }
        };

        library::media::stage_media_import_recorded_sync(
            &source_value,
            import_mode,
            &library_path,
            cancel_flag.as_deref(),
            Some(&record),
        )
    })
    .await;

    let moved_marker = moved_marker
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();

    let staged = match staged {
        Ok(staged) => staged,
        Err(error) => {
            // Most failures come before the user's file is touched, and the sweep then finds it
            // still in place and only drops the marker. One after a rename finds the file in the
            // library and puts it back.
            if let Some(marker) = moved_marker {
                pending_media::leave_marker_for_next_sweep(&marker);
            }

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

    // Kept until the registration's own marker is down, so the file stays named by a marker of
    // this process the whole time its row is not in yet.
    let interim_marker = moved_marker;

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
        renamed_from: staged.renamed_from,
        interim_marker,
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
/// URL the metadata named, so a missing one is not retried here. Retrying would also be the one
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
pub(super) async fn resolve_downloaded_thumbnail<R: Runtime>(
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

pub(super) async fn prepare_yt_dlp_artifacts<R: Runtime>(
    app: &AppHandle<R>,
    request: &CreateMediaRequest,
) -> AppResult<PreparedArtifacts> {
    // A supplied thumbnail makes the run's own thumbnail fetch pointless work whose output would be
    // discarded a moment later, so it is skipped rather than downloaded and cleaned up.
    let skip_auto_thumbnail =
        supplied_thumbnail_replaces_fetched(request.thumbnail_source_path.as_deref());

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
        renamed_from: None,
        interim_marker: downloaded.placement_marker,
    })
}
