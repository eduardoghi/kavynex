//! Carrying out a committed plan, by moving its files to the library's trash or deleting them, under
//! the registration lock.

use super::*;

pub(super) fn delete_live_chat_file_at(library_dir: &Path, relative_path: &str) -> AppResult<()> {
    // Serialize against a concurrent library migration (see library::lock). Acquired once per
    // call, so the per-artifact loop in remove_planned_artifacts_sync releases between files.
    let _library_guard = crate::services::library::lock::library_read_guard();

    let absolute =
        absolute_path_from_relative(library_dir, relative_path, ManagedSubtree::LiveChat)?;

    if absolute.exists() {
        // Re-resolve symlinks and re-check containment before unlinking, matching the sibling
        // delete_media_file_sync / delete_thumbnail_file_sync. absolute_path_from_relative only
        // does a lexical check. An intermediate path component that is itself a symlink pointing
        // outside the library would otherwise let this remove a file outside the managed tree.
        ensure_existing_path_inside_dir(&absolute, library_dir)?;

        std::fs::remove_file(&absolute).map_err(|e| {
            AppError::from_code(
                AppErrorCode::RemoveMediaFailed,
                format!("failed to remove live chat file: {e}"),
            )
        })?;
    }

    Ok(())
}

/// Drops the display-sized copy of a thumbnail that has just been unlinked from the library.
///
/// Nothing else would ever remove it. A derivative is addressed by the canonical thumbnail's own
/// content hash and no row refers to one (see `services::thumbnail::display`), so the only bound on
/// that directory is the size sweep at startup, which trims oldest-first once the whole cache
/// exceeds its budget, and therefore has no relation to what was deleted. Without it, deleting a
/// media leaves its thumbnail readable in the cache directory until enough unrelated browsing
/// pushes the cache past its ceiling.
///
/// No reference counting of its own. The caller only reaches here for a path the deletion
/// transaction already found unreferenced, and the derivative is keyed by that path's content hash,
/// so two rows sharing a thumbnail share its derivative exactly as they share the file.
///
/// Best effort, and deliberately silent on failure. The canonical file is gone, which is what the
/// user asked for and what the report is about. A derivative left behind is a regenerable cache
/// entry the size sweep still reclaims, so failing the delete over it (or adding it to
/// `failed_paths`, which names files the user may need to clean up by hand) would misreport a
/// cache miss as an orphaned artifact.
///
/// A derivative written under an older [`DISPLAY_THUMBNAIL_MAX_WIDTH`] is not matched, since the
/// width is part of the name. That is the same self-invalidation the width is in the name for.
/// Nothing addresses those any more, and the size sweep is what reclaims them.
pub(super) fn drop_display_derivative(display_dir: Option<&Path>, relative_thumbnail_path: &str) {
    let Some(display_dir) = display_dir else {
        return;
    };

    let Some(derivative) = display_derivative_path(display_dir, relative_thumbnail_path) else {
        return;
    };

    let _ = std::fs::remove_file(derivative);
}

/// Removes the planned files from disk. Failures are collected in the report (and
/// logged) instead of aborting. The rows are already gone, so the caller must always
/// learn which files may have been left orphaned in the library.
///
/// `display_dir` is the display-thumbnail cache, or `None` when it could not be resolved. It is a
/// parameter rather than something looked up here so this function keeps taking only paths, which
/// is what lets a test drive the whole removal. The lookup needs an `AppHandle`.
pub fn remove_planned_artifacts_sync(
    library_dir: &Path,
    display_dir: Option<&Path>,
    plan: ArtifactCleanupPlan,
) -> ArtifactCleanupReport {
    let library_path = library_dir.to_string_lossy().to_string();

    let mut report = ArtifactCleanupReport {
        skipped_shared_paths: plan.skipped_shared_paths,
        ..ArtifactCleanupReport::default()
    };

    for artifact in plan.deletable {
        let result = match artifact.kind {
            ArtifactKind::MediaFile => delete_media_file_sync(&artifact.path, &library_path),
            ArtifactKind::Thumbnail => delete_thumbnail_file_sync(&artifact.path, &library_path),
            ArtifactKind::LiveChat => delete_live_chat_file_at(library_dir, &artifact.path),
        };

        match result {
            Ok(()) => {
                // After the canonical file is gone, not before. The derivative is the cheaper of
                // the two to lose, so a failure to unlink the thumbnail must not have already
                // discarded the copy the grid can still draw from.
                if artifact.kind == ArtifactKind::Thumbnail {
                    drop_display_derivative(display_dir, &artifact.path);
                }

                report.deleted_paths.push(artifact.path);
            }
            Err(error) => {
                logger::error(
                    "library_cleanup",
                    format!(
                        "rows were deleted but artifact '{}' could not be removed and may be orphaned: {}",
                        artifact.path, error
                    ),
                );
                report.failed_paths.push(artifact.path);
            }
        }
    }

    report
}

