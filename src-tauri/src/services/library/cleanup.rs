//! Atomic deletion of media/channel rows together with their on-disk artifacts.
//!
//! Deleting a media or a channel involves a referential-integrity rule. An artifact file
//! (media file, thumbnail, live chat replay) may be shared by other rows (the same
//! thumbnail can back several videos or a channel avatar, and a live chat replay can back
//! the same video added to several channels), so a file can only be removed from disk
//! when nothing else references it. This module makes that decision inside the same
//! database transaction that deletes the rows, eliminating the check-then-act window that
//! existed when the frontend orchestrated the cleanup over several IPC calls.
//!
//! File removal itself happens after the transaction commits (the filesystem cannot join
//! a SQLite transaction); a failure there is reported and logged but never undoes the
//! committed row deletion, matching the previous best-effort semantics.

use std::collections::BTreeSet;
use std::path::Path;

use serde::Serialize;
use sqlx::{SqliteConnection, SqlitePool};
use tauri::{AppHandle, Runtime};

use crate::services::database::{db_error, shared_pool};
use crate::services::library::guard::configured_library_dir;
use crate::services::library::media::delete_media_file_sync;
use crate::services::logger;
use crate::services::temp_paths::thumb_display_dir;
use crate::services::thumbnail::display::display_derivative_path;
use crate::services::thumbnail::persist::delete_thumbnail_file_sync;

/// Opens the read-then-write transactions below with `BEGIN IMMEDIATE` rather than sqlx's
/// default deferred `BEGIN`.
///
/// Each of them reads first (which rows exist, what artifacts they point at) and writes second,
/// so a deferred transaction takes its read snapshot on the SELECT and only asks for the write
/// lock later. In WAL mode, if another connection commits in between, SQLite fails that upgrade
/// with `SQLITE_BUSY_SNAPSHOT` **immediately, without consulting the busy handler**. The
/// `busy_timeout` these connections carry cannot help, because no amount of waiting can make a
/// stale snapshot writable. The user would see a bare "failed to delete media" with no retry.
/// `BEGIN IMMEDIATE` takes the write lock up front, so the wait happens where `busy_timeout`
/// does apply and the snapshot is guaranteed writable once acquired.
const BEGIN_IMMEDIATE: &str = "BEGIN IMMEDIATE";
use crate::utils::path::{
    absolute_path_from_relative, ensure_existing_path_inside_dir, ManagedSubtree,
};
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactKind {
    MediaFile,
    Thumbnail,
    LiveChat,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletableArtifact {
    pub kind: ArtifactKind,
    pub path: String,
}

/// What the committed transaction decided. Which files became unreferenced (safe to
/// remove from disk) and which are still shared with surviving rows.
#[derive(Debug, Default, Clone)]
pub struct ArtifactCleanupPlan {
    pub deletable: Vec<DeletableArtifact>,
    pub skipped_shared_paths: Vec<String>,
}

#[derive(Debug, Default, Clone, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct ArtifactCleanupReport {
    pub deleted_paths: Vec<String>,
    pub skipped_shared_paths: Vec<String>,
    pub failed_paths: Vec<String>,
}

fn normalized(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

async fn count_media_files_referencing(conn: &mut SqliteConnection, path: &str) -> AppResult<i64> {
    let (total,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM videos WHERE file_path = ?")
        .bind(path)
        .fetch_one(conn)
        .await
        .map_err(|error| db_error("failed to count media file references", error))?;

    Ok(total)
}

/// A thumbnail is referenced both by video rows and by channel avatars, so a single count
/// covers every surviving use regardless of which side the deletion came from.
async fn count_thumbnails_referencing(conn: &mut SqliteConnection, path: &str) -> AppResult<i64> {
    let (total,): (i64,) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM videos WHERE thumbnail_path = ?)
              + (SELECT COUNT(*) FROM channels WHERE avatar_path = ?)",
    )
    .bind(path)
    .bind(path)
    .fetch_one(conn)
    .await
    .map_err(|error| db_error("failed to count thumbnail references", error))?;

    Ok(total)
}

