//! The reference-counted cleanup after a failed creation and the startup sweep, and the lock that
//! serializes both against a media registration.

use super::*;

/// The reference count and the removal plan behind [`cleanup_unreferenced_artifacts`], on a
/// connection the caller already holds.
pub(super) async fn plan_unreferenced_artifacts(
    conn: &mut SqliteConnection,
    file_path: Option<String>,
    thumbnail_path: Option<String>,
    live_chat_file_path: Option<String>,
) -> AppResult<ArtifactCleanupPlan> {
    let mut plan = ArtifactCleanupPlan::default();

    if let Some(path) = normalized(file_path) {
        plan_artifact(&mut *conn, ArtifactKind::MediaFile, path, &mut plan).await?;
    }

    if let Some(path) = normalized(thumbnail_path) {
        plan_artifact(&mut *conn, ArtifactKind::Thumbnail, path, &mut plan).await?;
    }

    if let Some(path) = normalized(live_chat_file_path) {
        plan_artifact(&mut *conn, ArtifactKind::LiveChat, path, &mut plan).await?;
    }

    Ok(plan)
}

/// Serializes a reference-counted artifact cleanup against a media registration. One static lock
/// rather than one per path, held only around milliseconds on either side, and with no state a test
/// needs to inject, like `db_backup`'s `BACKUP_IN_PROGRESS`. See the "unreferenced-artifact cleanup"
/// residual in `docs/THREAT-MODEL.md`.
pub(super) static MEDIA_REGISTRATION_LOCK: tokio::sync::Mutex<()> =
    tokio::sync::Mutex::const_new(());

/// Acquires [`MEDIA_REGISTRATION_LOCK`] for a media registration. Held by
/// `services::media_creation` from before the crash marker is written until after the row lands, so
/// a concurrent cleanup cannot observe the artifacts as unreferenced in that window.
pub async fn media_registration_guard() -> tokio::sync::MutexGuard<'static, ()> {
    MEDIA_REGISTRATION_LOCK.lock().await
}

/// Reference-counts each provided artifact path against the whole database and removes from
/// disk only the ones no row still references. Used to clean up artifacts that were prepared
/// for a media creation that never inserted a row (createMedia failing before insertMedia, a
/// local import failing mid-way, or a yt-dlp auto-downloaded thumbnail being overridden by a
/// manual one).
///
/// Media files, thumbnails and live chat replays are content-addressed and can be shared
/// (the same video added to several channels, a thumbnail reused as a channel avatar), so a
/// freshly prepared artifact can already back a registered row. Such a path is kept.
///
/// The count and the unlink run under [`MEDIA_REGISTRATION_LOCK`], which `services::media_creation`
/// takes around its marker, duplicate check and insert, so a creation on the same path is never
/// counted as absent by a cleanup about to unlink its file. A transaction cannot do that, since the
/// unlink comes after any commit. The startup sweep keeps a guard of its own on top
/// (`pending_media::marker_is_sweepable`). The whole argument is the "unreferenced-artifact cleanup"
/// residual in `docs/THREAT-MODEL.md`.
///
/// Generic over the runtime for the same reason the `_locked` variant below already is, and the
/// same reason `media_creation::register_prepared_media` was widened. The bare `AppHandle` alias is
/// `AppHandle<Wry>`, which `tauri::test::mock_builder` cannot produce, so naming it here put every
/// caller in the chain out of reach of a test. The startup sweep
/// (`services::pending_media::sweep_pending_media_artifacts`) is the caller that needed it.
pub async fn cleanup_unreferenced_artifacts<R: Runtime>(
    app: &AppHandle<R>,
    file_path: Option<String>,
    thumbnail_path: Option<String>,
    live_chat_file_path: Option<String>,
) -> AppResult<ArtifactCleanupReport> {
    let _guard = MEDIA_REGISTRATION_LOCK.lock().await;

    cleanup_unreferenced_artifacts_locked(app, file_path, thumbnail_path, live_chat_file_path).await
}