/// Re-verifies, after the deletion transaction has committed, that each planned artifact is still
/// unreferenced before it is unlinked from disk.
///
/// The "is this file still referenced" decision is made inside the deletion transaction, but the
/// unlink happens afterwards (the filesystem cannot join a SQLite transaction). A concurrent
/// import can dedupe onto the same content-addressed file and insert a new row pointing at it in
/// that gap, which would then be unlinked out from under the new row. This pass drops any path
/// that became referenced again, shrinking the window to the microseconds between this recount and
/// the unlink. It cannot close the window entirely (only a per-path lock spanning the count and
/// the unlink could), but it catches the realistic case where the import landed while the removal
/// was still being scheduled onto the blocking pool. Best effort. On any recount failure the
/// committed decision is kept rather than leaking a file or wrongly sparing one.
pub(super) async fn drop_paths_referenced_again(pool: &SqlitePool, plan: &mut ArtifactCleanupPlan) {
    if plan.deletable.is_empty() {
        return;
    }

    let mut conn = match pool.acquire().await {
        Ok(conn) => conn,
        Err(error) => {
            logger::warn(
                "library_cleanup",
                format!("could not re-verify artifact references before removal: {error}"),
            );
            return;
        }
    };

    let mut still_deletable = Vec::with_capacity(plan.deletable.len());

    for artifact in std::mem::take(&mut plan.deletable) {
        let remaining = match artifact.kind {
            ArtifactKind::MediaFile => {
                count_media_files_referencing(&mut conn, &artifact.path).await
            }
            ArtifactKind::Thumbnail => {
                count_thumbnails_referencing(&mut conn, &artifact.path).await
            }
            ArtifactKind::LiveChat => count_live_chats_referencing(&mut conn, &artifact.path).await,
        };

        match remaining {
            Ok(0) => still_deletable.push(artifact),
            Ok(_) => {
                logger::info(
                    "library_cleanup",
                    format!(
                        "artifact '{}' became referenced again after the delete committed; keeping it",
                        artifact.path
                    ),
                );
                plan.skipped_shared_paths.push(artifact.path);
            }
            Err(error) => {
                logger::warn(
                    "library_cleanup",
                    format!(
                        "could not re-verify references for '{}', keeping the committed decision: {error}",
                        artifact.path
                    ),
                );
                still_deletable.push(artifact);
            }
        }
    }

    plan.deletable = still_deletable;
}

/// The report for a plan with nothing to delete. Only the shared paths the planner already spared
/// are carried through. Pure so the field it populates stays under test. `execute_plan` itself
/// needs a live `AppHandle` (the shared pool, the configured library) and cannot run under the
/// unit-test harness.
pub(super) fn report_for_nothing_deletable(plan: ArtifactCleanupPlan) -> ArtifactCleanupReport {
    ArtifactCleanupReport {
        skipped_shared_paths: plan.skipped_shared_paths,
        ..ArtifactCleanupReport::default()
    }
}

/// The report for the case where the rows were already committed as deleted but the library
/// directory cannot be resolved, so no planned file can be located. Every deletable path is
/// reported as failed (possibly orphaned) and the spared shared paths are carried through. Pure
/// for the same reason as [`report_for_nothing_deletable`], so both fields it populates stay
/// tested independently of the `AppHandle`-bound `execute_plan`.
pub(super) fn report_for_unavailable_library(plan: ArtifactCleanupPlan) -> ArtifactCleanupReport {
    ArtifactCleanupReport {
        skipped_shared_paths: plan.skipped_shared_paths,
        failed_paths: plan
            .deletable
            .into_iter()
            .map(|artifact| artifact.path)
            .collect(),
        ..ArtifactCleanupReport::default()
    }
}

/// Removes a committed plan's artifacts under [`MEDIA_REGISTRATION_LOCK`], since a delete or an
/// image replace unlinks the same content-addressed files a concurrent creation can be adopting, and
/// the recount in `drop_paths_referenced_again` is not exclusion on its own. Why the lock, and the
/// window before a creation takes it that it does not cover, are in the "unreferenced-artifact
/// cleanup" residual in `docs/THREAT-MODEL.md`.
pub(super) async fn execute_plan<R: Runtime>(
    app: &AppHandle<R>,
    plan: ArtifactCleanupPlan,
    disposal: Disposal,
) -> AppResult<ArtifactCleanupReport> {
    let _guard = MEDIA_REGISTRATION_LOCK.lock().await;

    execute_plan_locked_with(app, plan, disposal).await
}

/// What a removal does with the files no row references any more.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Disposal {
    /// Removed from disk.
    Delete,
    /// Moved to the library's `.trash` folder, which the startup sweep purges after
    /// [`ORPHAN_GRACE_PERIOD`] and Settings can empty sooner.
    Trash,
}

/// What deleting a media or a channel does with its files. The trash, unless Settings says to
/// delete at once. A setting that cannot be read keeps the trash, since that is the choice a
/// mistake can be taken back from.
pub(super) async fn deletion_disposal(pool: &SqlitePool) -> Disposal {
    match get_app_settings_from_pool(pool).await {
        Ok(settings) if settings.delete_skips_trash.as_deref() == Some("true") => Disposal::Delete,
        _ => Disposal::Trash,
    }
}