async fn count_live_chats_referencing(conn: &mut SqliteConnection, path: &str) -> AppResult<i64> {
    let (total,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM videos WHERE live_chat_file_path = ?")
            .bind(path)
            .fetch_one(conn)
            .await
            .map_err(|error| db_error("failed to count live chat references", error))?;

    Ok(total)
}

async fn plan_artifact(
    conn: &mut SqliteConnection,
    kind: ArtifactKind,
    path: String,
    plan: &mut ArtifactCleanupPlan,
) -> AppResult<()> {
    let remaining = match kind {
        ArtifactKind::MediaFile => count_media_files_referencing(conn, &path).await?,
        ArtifactKind::Thumbnail => count_thumbnails_referencing(conn, &path).await?,
        ArtifactKind::LiveChat => count_live_chats_referencing(conn, &path).await?,
    };

    if remaining == 0 {
        plan.deletable.push(DeletableArtifact { kind, path });
    } else {
        plan.skipped_shared_paths.push(path);
    }

    Ok(())
}

/// Refuses a deletion that would leave its files behind because the library cannot be reached.
///
/// Checked inside the deletion transaction, once the plan says which files are about to become
/// unreferenced, so a refusal rolls the rows back. Committed anyway, as it used to be, a media
/// deleted with the library drive unplugged lost its row while its files stayed on that drive as
/// orphans nothing pointed at any more. A plan with nothing to remove (every file still shared)
/// needs no library and goes through.
fn ensure_library_reachable_for(
    plan: &ArtifactCleanupPlan,
    library_reachable: bool,
) -> AppResult<()> {
    if library_reachable || plan.deletable.is_empty() {
        return Ok(());
    }

    Err(AppError::from_code(
        AppErrorCode::InvalidLibraryPath,
        "the library folder is not available, so the files of what is being deleted could not be removed",
    ))
}

/// Deletes the media row and decides, within the same transaction, which of its artifact
/// files became unreferenced. Returns `None` when the media does not exist (the operation
/// is idempotent. Nothing is deleted and no error is raised).
///
/// `library_reachable` says whether the library folder exists right now. When it does not and the
/// deletion would free files, nothing is deleted (see [`ensure_library_reachable_for`]).
pub async fn delete_media_row_and_plan_cleanup(
    pool: &SqlitePool,
    media_id: i64,
    library_reachable: bool,
) -> AppResult<Option<ArtifactCleanupPlan>> {
    let mut tx = pool
        .begin_with(BEGIN_IMMEDIATE)
        .await
        .map_err(|error| db_error("failed to start media deletion transaction", error))?;

    let row: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT file_path, thumbnail_path, live_chat_file_path FROM videos WHERE id = ?",
    )
    .bind(media_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|error| db_error("failed to load media for deletion", error))?;

    let Some((file_path, thumbnail_path, live_chat_file_path)) = row else {
        return Ok(None);
    };

    sqlx::query("DELETE FROM videos WHERE id = ?")
        .bind(media_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| db_error("failed to delete media", error))?;

    let mut plan = ArtifactCleanupPlan::default();

    if let Some(path) = normalized(Some(file_path)) {
        plan_artifact(&mut tx, ArtifactKind::MediaFile, path, &mut plan).await?;
    }

    if let Some(path) = normalized(thumbnail_path) {
        plan_artifact(&mut tx, ArtifactKind::Thumbnail, path, &mut plan).await?;
    }

    if let Some(path) = normalized(live_chat_file_path) {
        plan_artifact(&mut tx, ArtifactKind::LiveChat, path, &mut plan).await?;
    }

    // Before the commit, so a refusal drops the transaction and the row stays.
    ensure_library_reachable_for(&plan, library_reachable)?;

    tx.commit()
        .await
        .map_err(|error| db_error("failed to commit media deletion", error))?;

    Ok(Some(plan))
}

