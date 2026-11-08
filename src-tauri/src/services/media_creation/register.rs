//! The critical section that records the crash marker and inserts the row, and the gate that keeps
//! the orphan removal and the library move from running beside a creation.

use super::*;

/// Held shared by every media creation for its whole run, and exclusively by the orphan removal and
/// the library move.
///
/// A creation writes its artifacts into the library before the row that references them lands, so
/// for that stretch they look exactly like orphans. A count checked once when the removal starts is
/// not enough, since a creation starting a moment later could place its file while the removal is
/// still listing the folder. With the gate, a creation that starts during a removal waits for it,
/// and a removal that finds a creation running is refused (`try_exclude_creations`).
///
/// The move needs the same exclusion for a different reason. A creation reads the library folder
/// once and a download can run for hours, so a move that finished in the meantime would leave the
/// file in the folder the library left. The move is refused while a creation runs, and a creation
/// that starts during a move waits for it and then reads the new folder.
pub(super) static CREATION_GATE: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

/// The exclusive side of [`CREATION_GATE`], or `None` while a creation is running.
pub(crate) fn try_exclude_creations() -> Option<tokio::sync::RwLockWriteGuard<'static, ()>> {
    CREATION_GATE.try_write().ok()
}

/// Re-checks every produced path as a managed library-relative path before it can reach a row.
///
/// The paths come from this crate's own producers, so this should never fire, which is the reason
/// it is here rather than trusted. The deletion path acts on whatever these rows hold, so a stored
/// path that escaped the managed layout would turn a later delete into an operation outside it, and
/// this is the last point at which that can still be refused for free.
pub(super) fn ensure_managed_prepared_paths(prepared: &PreparedArtifacts) -> AppResult<()> {
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
pub(super) async fn record_marker_best_effort<R: Runtime>(
    app: &AppHandle<R>,
    prepared: &PreparedArtifacts,
) -> Option<String> {
    // The sweep deletes what a marker names once nothing references it, so the only copy of a
    // user's file is left out. With nothing else to name there is no marker to write at all, and
    // asking for an empty one would only log a refusal.
    let file_path = deletable_media_file(prepared);

    // A renamed file is not left out, though. It is named as moved, which the sweep puts back where
    // the user had it rather than handing to the cleanup.
    let moved_from = prepared
        .renamed_from
        .as_ref()
        .map(|from| from.to_string_lossy().into_owned());

    if moved_from.is_none()
        && nothing_to_clean_up(
            file_path.as_deref(),
            prepared.thumbnail_path.as_deref(),
            prepared.live_chat_file_path.as_deref(),
        )
    {
        return None;
    }

    let app = app.clone();
    let artifacts = PendingMediaArtifacts {
        file_path,
        thumbnail_path: prepared.thumbnail_path.clone(),
        live_chat_file_path: prepared.live_chat_file_path.clone(),
        moved_file_path: moved_from.as_ref().map(|_| prepared.file_path.clone()),
        moved_from,
        // The sweep's own retry bookkeeping. A fresh record always starts at zero, which
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

pub(super) async fn clear_marker_best_effort<R: Runtime>(
    app: &AppHandle<R>,
    marker: Option<String>,
) {
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
/// The critical section, all of it under [`library::cleanup::media_registration_guard`], from
/// before the marker is written until after the row lands (or its artifacts are cleaned up), so a
/// concurrent cleanup cannot count these artifacts as unreferenced while they are. Only a marker
/// write, one query and one insert, since the download and the import happen before it. See the
/// "unreferenced-artifact cleanup" residual in `docs/THREAT-MODEL.md`.
/// Generic over the runtime, and `pub(crate)` rather than private, because this is the half of a
/// creation a test can actually drive. `AppHandle` alone is `AppHandle<Wry>`, and
/// `tauri::test::mock_builder` produces a `MockRuntime` app, so naming the bare alias anywhere in
/// this chain puts the ordering below out of reach of every test in the crate.
///
/// The artifact *production* above it stays runtime-bound and is not covered by this. It runs
/// yt-dlp, FFmpeg and an HTTP fetch, none of which a unit test drives. What is covered is the part
/// where an ordering mistake costs a user their data.
pub(crate) async fn register_prepared_media<R: Runtime>(
    app: &AppHandle<R>,
    request: &CreateMediaRequest,
    mut prepared: PreparedArtifacts,
) -> AppResult<CreatedMedia> {
    // Checked here, and refused through the failure branch below rather than returned on the
    // spot. Returning skipped putting a renamed file back and left the thumbnail and the replay in
    // the library with nothing pointing at them. No marker is written for paths that failed it,
    // and the interim one, if any, is kept.
    let managed = ensure_managed_prepared_paths(&prepared);

    let _guard = library::cleanup::media_registration_guard().await;

    let marker = if managed.is_ok() {
        record_marker_best_effort(app, &prepared).await
    } else {
        None
    };

    // The marker above names everything the interim one did and more, so the interim one goes once
    // it is down. If it could not be written, the interim one is still covering the media file and
    // stays until the outcome below.
    let interim_marker = if marker.is_some() {
        clear_marker_best_effort(app, prepared.interim_marker.take()).await;
        None
    } else {
        prepared.interim_marker.take()
    };

    let inserted = match managed {
        Ok(()) => insert_prepared_media(app, request, &mut prepared).await,
        Err(error) => Err(error),
    };

    match inserted {
        Ok(id) => {
            clear_marker_best_effort(app, marker).await;
            clear_marker_best_effort(app, interim_marker).await;

            // Only now, with a row pointing at the library copy, is the Move source no longer the
            // thing standing between the user and losing the file.
            let original_kept =
                remove_move_source_best_effort(prepared.move_source_to_remove).await;

            Ok(CreatedMedia {
                id,
                file_path: prepared.file_path,
                thumbnail_path: prepared.thumbnail_path,
                media_type: prepared.media_type,
                youtube_video_id: prepared.youtube_video_id,
                live_chat_file_path: prepared.live_chat_file_path,
                is_live: prepared.is_live,
                original_kept,
            })
        }
        Err(error) => {
            let (error, file_is_back) = put_renamed_file_back(request, &prepared, error).await;

            // The cleanup runs while the lock is still held, so the count it takes cannot race a
            // creation that would have adopted these same paths, and the marker is cleared only
            // afterwards. If the process dies in between, the marker is what reconciles them. A
            // Move source is untouched here, since the source is what the user still has.
            //
            // A cleanup that could not move everything keeps the markers instead, since they are
            // then the only record of files still on disk, and the next launch's sweep retries them.
            // So does a renamed file that could not go back, which the sweep tries again.
            if cleanup_artifacts_best_effort_locked(app, &prepared).await && file_is_back {
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

/// Undoes a Move that renamed the user's file into the library, once its registration failed.
///
/// The library file is then the only copy, and leaving it there as an unreferenced file is what
/// Diagnostics would offer to move to the trash. Renamed back to where the user had it, the failed
/// import leaves things as they were. When that is not possible (the name was taken meanwhile, the
/// rename failed), the error says where the file is, so the user can import it again from there.
///
/// Also says whether the user's file is out of the library now (put back, or never renamed in), which
/// decides whether the crash markers naming it may go.
pub(super) async fn put_renamed_file_back(
    request: &CreateMediaRequest,
    prepared: &PreparedArtifacts,
    error: AppError,
) -> (AppError, bool) {
    let Some(original) = prepared.renamed_from.clone() else {
        return (error, true);
    };

    let library_path = request.library_path.clone();
    let relative = prepared.file_path.clone();

    let restored = crate::utils::task::run_blocking(move || {
        let in_library = crate::utils::path::absolute_path_from_relative(
            Path::new(&library_path),
            &relative,
            crate::utils::path::ManagedSubtree::Media,
        )?;

        if original.exists() {
            return Ok(false);
        }

        crate::services::filesystem::rename_retrying_patiently(&in_library, &original)
            .map(|()| true)
            .map_err(|e| {
                AppError::fs_error(
                    AppErrorCode::FileMoveFailed,
                    "failed to move the file back",
                    &original,
                    &e,
                )
            })
    })
    .await;

    match restored {
        Ok(true) => {
            logger::info(
                "media_creation",
                "the media could not be registered, so the moved file was put back where it was",
            );
            (error, true)
        }
        _ => {
            let note = format!(
                "The file was moved into the library as {} and is not in any channel. Add it again \
                 as a local file from there, or move it out by hand.",
                prepared.file_path
            );
            let details = match error.details.as_deref() {
                Some(existing) => format!("{existing}\n{note}"),
                None => note,
            };

            (
                AppError {
                    details: Some(details),
                    ..error
                },
                false,
            )
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
pub(super) async fn insert_prepared_media<R: Runtime>(
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
        // it *before* the insert would put an un-timeout-ed promise inside the window this
        // function exists to keep short.
        None,
        prepared.is_live,
        prepared.live_chat_file_path.as_deref(),
    )
    .await
}

/// True when `relative` names a file the library no longer holds. `None` has nothing to lose.
pub(super) fn is_gone_from_library(library_dir: &Path, relative: Option<&str>) -> bool {
    relative.is_some_and(|relative| !library_dir.join(relative).is_file())
}

pub(super) fn drop_vanished_sidecar(slot: &mut Option<String>, kind: &str) {
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
pub(super) async fn ensure_channel_exists<R: Runtime>(
    app: &AppHandle<R>,
    channel_id: i64,
) -> AppResult<()> {
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
pub(super) async fn ensure_youtube_media_is_new<R: Runtime>(
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
/// The library is the configured one, read from the settings once the gate is held. A library move
/// is refused while a creation holds the gate and stores its new folder before letting go of it,
/// so a creation that waited for a move reads the folder the library is in now rather than the one
/// it left. Whatever `library_path` the request carried is replaced.
pub async fn create_media_async<R: Runtime>(
    app: &AppHandle<R>,
    mut request: CreateMediaRequest,
) -> AppResult<CreatedMedia> {
    let _creation = CREATION_GATE.read().await;
    request.library_path = library::guard::configured_library_path(app).await?;
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