/// The body of [`execute_plan`], for a caller that already holds [`MEDIA_REGISTRATION_LOCK`].
///
/// Exists for the same reason [`cleanup_unreferenced_artifacts_locked`] does. A creation's failure
/// path cleans up while still inside its own critical section, so taking the lock a second time
/// would deadlock.
pub(super) async fn execute_plan_locked<R: Runtime>(
    app: &AppHandle<R>,
    plan: ArtifactCleanupPlan,
) -> AppResult<ArtifactCleanupReport> {
    execute_plan_locked_with(app, plan, Disposal::Delete).await
}

/// [`execute_plan_locked`], with what to do with the files.
pub(super) async fn execute_plan_locked_with<R: Runtime>(
    app: &AppHandle<R>,
    mut plan: ArtifactCleanupPlan,
    disposal: Disposal,
) -> AppResult<ArtifactCleanupReport> {
    if plan.deletable.is_empty() {
        return Ok(report_for_nothing_deletable(plan));
    }

    // Resolve the library directory first, before the recount below, so the recount is the last
    // await before the blocking unlink is scheduled. The window this race is about is the gap
    // between "the file is still unreferenced" and the unlink. Keeping any other await (the library
    // resolution here) out of that gap shrinks it to the unavoidable run_blocking handoff. The
    // resolution's own result is only consumed after the recount, so this reordering leaves the
    // reporting on every path (including the library-unavailable one) exactly as it was.
    let library_dir = configured_library_dir(app).await;

    // Re-check each planned unlink against the live database. A row inserted after the deletion
    // committed (a concurrent import deduping onto the same content-addressed file) must spare it.
    if let Ok(pool) = shared_pool(app).await {
        drop_paths_referenced_again(&pool, &mut plan).await;
    }

    let library_dir = match library_dir {
        Ok(dir) => dir,
        Err(error) => {
            // The rows are already committed as deleted. Without a configured library the
            // files cannot be located, so report every planned path as failed.
            logger::error(
                "library_cleanup",
                format!("cannot remove artifacts, library is not available: {error}"),
            );

            return Ok(report_for_unavailable_library(plan));
        }
    };

    // Resolved here, alongside the library directory, because `remove_planned_artifacts_sync` takes
    // only paths. `None` when the cache directory cannot be resolved, which leaves the derivatives
    // to the size sweep rather than failing a deletion the user asked for over a cache entry.
    let display_dir = thumb_display_dir_async(app).await.ok();

    run_blocking(move || {
        Ok(match disposal {
            Disposal::Delete => {
                remove_planned_artifacts_sync(&library_dir, display_dir.as_deref(), plan)
            }
            Disposal::Trash => {
                let skipped_shared_paths = plan.skipped_shared_paths;
                let mut report = move_orphans_to_trash_sync(
                    &library_dir,
                    display_dir.as_deref(),
                    plan.deletable,
                );
                report.skipped_shared_paths = skipped_shared_paths;
                report
            }
        })
    })
    .await
}

/// The configured library folder, refused when it does not exist right now (a drive not mounted).
pub(crate) async fn reachable_library_dir<R: Runtime>(
    app: &AppHandle<R>,
) -> AppResult<std::path::PathBuf> {
    let library_path = configured_library_dir(app)
        .await?
        .to_string_lossy()
        .to_string();

    run_blocking(move || {
        crate::services::library::paths::resolve_existing_library_dir(&library_path)
    })
    .await
}

/// Whether the configured library folder exists right now, which a deletion needs to remove files.
pub(super) async fn library_is_reachable<R: Runtime>(app: &AppHandle<R>) -> bool {
    reachable_library_dir(app).await.is_ok()
}

/// Deletes a media row and removes its now-unreferenced files from disk. The row deletion
/// and the "is this file still referenced" decision happen in one transaction. File
/// removal is best-effort and reported back.
pub async fn delete_media_with_artifacts<R: Runtime>(
    app: &AppHandle<R>,
    media_id: i64,
) -> AppResult<ArtifactCleanupReport> {
    let pool = shared_pool(app).await?;
    let library_reachable = library_is_reachable(app).await;
    let disposal = deletion_disposal(&pool).await;

    match delete_media_row_and_plan_cleanup(&pool, media_id, library_reachable).await? {
        Some(plan) => execute_plan(app, plan, disposal).await,
        None => Ok(ArtifactCleanupReport::default()),
    }
}

/// Deletes a channel row (cascading its media and comments) and removes the
/// now-unreferenced files from disk.
pub async fn delete_channel_with_artifacts<R: Runtime>(
    app: &AppHandle<R>,
    channel_id: i64,
) -> AppResult<ArtifactCleanupReport> {
    let pool = shared_pool(app).await?;
    let library_reachable = library_is_reachable(app).await;
    let disposal = deletion_disposal(&pool).await;

    match delete_channel_row_and_plan_cleanup(&pool, channel_id, library_reachable).await? {
        Some(plan) => execute_plan(app, plan, disposal).await,
        None => Ok(ArtifactCleanupReport::default()),
    }
}