/// Deletes the channel row (its videos and comments go with it via `ON DELETE CASCADE`)
/// and decides, within the same transaction, which artifact files became unreferenced.
/// Returns `None` when the channel does not exist.
///
/// `library_reachable` works as in [`delete_media_row_and_plan_cleanup`].
pub async fn delete_channel_row_and_plan_cleanup(
    pool: &SqlitePool,
    channel_id: i64,
    library_reachable: bool,
) -> AppResult<Option<ArtifactCleanupPlan>> {
    let mut tx = pool
        .begin_with(BEGIN_IMMEDIATE)
        .await
        .map_err(|error| db_error("failed to start channel deletion transaction", error))?;

    let channel: Option<(Option<String>,)> =
        sqlx::query_as("SELECT avatar_path FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|error| db_error("failed to load channel for deletion", error))?;

    let Some((avatar_path,)) = channel else {
        return Ok(None);
    };

    let file_paths: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT file_path FROM videos WHERE channel_id = ? AND TRIM(file_path) <> ''",
    )
    .bind(channel_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|error| db_error("failed to list channel media files for deletion", error))?;

    let thumbnail_paths: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT thumbnail_path FROM videos
         WHERE channel_id = ? AND thumbnail_path IS NOT NULL AND TRIM(thumbnail_path) <> ''",
    )
    .bind(channel_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|error| db_error("failed to list channel thumbnails for deletion", error))?;

    let live_chat_paths: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT live_chat_file_path FROM videos
         WHERE channel_id = ? AND live_chat_file_path IS NOT NULL
           AND TRIM(live_chat_file_path) <> ''",
    )
    .bind(channel_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|error| db_error("failed to list channel live chat files for deletion", error))?;

    sqlx::query("DELETE FROM channels WHERE id = ?")
        .bind(channel_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| db_error("failed to delete channel", error))?;

    let mut plan = ArtifactCleanupPlan::default();

    // BTreeSet dedupes (the avatar can also be a media thumbnail) and keeps the plan
    // order deterministic for tests and logs.
    let media_files: BTreeSet<String> = file_paths
        .into_iter()
        .filter_map(|(value,)| normalized(Some(value)))
        .collect();

    let thumbnails: BTreeSet<String> = thumbnail_paths
        .into_iter()
        .map(|(value,)| value)
        .chain(avatar_path)
        .filter_map(|value| normalized(Some(value)))
        .collect();

    let live_chats: BTreeSet<String> = live_chat_paths
        .into_iter()
        .filter_map(|(value,)| normalized(Some(value)))
        .collect();

    for path in media_files {
        plan_artifact(&mut tx, ArtifactKind::MediaFile, path, &mut plan).await?;
    }

    for path in thumbnails {
        plan_artifact(&mut tx, ArtifactKind::Thumbnail, path, &mut plan).await?;
    }

    for path in live_chats {
        plan_artifact(&mut tx, ArtifactKind::LiveChat, path, &mut plan).await?;
    }

    ensure_library_reachable_for(&plan, library_reachable)?;

    tx.commit()
        .await
        .map_err(|error| db_error("failed to commit channel deletion", error))?;

    Ok(Some(plan))
}