/// The body of [`cleanup_unreferenced_artifacts`], for a caller that already holds
/// [`MEDIA_REGISTRATION_LOCK`].
///
/// It exists because the creation's own failure path has to clean up while still holding that lock.
/// Taking it a second time would deadlock, and releasing it first would reopen the window between
/// the failed insert and the unlink. Every other caller goes through the public function above.
/// Generic over the runtime for the reason [`crate::services::database::shared_pool`] is. The bare
/// `AppHandle` alias is `AppHandle<Wry>`, which no mock-runtime test can produce, and this is one of
/// the steps inside the media-registration critical section a test has to be able to drive.
pub(crate) async fn cleanup_unreferenced_artifacts_locked<R: Runtime>(
    app: &AppHandle<R>,
    file_path: Option<String>,
    thumbnail_path: Option<String>,
    live_chat_file_path: Option<String>,
) -> AppResult<ArtifactCleanupReport> {
    let pool = shared_pool(app).await?;

    let mut conn = pool
        .acquire()
        .await
        .map_err(|error| db_error("failed to acquire a database connection", error))?;

    let plan =
        plan_unreferenced_artifacts(&mut conn, file_path, thumbnail_path, live_chat_file_path)
            .await?;

    drop(conn);

    // `_locked`, not `execute_plan`. This function's caller already holds
    // MEDIA_REGISTRATION_LOCK, and taking it again would deadlock on the non-reentrant mutex.
    execute_plan_locked(app, plan).await
}

/// Like [`cleanup_unreferenced_artifacts`], but moves what no row references into the library's
/// `.trash` folder instead of deleting it.
///
/// For the artifacts of a media creation that never registered, which is where a finished download
/// ends up when its insert fails or the process dies before it. The download may be of something that
/// is no longer on YouTube, so the file is kept for [`ORPHAN_GRACE_PERIOD`] rather than unlinked.
pub async fn trash_unreferenced_artifacts<R: Runtime>(
    app: &AppHandle<R>,
    file_path: Option<String>,
    thumbnail_path: Option<String>,
    live_chat_file_path: Option<String>,
) -> AppResult<ArtifactCleanupReport> {
    let _guard = MEDIA_REGISTRATION_LOCK.lock().await;

    trash_unreferenced_artifacts_locked(app, file_path, thumbnail_path, live_chat_file_path).await
}

/// The body of [`trash_unreferenced_artifacts`], for a caller that already holds
/// [`MEDIA_REGISTRATION_LOCK`] (see [`cleanup_unreferenced_artifacts_locked`]).
pub(crate) async fn trash_unreferenced_artifacts_locked<R: Runtime>(
    app: &AppHandle<R>,
    file_path: Option<String>,
    thumbnail_path: Option<String>,
    live_chat_file_path: Option<String>,
) -> AppResult<ArtifactCleanupReport> {
    let pool = shared_pool(app).await?;

    let mut conn = pool
        .acquire()
        .await
        .map_err(|error| db_error("failed to acquire a database connection", error))?;

    let mut plan =
        plan_unreferenced_artifacts(&mut conn, file_path, thumbnail_path, live_chat_file_path)
            .await?;

    drop(conn);

    if plan.deletable.is_empty() {
        return Ok(report_for_nothing_deletable(plan));
    }

    // Reachable, not only configured. A file missing from a folder that is not mounted reads as
    // already gone, and would be reported as moved to the trash.
    let library_dir = reachable_library_dir(app).await;

    drop_paths_referenced_again(&pool, &mut plan).await;

    let library_dir = match library_dir {
        Ok(dir) => dir,
        Err(error) => {
            logger::error(
                "library_cleanup",
                format!("cannot move artifacts to the trash, library is not available: {error}"),
            );

            return Ok(report_for_unavailable_library(plan));
        }
    };

    let display_dir = thumb_display_dir_async(app).await.ok();
    let skipped_shared_paths = plan.skipped_shared_paths;

    let mut report = run_blocking(move || {
        Ok(move_orphans_to_trash_sync(
            &library_dir,
            display_dir.as_deref(),
            plan.deletable,
        ))
    })
    .await?;

    report.skipped_shared_paths = skipped_shared_paths;

    Ok(report)
}
