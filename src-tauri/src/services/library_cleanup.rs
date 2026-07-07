//! Atomic deletion of media/channel rows together with their on-disk artifacts.
//!
//! Deleting a media or a channel involves a referential-integrity rule: an artifact file
//! (media file, thumbnail, live chat replay) may be shared by other rows - the same
//! thumbnail can back several videos or a channel avatar, and a live chat replay can back
//! the same video added to several channels - so a file can only be removed from disk
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
use tauri::AppHandle;

use crate::services::database::{db_error, shared_pool};
use crate::services::library_guard::configured_library_dir;
use crate::services::library_media::delete_media_file_sync;
use crate::services::logger;
use crate::services::thumbnail_persist::delete_thumbnail_file_sync;
use crate::utils::path::absolute_path_from_relative;
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

/// What the committed transaction decided: which files became unreferenced (safe to
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
/// is idempotent: nothing is deleted and no error is raised).
pub async fn delete_media_row_and_plan_cleanup(
    pool: &SqlitePool,
    media_id: i64,
) -> AppResult<Option<ArtifactCleanupPlan>> {
    let mut tx = pool
        .begin()
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
        .begin()
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
    let absolute = absolute_path_from_relative(library_dir, relative_path)?;

    if absolute.exists() {
        std::fs::remove_file(&absolute).map_err(|e| {
            AppError::from_code(
                AppErrorCode::RemoveMediaFailed,
                format!("failed to remove live chat file: {e}"),
            )
        })?;
    }

    Ok(())
}

