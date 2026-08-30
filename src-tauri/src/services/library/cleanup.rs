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

/// Deletes the media row and decides, within the same transaction, which of its artifact
/// files became unreferenced. Returns `None` when the media does not exist (the operation
/// is idempotent. Nothing is deleted and no error is raised).
pub async fn delete_media_row_and_plan_cleanup(
    pool: &SqlitePool,
    media_id: i64,
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

    tx.commit()
        .await
        .map_err(|error| db_error("failed to commit media deletion", error))?;

    Ok(Some(plan))
}

/// Deletes the channel row (its videos and comments go with it via `ON DELETE CASCADE`)
/// and decides, within the same transaction, which artifact files became unreferenced.
/// Returns `None` when the channel does not exist.
pub async fn delete_channel_row_and_plan_cleanup(
    pool: &SqlitePool,
    channel_id: i64,
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

/// Deletes a media row and removes its now-unreferenced files from disk. The row deletion
/// and the "is this file still referenced" decision happen in one transaction; file
/// removal is best-effort and reported back.
pub async fn delete_media_with_artifacts<R: Runtime>(
    app: &AppHandle<R>,
    media_id: i64,
) -> AppResult<ArtifactCleanupReport> {
    let pool = shared_pool(app).await?;

    match delete_media_row_and_plan_cleanup(&pool, media_id).await? {
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

    match delete_channel_row_and_plan_cleanup(&pool, channel_id).await? {
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