fn delete_live_chat_file_at(library_dir: &Path, relative_path: &str) -> AppResult<()> {
    // Serialize against a concurrent library migration (see library::lock). Acquired once per
    // call, so the per-artifact loop in remove_planned_artifacts_sync releases between files.
    let _library_guard = crate::services::library::lock::library_read_guard();

    let absolute =
        absolute_path_from_relative(library_dir, relative_path, ManagedSubtree::LiveChat)?;

    if absolute.exists() {
        // Re-resolve symlinks and re-check containment before unlinking, matching the sibling
        // delete_media_file_sync / delete_thumbnail_file_sync. absolute_path_from_relative only
        // does a lexical check; an intermediate path component that is itself a symlink pointing
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
/// exceeds its budget, and therefore has no relation to what was deleted. Until this ran, deleting a
/// media left its thumbnail readable in the cache directory until enough unrelated browsing pushed
/// the cache past its ceiling.
///
/// No reference counting of its own. The caller only reaches here for a path the deletion
/// transaction already found unreferenced, and the derivative is keyed by that path's content hash,
/// so two rows sharing a thumbnail share its derivative exactly as they share the file.
///
/// Best effort, and deliberately silent on failure. The canonical file is gone, which is what the
/// user asked for and what the report is about; a derivative left behind is a regenerable cache
/// entry the size sweep still reclaims, so failing the delete over it (or adding it to
/// `failed_paths`, which names files the user may need to clean up by hand) would misreport a
/// cache miss as an orphaned artifact.
///
/// A derivative written under an older [`DISPLAY_THUMBNAIL_MAX_WIDTH`] is not matched, since the
/// width is part of the name. That is the same self-invalidation the width is in the name for.
/// Nothing addresses those any more, and the size sweep is what reclaims them.
fn drop_display_derivative(display_dir: Option<&Path>, relative_thumbnail_path: &str) {
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
async fn drop_paths_referenced_again(pool: &SqlitePool, plan: &mut ArtifactCleanupPlan) {
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
fn report_for_nothing_deletable(plan: ArtifactCleanupPlan) -> ArtifactCleanupReport {
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
fn report_for_unavailable_library(plan: ArtifactCleanupPlan) -> ArtifactCleanupReport {
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

/// Removes a committed plan's artifacts under [`MEDIA_REGISTRATION_LOCK`].
///
/// The lock is here, and not only around `cleanup_unreferenced_artifacts`, because the three
/// callers below (a media delete, a channel delete, an avatar replace) unlink exactly the same
/// content-addressed files a concurrent creation can be adopting, and for a while they held nothing
/// but `drop_paths_referenced_again`. A recount is not exclusion. It answers "is this referenced
/// *now*", and a creation that inserts a moment later makes that answer stale between the recount
/// and the unlink. `docs/THREAT-MODEL.md` described the lock as closing this class while these three
/// paths sat outside it, which is the asymmetry this closes.
///
/// What it does **not** close is the window before `register_prepared_media` takes the same lock,
/// i.e. between the artifacts landing and the creation reaching its critical section. Covering that
/// would mean holding this lock across a download, which is the one thing the lock's own
/// documentation rules out. `insert_prepared_media` re-checks the media file's existence inside the
/// critical section instead, so what that window can still cost is a refused creation rather than a
/// row pointing at nothing. See the residual recorded in `docs/THREAT-MODEL.md`.
async fn execute_plan<R: Runtime>(
    app: &AppHandle<R>,
    plan: ArtifactCleanupPlan,
) -> AppResult<ArtifactCleanupReport> {
    let _guard = MEDIA_REGISTRATION_LOCK.lock().await;

    execute_plan_locked(app, plan).await
}

/// The body of [`execute_plan`], for a caller that already holds [`MEDIA_REGISTRATION_LOCK`].
///
/// Exists for the same reason [`cleanup_unreferenced_artifacts_locked`] does. A creation's failure
/// path cleans up while still inside its own critical section, so taking the lock a second time
/// would deadlock.
async fn execute_plan_locked<R: Runtime>(
    app: &AppHandle<R>,
    mut plan: ArtifactCleanupPlan,
) -> AppResult<ArtifactCleanupReport> {
    if plan.deletable.is_empty() {
        return Ok(report_for_nothing_deletable(plan));
    }

    // Resolve the library directory first, before the recount below, so the recount is the last
    // await before the blocking unlink is scheduled. The window this race is about is the gap
    // between "the file is still unreferenced" and the unlink; keeping any other await (the library
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
            // The rows are already committed as deleted; without a configured library the
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
    let display_dir = thumb_display_dir(app).ok();

    run_blocking(move || {
        Ok(remove_planned_artifacts_sync(
            &library_dir,
            display_dir.as_deref(),
            plan,
        ))
    })
    .await
}

/// Whether the configured library folder exists right now, which a deletion needs to remove files.
async fn library_is_reachable<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Ok(library_dir) = configured_library_dir(app).await else {
        return false;
    };
    let library_path = library_dir.to_string_lossy().to_string();

    run_blocking(move || {
        crate::services::library::paths::resolve_existing_library_dir(&library_path)
    })
    .await
    .is_ok()
}

/// Deletes a media row and removes its now-unreferenced files from disk. The row deletion
/// and the "is this file still referenced" decision happen in one transaction; file
/// removal is best-effort and reported back.
pub async fn delete_media_with_artifacts<R: Runtime>(
    app: &AppHandle<R>,
    media_id: i64,
) -> AppResult<ArtifactCleanupReport> {
    let pool = shared_pool(app).await?;
    let library_reachable = library_is_reachable(app).await;

    match delete_media_row_and_plan_cleanup(&pool, media_id, library_reachable).await? {
        Some(plan) => execute_plan(app, plan).await,
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

    match delete_channel_row_and_plan_cleanup(&pool, channel_id, library_reachable).await? {
        Some(plan) => execute_plan(app, plan).await,
        None => Ok(ArtifactCleanupReport::default()),
    }
}

/// Reference-counts each provided artifact path against the whole database and removes from
/// disk only the ones no row still references. Used to clean up artifacts that were prepared
/// for a media creation that never inserted a row (createMedia failing before insertMedia, a
/// local import failing mid-way, or a yt-dlp auto-downloaded thumbnail being overridden by a
/// manual one).
///
/// Media files, thumbnails and live chat replays are content-addressed and can be shared
/// (the same video added to several channels, a thumbnail reused as a channel avatar), so a
/// freshly prepared artifact can already back a registered row; such a path is kept.
///
/// What the count and the unlink are serialized against. [`MEDIA_REGISTRATION_LOCK`]. A wrapping
/// transaction cannot help (the unlink necessarily happens after any commit, since the filesystem
/// cannot join a SQLite transaction), so the delete paths above are not a template to copy here.
/// The lock is what closes it, and `services::media_creation` takes the same one around its own
/// marker/duplicate-check/insert sequence, so a creation resolving to the same content-addressed
/// path can never be counted as absent by a cleanup that is about to unlink the file it just wrote.
///
/// This used to rest on the add-media modal being locked for the duration of one creation, i.e. on
/// frontend behavior, which is the one thing the rest of this codebase refuses to depend on. It no
/// longer does. The whole creation is a single backend call now, so the exclusion is a lock here
/// rather than a flag in the renderer.
///
/// The startup sweep (`services::pending_media`) keeps its own, separate guard on top, because the
/// lock alone cannot answer its question. It refuses any marker registered as in flight by this
/// process or newer than the process itself (`pending_media::marker_is_sweepable`), since a creation
/// that has written its artifacts but not yet reached `insert_media` is indistinguishable *by
/// reference count* from one that died there.
///
/// See the matching section in `docs/THREAT-MODEL.md` for the same split written for a reader auditing the
/// trust boundary rather than this function.
async fn plan_unreferenced_artifacts(
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

/// Serializes a reference-counted artifact cleanup against a media registration.
///
/// Both sides of the race this closes are short and rare, so one lock is enough and a map keyed by
/// artifact path would only add a way to get the keying wrong. What it must *not* cover is the
/// expensive half of a creation. The download and the import run outside it, so holding this never
/// blocks anything a user waits on. `media_creation` takes it only around the marker, the duplicate
/// check and the insert, which are milliseconds.
///
/// A single static lock, like `db_backup`'s `BACKUP_IN_PROGRESS`. There is one library process-wide
/// and the lock holds no state a test needs to inject.
static MEDIA_REGISTRATION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Acquires [`MEDIA_REGISTRATION_LOCK`] for a media registration. Held by
/// `services::media_creation` from before the crash marker is written until after the row lands, so
/// a concurrent cleanup cannot observe the artifacts as unreferenced in that window.
pub async fn media_registration_guard() -> tokio::sync::MutexGuard<'static, ()> {
    MEDIA_REGISTRATION_LOCK.lock().await
}

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
/// taking it a second time would deadlock, and releasing it first would reopen the window between
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

    let library_dir = configured_library_dir(app).await;

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

    let display_dir = thumb_display_dir(app).ok();
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

/// The orphans `remove_orphan_artifacts` may delete. Files under `video/`, `audio/` and
/// `thumbnails/` that no row references and that carry the name the app gives what it writes
/// (`media_<sha256>.<ext>`, `thumb_<sha256>.<ext>`).
///
/// The name is the line between the app's leftovers and the user's own files. A library folder is
/// not required to be empty, and a file the user put in `video/` by hand is reported as an orphan
/// too, but it does not carry a digest in its name, so it stays. Live chat replays are left out
/// entirely, since their names carry no digest either.
///
/// "Referenced" is decided by digest, not by the path's spelling. A row whose stored path differs
/// from the file on disk only in letter case or separators (which the filesystem may treat as the
/// same file) still protects it, and so does any row naming the same digest under another
/// extension or folder, since a content-addressed name with that digest is the same bytes.
pub(crate) fn removable_orphans(
    library_dir: &Path,
    expected: &crate::services::library::integrity::ExpectedLibraryPaths,
) -> Vec<DeletableArtifact> {
    use crate::constants::{LIBRARY_DIR_AUDIO, LIBRARY_DIR_THUMBNAILS, LIBRARY_DIR_VIDEO};
    use crate::services::library::integrity::list_files_relative;
    use crate::services::library::verification::declared_content_hash;

    let groups: [(&str, ArtifactKind); 3] = [
        (LIBRARY_DIR_VIDEO, ArtifactKind::MediaFile),
        (LIBRARY_DIR_AUDIO, ArtifactKind::MediaFile),
        (LIBRARY_DIR_THUMBNAILS, ArtifactKind::Thumbnail),
    ];

    // Every digest any row names, from either list, lowercased. A stored path that declares no
    // digest protects nothing here, and needs not to, because only digest-named files are removed.
    let referenced_digests: std::collections::HashSet<String> = expected
        .media
        .iter()
        .chain(expected.thumbnails.iter())
        .filter_map(|path| {
            let file_name = path.rsplit(['/', '\\']).next().unwrap_or_default();
            declared_content_hash(file_name).map(str::to_ascii_lowercase)
        })
        .collect();

    let mut removable = Vec::new();

    for (subdir, kind) in groups {
        for relative in list_files_relative(&library_dir.join(subdir), library_dir) {
            let file_name = relative.rsplit('/').next().unwrap_or_default();

            let Some(digest) = declared_content_hash(file_name) else {
                continue;
            };

            if referenced_digests.contains(&digest.to_ascii_lowercase()) {
                continue;
            }

            removable.push(DeletableArtifact {
                kind,
                path: relative,
            });
        }
    }

    removable
}

/// The folder inside the library that orphan removals move files into, one subfolder per run.
pub(crate) const LIBRARY_TRASH_DIR: &str = ".trash";

/// How long the orphan removal is refused after the database was replaced, and how long a removal's
/// files wait in [`LIBRARY_TRASH_DIR`] before the startup sweep purges them.
pub(crate) const ORPHAN_GRACE_PERIOD: std::time::Duration =
    std::time::Duration::from_secs(30 * 24 * 60 * 60);

/// A file written this recently is never treated as an orphan. A thumbnail or a channel avatar is
/// written into the library one IPC call before the row that references it, and nothing holds the
/// two together, so a removal in between would take a file that is about to be referenced.
const RECENT_WRITE_WINDOW: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// `relative` (with `/` separators) under `base`, pushed a component at a time, since a verbatim
/// (`\\?\`) base on Windows takes a forward slash literally.
fn library_relative(base: &Path, relative: &str) -> std::path::PathBuf {
    let mut path = base.to_path_buf();
    for part in relative.split('/') {
        path.push(part);
    }
    path
}

fn was_written_recently(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map(|modified| {
            std::time::SystemTime::now()
                .duration_since(modified)
                .map_or(true, |age| age < RECENT_WRITE_WINDOW)
        })
        .unwrap_or(false)
}

/// Below this many removable files the share rule in [`orphan_removal_refusal`] does not apply. A
/// small library with a handful of leftovers would otherwise be refused for being small.
const SHARE_RULE_MIN_FILES: usize = 10;

/// Why the orphan removal will not run on this library right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum OrphanRemovalRefusal {
    /// The database was imported or restored within [`ORPHAN_GRACE_PERIOD`]. Files the previous
    /// database used read as orphans to this one, and undoing the import would bring back rows
    /// pointing at them.
    RecentDatabaseSwap,
    /// Most of the files Kavynex named are unreferenced, which is what an older or another
    /// library's database looks like rather than leftovers.
    MostFilesUnreferenced,
}

/// What an orphan removal would do on this library, for Diagnostics to show before it is asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct OrphanRemovalPlan {
    #[ts(type = "number")]
    pub files: usize,
    #[ts(type = "number")]
    pub bytes: u64,
    pub refusal: Option<OrphanRemovalRefusal>,
}

/// The refusal rule, apart from the filesystem so each branch is one call from a test.
pub(crate) fn orphan_removal_refusal(
    removable: usize,
    content_addressed_total: usize,
    recent_database_swap: bool,
) -> Option<OrphanRemovalRefusal> {
    if removable == 0 {
        return None;
    }

    if recent_database_swap {
        return Some(OrphanRemovalRefusal::RecentDatabaseSwap);
    }

    if removable >= SHARE_RULE_MIN_FILES && removable * 2 > content_addressed_total {
        return Some(OrphanRemovalRefusal::MostFilesUnreferenced);
    }

    None
}

/// How many files under the media and thumbnail folders carry a name the app gives what it writes,
/// referenced or not. The denominator of the share rule.
fn count_content_addressed_files(library_dir: &Path) -> usize {
    use crate::constants::{LIBRARY_DIR_AUDIO, LIBRARY_DIR_THUMBNAILS, LIBRARY_DIR_VIDEO};
    use crate::services::library::integrity::list_files_relative;
    use crate::services::library::verification::declared_content_hash;

    [LIBRARY_DIR_VIDEO, LIBRARY_DIR_AUDIO, LIBRARY_DIR_THUMBNAILS]
        .iter()
        .flat_map(|subdir| list_files_relative(&library_dir.join(subdir), library_dir))
        .filter(|relative| {
            let file_name = relative.rsplit('/').next().unwrap_or_default();
            declared_content_hash(file_name).is_some()
        })
        .count()
}

/// Lists the removable orphans and decides whether removing them is allowed. Blocking (it walks the
/// library).
pub(crate) fn plan_orphan_removal(
    library_dir: &Path,
    expected: &crate::services::library::integrity::ExpectedLibraryPaths,
    recent_database_swap: bool,
) -> (OrphanRemovalPlan, Vec<DeletableArtifact>) {
    let removable: Vec<DeletableArtifact> = removable_orphans(library_dir, expected)
        .into_iter()
        .filter(|artifact| !was_written_recently(&library_relative(library_dir, &artifact.path)))
        .collect();

    let bytes = removable
        .iter()
        .filter_map(|artifact| {
            std::fs::metadata(library_relative(library_dir, &artifact.path)).ok()
        })
        .map(|metadata| metadata.len())
        .sum();

    let refusal = orphan_removal_refusal(
        removable.len(),
        count_content_addressed_files(library_dir),
        recent_database_swap,
    );

    (
        OrphanRemovalPlan {
            files: removable.len(),
            bytes,
            refusal,
        },
        removable,
    )
}

/// Whether the database at `db_path` was imported or restored within [`ORPHAN_GRACE_PERIOD`].
pub(crate) fn database_was_recently_swapped(db_path: &Path) -> bool {
    crate::services::db_backup::database_swapped_within(db_path, ORPHAN_GRACE_PERIOD)
}

/// Moves one orphan into `trash_dir`, keeping its library-relative path under it.
fn move_orphan_to_trash(
    library_dir: &Path,
    trash_dir: &Path,
    artifact: &DeletableArtifact,
) -> AppResult<()> {
    let subtree = match artifact.kind {
        ArtifactKind::MediaFile => ManagedSubtree::Media,
        ArtifactKind::Thumbnail => ManagedSubtree::Thumbnails,
        ArtifactKind::LiveChat => ManagedSubtree::LiveChat,
    };

    let source = absolute_path_from_relative(library_dir, &artifact.path, subtree)?;

    if !source.exists() {
        return Ok(());
    }

    ensure_existing_path_inside_dir(&source, library_dir)?;

    let target = library_relative(trash_dir, &artifact.path);

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            AppError::fs_error(
                AppErrorCode::CreateDirectoryFailed,
                "failed to create the library trash folder",
                parent,
                &error,
            )
        })?;
    }

    std::fs::rename(&source, &target).map_err(|error| {
        AppError::fs_error(
            AppErrorCode::FileMoveFailed,
            "failed to move an orphan file to the library trash",
            &source,
            &error,
        )
    })
}

/// Moves each planned orphan into a new `.trash/<timestamp>` folder of the library. Reports a moved
/// file as deleted, since it is gone from where the library looks.
fn move_orphans_to_trash_sync(
    library_dir: &Path,
    display_dir: Option<&Path>,
    deletable: Vec<DeletableArtifact>,
) -> ArtifactCleanupReport {
    let _library_guard = crate::services::library::lock::library_read_guard();

    let trash_dir = library_dir.join(LIBRARY_TRASH_DIR).join(format!(
        "{}-{}",
        chrono::Utc::now().format("%Y%m%dT%H%M%SZ"),
        crate::utils::naming::unique_temp_suffix()
    ));

    let mut report = ArtifactCleanupReport::default();

    for artifact in deletable {
        match move_orphan_to_trash(library_dir, &trash_dir, &artifact) {
            Ok(()) => {
                if artifact.kind == ArtifactKind::Thumbnail {
                    drop_display_derivative(display_dir, &artifact.path);
                }

                report.deleted_paths.push(artifact.path);
            }
            Err(error) => {
                logger::error(
                    "library_cleanup",
                    format!(
                        "orphan '{}' could not be moved to the trash: {error}",
                        artifact.path
                    ),
                );
                report.failed_paths.push(artifact.path);
            }
        }
    }

    report
}

/// Moves the library files no row references, which is what Diagnostics reports as orphans, into
/// the library's `.trash` folder, limited to the ones `removable_orphans` recognizes as the app's
/// own. The startup sweep purges a trash folder once it is older than [`ORPHAN_GRACE_PERIOD`].
///
/// Refused when [`orphan_removal_refusal`] says the database does not describe this folder well
/// enough to call its files leftovers. Refused while a media creation is running, and holds every
/// new one off until it is done (see `media_creation::try_exclude_creations`), since a creation's
/// artifacts sit in the library unreferenced until its row lands. Also holds
/// [`MEDIA_REGISTRATION_LOCK`], which the startup sweep and the avatar cleanup take. Each path is
/// recounted against the database right before it moves.
pub async fn remove_orphan_artifacts<R: Runtime>(
    app: &AppHandle<R>,
) -> AppResult<ArtifactCleanupReport> {
    // Taken without waiting and before the registration lock. A creation takes the two in the
    // other order (its gate for the whole run, the lock around the insert), so waiting here while
    // holding the lock could deadlock.
    let Some(_creations_excluded) = crate::services::media_creation::try_exclude_creations() else {
        return Err(AppError::from_code(
            AppErrorCode::MediaCreationInProgress,
            "a media is being added, so its files are not referenced yet",
        ));
    };

    let _guard = MEDIA_REGISTRATION_LOCK.lock().await;

    let pool = shared_pool(app).await?;
    let references =
        crate::services::video_repository::list_media_integrity_references(&pool).await?;
    let avatar_paths =
        crate::services::channel_repository::list_channel_avatar_paths(&pool).await?;
    let expected =
        crate::services::library::integrity::expected_library_paths(&references, avatar_paths);
    let library_dir = configured_library_dir(app).await?;
    let recent_database_swap =
        database_was_recently_swapped(&crate::services::database::database_path(app)?);

    let planning_dir = library_dir.clone();
    let (removal, deletable) = run_blocking(move || {
        Ok(plan_orphan_removal(
            &planning_dir,
            &expected,
            recent_database_swap,
        ))
    })
    .await?;

    if let Some(refusal) = removal.refusal {
        return Err(AppError::from_code(
            AppErrorCode::OrphanRemovalRefused,
            match refusal {
                OrphanRemovalRefusal::RecentDatabaseSwap => {
                    "the database was imported or restored recently, so unreferenced files may belong to the previous one"
                }
                OrphanRemovalRefusal::MostFilesUnreferenced => {
                    "most of the library's files are unreferenced, which looks like a database that does not describe this folder"
                }
            },
        ));
    }

    let mut plan = ArtifactCleanupPlan {
        deletable,
        skipped_shared_paths: Vec::new(),
    };

    if plan.deletable.is_empty() {
        return Ok(ArtifactCleanupReport::default());
    }

    drop_paths_referenced_again(&pool, &mut plan).await;

    let display_dir = thumb_display_dir(app).ok();

    run_blocking(move || {
        Ok(move_orphans_to_trash_sync(
            &library_dir,
            display_dir.as_deref(),
            plan.deletable,
        ))
    })
    .await
}

/// Updates a channel's avatar path and decides, within the same transaction, whether the
/// previous avatar file became unreferenced. Returns `None` when the channel does not exist.
///
/// A thumbnail is referenced both by video rows and by channel avatars, and avatars and
/// thumbnails are content-addressed (they can share a path), so the previous avatar is only
/// planned for deletion when nothing else (no video thumbnail and no other channel avatar),
/// still points at it. Doing this in one transaction (row write plus reference decision)
/// closes the check-then-act race the frontend had when it updated the avatar and then
/// counted references over separate IPC calls, and fixes a latent gap where that count
/// ignored video-thumbnail references entirely.
pub async fn replace_channel_avatar_and_plan_cleanup(
    pool: &SqlitePool,
    channel_id: i64,
    avatar_path: Option<String>,
) -> AppResult<Option<ArtifactCleanupPlan>> {
    let next_avatar = normalized(avatar_path);

    let mut tx = pool
        .begin_with(BEGIN_IMMEDIATE)
        .await
        .map_err(|error| db_error("failed to start channel avatar update transaction", error))?;

    let existing: Option<(Option<String>,)> =
        sqlx::query_as("SELECT avatar_path FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|error| db_error("failed to load channel for avatar update", error))?;

    let Some((previous_avatar,)) = existing else {
        return Ok(None);
    };

    let previous_avatar = normalized(previous_avatar);

    if previous_avatar == next_avatar {
        return Ok(Some(ArtifactCleanupPlan::default()));
    }

    sqlx::query("UPDATE channels SET avatar_path = ? WHERE id = ?")
        .bind(next_avatar.as_deref())
        .bind(channel_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| db_error("failed to update channel avatar path", error))?;

    let mut plan = ArtifactCleanupPlan::default();

    if let Some(previous) = previous_avatar {
        plan_artifact(&mut tx, ArtifactKind::Thumbnail, previous, &mut plan).await?;
    }

    tx.commit()
        .await
        .map_err(|error| db_error("failed to commit channel avatar update", error))?;

    Ok(Some(plan))
}

/// Updates a channel's avatar and removes the previous avatar file when it is no longer
/// referenced. The row write and the "is the old file still used" decision commit
/// atomically; the unlink runs after the commit and is reported back.
pub async fn replace_channel_avatar<R: Runtime>(
    app: &AppHandle<R>,
    channel_id: i64,
    avatar_path: Option<String>,
) -> AppResult<ArtifactCleanupReport> {
    let pool = shared_pool(app).await?;

    match replace_channel_avatar_and_plan_cleanup(&pool, channel_id, avatar_path).await? {
        Some(plan) => execute_plan(app, plan).await,
        None => Ok(ArtifactCleanupReport::default()),
    }
}

#[cfg(test)]
mod tests;