/// Removes the planned files from disk. Failures are collected in the report (and
/// logged) instead of aborting: the rows are already gone, so the caller must always
/// learn which files may have been left orphaned in the library.
pub fn remove_planned_artifacts_sync(
    library_dir: &Path,
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
            Ok(()) => report.deleted_paths.push(artifact.path),
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

async fn execute_plan(
    app: &AppHandle,
    plan: ArtifactCleanupPlan,
) -> AppResult<ArtifactCleanupReport> {
    if plan.deletable.is_empty() {
        return Ok(ArtifactCleanupReport {
            skipped_shared_paths: plan.skipped_shared_paths,
            ..ArtifactCleanupReport::default()
        });
    }

    let library_dir = match configured_library_dir(app).await {
        Ok(dir) => dir,
        Err(error) => {
            // The rows are already committed as deleted; without a configured library the
            // files cannot be located, so report every planned path as failed.
            logger::error(
                "library_cleanup",
                format!("cannot remove artifacts, library is not available: {error}"),
            );

            return Ok(ArtifactCleanupReport {
                skipped_shared_paths: plan.skipped_shared_paths,
                failed_paths: plan
                    .deletable
                    .into_iter()
                    .map(|artifact| artifact.path)
                    .collect(),
                ..ArtifactCleanupReport::default()
            });
        }
    };

    run_blocking(move || Ok(remove_planned_artifacts_sync(&library_dir, plan))).await
}

/// Deletes a media row and removes its now-unreferenced files from disk. The row deletion
/// and the "is this file still referenced" decision happen in one transaction; file
/// removal is best-effort and reported back.
pub async fn delete_media_with_artifacts(
    app: &AppHandle,
    media_id: i64,
) -> AppResult<ArtifactCleanupReport> {
    let pool = shared_pool(app).await?;

    match delete_media_row_and_plan_cleanup(pool, media_id).await? {
        Some(plan) => execute_plan(app, plan).await,
        None => Ok(ArtifactCleanupReport::default()),
    }
}

/// Deletes a channel row (cascading its media and comments) and removes the
/// now-unreferenced files from disk.
pub async fn delete_channel_with_artifacts(
    app: &AppHandle,
    channel_id: i64,
) -> AppResult<ArtifactCleanupReport> {
    let pool = shared_pool(app).await?;

    match delete_channel_row_and_plan_cleanup(pool, channel_id).await? {
        Some(plan) => execute_plan(app, plan).await,
        None => Ok(ArtifactCleanupReport::default()),
    }
}

/// Reference-counts each provided artifact path against the whole database and removes from
/// disk only the ones no row still references. Used to clean up artifacts that were prepared
/// for a media creation that never inserted a row (createMedia failing before insertMedia, a
/// local import failing mid-way, or a yt-dlp auto-downloaded thumbnail being overridden by a
/// manual one). Because the reference count and the unlink happen in a single backend call,
/// the frontend can no longer interleave another operation between "is it still used" and
/// "delete it" - the check-then-act race that existed when the cleanup was orchestrated over
/// several IPC round-trips.
///
/// Media files, thumbnails and live chat replays are content-addressed and can be shared
/// (the same video added to several channels, a thumbnail reused as a channel avatar), so a
/// freshly prepared artifact can already back a registered row; such a path is kept.
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

pub async fn cleanup_unreferenced_artifacts(
    app: &AppHandle,
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

    execute_plan(app, plan).await
}

/// Updates a channel's avatar path and decides, within the same transaction, whether the
/// previous avatar file became unreferenced. Returns `None` when the channel does not exist.
///
/// A thumbnail is referenced both by video rows and by channel avatars, and avatars and
/// thumbnails are content-addressed (they can share a path), so the previous avatar is only
/// planned for deletion when nothing else - no video thumbnail and no other channel avatar -
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
        .begin()
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
pub async fn replace_channel_avatar(
    app: &AppHandle,
    channel_id: i64,
    avatar_path: Option<String>,
) -> AppResult<ArtifactCleanupReport> {
    let pool = shared_pool(app).await?;

    match replace_channel_avatar_and_plan_cleanup(pool, channel_id, avatar_path).await? {
        Some(plan) => execute_plan(app, plan).await,
        None => Ok(ArtifactCleanupReport::default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::db_schema::ensure_schema;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    async fn create_test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create sqlite memory pool");

        sqlx::query("PRAGMA foreign_keys = ON;")
            .execute(&pool)
            .await
            .expect("enable foreign keys");

        ensure_schema(&pool).await.expect("apply schema");

        pool
    }

    async fn insert_channel(pool: &SqlitePool, handle: &str, avatar: Option<&str>) -> i64 {
        let result = sqlx::query(
            "INSERT INTO channels (name, youtube_handle, avatar_path) VALUES (?, ?, ?)",
        )
        .bind(handle)
        .bind(handle)
        .bind(avatar)
        .execute(pool)
        .await
        .expect("insert channel");

        result.last_insert_rowid()
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_media(
        pool: &SqlitePool,
        channel_id: i64,
        file_path: &str,
        thumbnail_path: Option<&str>,
        live_chat_file_path: Option<&str>,
    ) -> i64 {
        let result = sqlx::query(
            "INSERT INTO videos (channel_id, title, file_path, thumbnail_path, media_type, live_chat_file_path)
             VALUES (?, 'title', ?, ?, 'video', ?)",
        )
        .bind(channel_id)
        .bind(file_path)
        .bind(thumbnail_path)
        .bind(live_chat_file_path)
        .execute(pool)
        .await
        .expect("insert media");

        result.last_insert_rowid()
    }

    fn paths(artifacts: &[DeletableArtifact]) -> Vec<&str> {
        artifacts.iter().map(|item| item.path.as_str()).collect()
    }

    #[tokio::test]
    async fn media_plan_deletes_unshared_artifacts() {
        let pool = create_test_pool().await;
        let channel_id = insert_channel(&pool, "@one", None).await;
        let media_id = insert_media(
            &pool,
            channel_id,
            "video/a.mp4",
            Some("thumbnails/a.jpg"),
            Some("live_chat/a.json.gz"),
        )
        .await;

        let plan = delete_media_row_and_plan_cleanup(&pool, media_id)
            .await
            .unwrap()
            .expect("media exists");

        assert_eq!(
            paths(&plan.deletable),
            vec!["video/a.mp4", "thumbnails/a.jpg", "live_chat/a.json.gz"]
        );
        assert!(plan.skipped_shared_paths.is_empty());

        let (remaining,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM videos")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(remaining, 0);
    }

    #[tokio::test]
    async fn media_plan_skips_artifacts_shared_with_other_media() {
        let pool = create_test_pool().await;
        let channel_a = insert_channel(&pool, "@a", None).await;
        let channel_b = insert_channel(&pool, "@b", None).await;

        let media_id = insert_media(
            &pool,
            channel_a,
            "video/shared.mp4",
            Some("thumbnails/shared.jpg"),
            Some("live_chat/shared.json.gz"),
        )
        .await;
        // The same artifacts also back a media row in another channel.
        insert_media(
            &pool,
            channel_b,
            "video/shared.mp4",
            Some("thumbnails/shared.jpg"),
            Some("live_chat/shared.json.gz"),
        )
        .await;

        let plan = delete_media_row_and_plan_cleanup(&pool, media_id)
            .await
            .unwrap()
            .expect("media exists");

        assert!(plan.deletable.is_empty());
        assert_eq!(
            plan.skipped_shared_paths,
            vec![
                "video/shared.mp4",
                "thumbnails/shared.jpg",
                "live_chat/shared.json.gz"
            ]
        );
    }

    #[tokio::test]
    async fn media_plan_skips_thumbnail_used_as_channel_avatar() {
        let pool = create_test_pool().await;
        let channel_id = insert_channel(&pool, "@one", Some("thumbnails/avatar.jpg")).await;
        let media_id = insert_media(
            &pool,
            channel_id,
            "video/a.mp4",
            Some("thumbnails/avatar.jpg"),
            None,
        )
        .await;

        let plan = delete_media_row_and_plan_cleanup(&pool, media_id)
            .await
            .unwrap()
            .expect("media exists");

        assert_eq!(paths(&plan.deletable), vec!["video/a.mp4"]);
        assert_eq!(plan.skipped_shared_paths, vec!["thumbnails/avatar.jpg"]);
    }

    #[tokio::test]
    async fn media_plan_returns_none_for_missing_media() {
        let pool = create_test_pool().await;

        let plan = delete_media_row_and_plan_cleanup(&pool, 999).await.unwrap();

        assert!(plan.is_none());
    }

    #[tokio::test]
    async fn channel_plan_cascades_rows_and_collects_unshared_artifacts() {
        let pool = create_test_pool().await;
        let channel_id = insert_channel(&pool, "@one", Some("thumbnails/avatar.jpg")).await;
        insert_media(
            &pool,
            channel_id,
            "video/a.mp4",
            Some("thumbnails/a.jpg"),
            Some("live_chat/a.json.gz"),
        )
        .await;
        insert_media(
            &pool,
            channel_id,
            "video/b.mp4",
            Some("thumbnails/a.jpg"),
            None,
        )
        .await;

        let plan = delete_channel_row_and_plan_cleanup(&pool, channel_id)
            .await
            .unwrap()
            .expect("channel exists");

        // Media files first, then thumbnails (avatar included, deduped), then live chat.
        assert_eq!(
            paths(&plan.deletable),
            vec![
                "video/a.mp4",
                "video/b.mp4",
                "thumbnails/a.jpg",
                "thumbnails/avatar.jpg",
                "live_chat/a.json.gz"
            ]
        );
        assert!(plan.skipped_shared_paths.is_empty());

        let (videos,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM videos")
            .fetch_one(&pool)
            .await
            .unwrap();
        let (channels,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM channels")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(videos, 0);
        assert_eq!(channels, 0);
    }

    #[tokio::test]
    async fn channel_plan_skips_artifacts_shared_with_other_channels() {
        let pool = create_test_pool().await;
        let channel_a = insert_channel(&pool, "@a", Some("thumbnails/shared-avatar.jpg")).await;
        let channel_b = insert_channel(&pool, "@b", Some("thumbnails/shared-avatar.jpg")).await;

        insert_media(
            &pool,
            channel_a,
            "video/shared.mp4",
            Some("thumbnails/own.jpg"),
            Some("live_chat/shared.json.gz"),
        )
        .await;
        insert_media(
            &pool,
            channel_b,
            "video/shared.mp4",
            None,
            Some("live_chat/shared.json.gz"),
        )
        .await;

        let plan = delete_channel_row_and_plan_cleanup(&pool, channel_a)
            .await
            .unwrap()
            .expect("channel exists");

        assert_eq!(paths(&plan.deletable), vec!["thumbnails/own.jpg"]);
        assert_eq!(
            plan.skipped_shared_paths,
            vec![
                "video/shared.mp4",
                "thumbnails/shared-avatar.jpg",
                "live_chat/shared.json.gz"
            ]
        );
    }

    #[tokio::test]
    async fn channel_plan_returns_none_for_missing_channel() {
        let pool = create_test_pool().await;

        let plan = delete_channel_row_and_plan_cleanup(&pool, 999)
            .await
            .unwrap();

        assert!(plan.is_none());
    }

    async fn plan_unreferenced(
        pool: &SqlitePool,
        file_path: Option<&str>,
        thumbnail_path: Option<&str>,
        live_chat_file_path: Option<&str>,
    ) -> ArtifactCleanupPlan {
        let mut conn = pool.acquire().await.unwrap();

        plan_unreferenced_artifacts(
            &mut conn,
            file_path.map(str::to_string),
            thumbnail_path.map(str::to_string),
            live_chat_file_path.map(str::to_string),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn cleanup_plan_deletes_orphan_artifacts_no_row_references() {
        let pool = create_test_pool().await;

        // No rows reference these freshly-prepared paths, so all become deletable.
        let plan = plan_unreferenced(
            &pool,
            Some("video/orphan.mp4"),
            Some("thumbnails/orphan.jpg"),
            Some("live_chat/orphan.json.gz"),
        )
        .await;

        assert_eq!(
            paths(&plan.deletable),
            vec![
                "video/orphan.mp4",
                "thumbnails/orphan.jpg",
                "live_chat/orphan.json.gz"
            ]
        );
        assert!(plan.skipped_shared_paths.is_empty());
    }

    #[tokio::test]
    async fn cleanup_plan_keeps_artifacts_still_referenced_by_a_registered_row() {
        let pool = create_test_pool().await;
        let channel_id = insert_channel(&pool, "@one", Some("thumbnails/shared.jpg")).await;
        // A registered row references the media file and live chat; the thumbnail is a
        // channel avatar. Re-preparing the same content-addressed artifacts must not delete
        // the files the existing row/channel depends on.
        insert_media(
            &pool,
            channel_id,
            "video/shared.mp4",
            Some("thumbnails/shared.jpg"),
            Some("live_chat/shared.json.gz"),
        )
        .await;

        let plan = plan_unreferenced(
            &pool,
            Some("video/shared.mp4"),
            Some("thumbnails/shared.jpg"),
            Some("live_chat/shared.json.gz"),
        )
        .await;

        assert!(plan.deletable.is_empty());
        assert_eq!(
            plan.skipped_shared_paths,
            vec![
                "video/shared.mp4",
                "thumbnails/shared.jpg",
                "live_chat/shared.json.gz"
            ]
        );
    }

    #[tokio::test]
    async fn replace_avatar_plan_deletes_previous_when_unreferenced() {
        let pool = create_test_pool().await;
        let channel_id = insert_channel(&pool, "@one", Some("thumbnails/old.jpg")).await;

        let plan = replace_channel_avatar_and_plan_cleanup(
            &pool,
            channel_id,
            Some("thumbnails/new.jpg".to_string()),
        )
        .await
        .unwrap()
        .expect("channel exists");

        assert_eq!(paths(&plan.deletable), vec!["thumbnails/old.jpg"]);
        assert!(plan.skipped_shared_paths.is_empty());

        let avatar =
            sqlx::query_as::<_, (Option<String>,)>("SELECT avatar_path FROM channels WHERE id = ?")
                .bind(channel_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(avatar.0.as_deref(), Some("thumbnails/new.jpg"));
    }

    #[tokio::test]
    async fn replace_avatar_plan_keeps_previous_when_used_as_a_video_thumbnail() {
        let pool = create_test_pool().await;
        let channel_id = insert_channel(&pool, "@one", Some("thumbnails/shared.jpg")).await;
        // The avatar file is also a video's thumbnail: replacing the avatar must not delete
        // it. This is the reference the old frontend-only count ignored.
        insert_media(
            &pool,
            channel_id,
            "video/a.mp4",
            Some("thumbnails/shared.jpg"),
            None,
        )
        .await;

        let plan = replace_channel_avatar_and_plan_cleanup(
            &pool,
            channel_id,
            Some("thumbnails/new.jpg".to_string()),
        )
        .await
        .unwrap()
        .expect("channel exists");

        assert!(plan.deletable.is_empty());
        assert_eq!(plan.skipped_shared_paths, vec!["thumbnails/shared.jpg"]);
    }

    #[tokio::test]
    async fn replace_avatar_plan_keeps_previous_when_used_by_another_channel() {
        let pool = create_test_pool().await;
        let channel_a = insert_channel(&pool, "@a", Some("thumbnails/shared.jpg")).await;
        insert_channel(&pool, "@b", Some("thumbnails/shared.jpg")).await;

        let plan = replace_channel_avatar_and_plan_cleanup(&pool, channel_a, None)
            .await
            .unwrap()
            .expect("channel exists");

        assert!(plan.deletable.is_empty());
        assert_eq!(plan.skipped_shared_paths, vec!["thumbnails/shared.jpg"]);
    }

    #[tokio::test]
    async fn replace_avatar_plan_is_noop_when_unchanged() {
        let pool = create_test_pool().await;
        let channel_id = insert_channel(&pool, "@one", Some("thumbnails/same.jpg")).await;

        let plan = replace_channel_avatar_and_plan_cleanup(
            &pool,
            channel_id,
            Some("  thumbnails/same.jpg  ".to_string()),
        )
        .await
        .unwrap()
        .expect("channel exists");

        assert!(plan.deletable.is_empty());
        assert!(plan.skipped_shared_paths.is_empty());
    }

    #[tokio::test]
    async fn replace_avatar_plan_returns_none_for_missing_channel() {
        let pool = create_test_pool().await;

        let plan = replace_channel_avatar_and_plan_cleanup(&pool, 999, None)
            .await
            .unwrap();

        assert!(plan.is_none());
    }

    fn unique_test_dir(suffix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        std::env::temp_dir().join(format!(
            "kavynex-library-cleanup-test-{}-{}-{}",
            std::process::id(),
            nanos,
            suffix
        ))
    }

    #[test]
    fn remove_planned_artifacts_deletes_files_and_reports_missing_as_deleted() {
        let library = unique_test_dir("remove");
        fs::create_dir_all(library.join("video")).unwrap();
        fs::create_dir_all(library.join("thumbnails")).unwrap();
        fs::create_dir_all(library.join("live_chat")).unwrap();
        fs::write(library.join("video/a.mp4"), b"media").unwrap();
        fs::write(library.join("live_chat/a.json.gz"), b"chat").unwrap();
        // thumbnails/a.jpg intentionally does not exist: deletion of a missing file is a
        // no-op success, matching the individual delete services.

        let plan = ArtifactCleanupPlan {
            deletable: vec![
                DeletableArtifact {
                    kind: ArtifactKind::MediaFile,
                    path: "video/a.mp4".to_string(),
                },
                DeletableArtifact {
                    kind: ArtifactKind::Thumbnail,
                    path: "thumbnails/a.jpg".to_string(),
                },
                DeletableArtifact {
                    kind: ArtifactKind::LiveChat,
                    path: "live_chat/a.json.gz".to_string(),
                },
            ],
            skipped_shared_paths: vec!["video/shared.mp4".to_string()],
        };

        let report = remove_planned_artifacts_sync(&library, plan);

        assert_eq!(
            report.deleted_paths,
            vec!["video/a.mp4", "thumbnails/a.jpg", "live_chat/a.json.gz"]
        );
        assert_eq!(report.skipped_shared_paths, vec!["video/shared.mp4"]);
        assert!(report.failed_paths.is_empty());
        assert!(!library.join("video/a.mp4").exists());
        assert!(!library.join("live_chat/a.json.gz").exists());

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn remove_planned_artifacts_reports_traversal_paths_as_failed() {
        let library = unique_test_dir("traversal");
        fs::create_dir_all(&library).unwrap();

        let plan = ArtifactCleanupPlan {
            deletable: vec![DeletableArtifact {
                kind: ArtifactKind::LiveChat,
                path: "../outside.txt".to_string(),
            }],
            skipped_shared_paths: Vec::new(),
        };

        let report = remove_planned_artifacts_sync(&library, plan);

        assert!(report.deleted_paths.is_empty());
        assert_eq!(report.failed_paths, vec!["../outside.txt"]);

        let _ = fs::remove_dir_all(&library);
    }
}
