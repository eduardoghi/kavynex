use serde::Serialize;
use sqlx::SqlitePool;
use ts_rs::TS;

use crate::services::database::{db_error, is_unique_violation};
use crate::{AppError, AppErrorCode, AppResult};

// `id`/counts/flags are i64 in Rust but ts-rs would emit `bigint`; the Tauri IPC layer
// serializes them as JSON numbers, so the runtime value is a JS `number`. `media_type` is
// refined to the union the app relies on. These per-field overrides keep the generated
// type identical to what `invoke` actually returns.
#[derive(Debug, Serialize, sqlx::FromRow, TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct MediaRow {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub channel_id: i64,
    pub title: String,
    pub file_path: String,
    pub thumbnail_path: Option<String>,
    #[ts(type = "\"video\" | \"audio\"")]
    pub media_type: String,
    pub youtube_video_id: Option<String>,
    pub watched_at: Option<String>,
    pub published_at: Option<String>,
    #[ts(type = "number | null")]
    pub duration_seconds: Option<i64>,
    #[ts(type = "number")]
    pub progress_seconds: i64,
    #[ts(type = "number")]
    pub has_comments: i64,
    #[ts(type = "number")]
    pub comments_count: i64,
    #[ts(type = "number")]
    pub is_live: i64,
    #[ts(type = "number")]
    pub has_live_chat: i64,
    pub live_chat_file_path: Option<String>,
    pub created_at: String,
}

// i64 columns are annotated as `number`: the Tauri IPC layer serializes them as JSON
// numbers, so the runtime value is a JS `number` rather than the `bigint` ts-rs emits by
// default.
#[derive(Debug, Serialize, sqlx::FromRow, TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct MediaCommentRow {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub video_id: i64,
    pub comment_id: Option<String>,
    pub parent_comment_id: Option<String>,
    pub author_name: String,
    pub author_handle: Option<String>,
    pub author_channel_id: Option<String>,
    pub author_thumbnail: Option<String>,
    pub text: String,
    #[ts(type = "number")]
    pub like_count: i64,
    #[ts(type = "number")]
    pub reply_count: i64,
    #[ts(type = "number")]
    pub is_author_uploader: i64,
    #[ts(type = "number")]
    pub is_favorited: i64,
    #[ts(type = "number")]
    pub is_pinned: i64,
    #[ts(type = "number")]
    pub is_edited: i64,
    pub time_text: Option<String>,
    pub published_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, sqlx::FromRow, TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct MediaRepositoryStats {
    #[ts(type = "number")]
    pub total_media: i64,
    #[ts(type = "number")]
    pub total_video_media: i64,
    #[ts(type = "number")]
    pub total_audio_media: i64,
    #[ts(type = "number")]
    pub total_with_thumbnail: i64,
    #[ts(type = "number")]
    pub total_without_thumbnail: i64,
    #[ts(type = "number")]
    pub total_watched: i64,
    #[ts(type = "number")]
    pub total_unwatched: i64,
    #[ts(type = "number")]
    pub total_live_media: i64,
    #[ts(type = "number")]
    pub total_with_live_chat: i64,
    #[ts(type = "number")]
    pub total_without_live_chat: i64,
    #[ts(type = "number")]
    pub total_media_with_live_chat_flag_but_no_path: i64,
    #[ts(type = "number")]
    pub total_media_with_live_chat_path_but_not_live: i64,
}

#[derive(Debug, Serialize, sqlx::FromRow, TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct MediaIntegrityReference {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub channel_id: i64,
    pub title: String,
    pub file_path: String,
    pub thumbnail_path: Option<String>,
    pub live_chat_file_path: Option<String>,
}

const MEDIA_COLUMNS: &str = "id, channel_id, title, file_path, thumbnail_path, media_type, \
    youtube_video_id, watched_at, published_at, duration_seconds, progress_seconds, has_comments, \
    comments_count, is_live, has_live_chat, live_chat_file_path, created_at";

pub async fn update_media_title(pool: &SqlitePool, media_id: i64, title: &str) -> AppResult<()> {
    sqlx::query("UPDATE videos SET title = ? WHERE id = ?")
        .bind(title)
        .bind(media_id)
        .execute(pool)
        .await
        .map_err(|error| db_error("failed to update media title", error))?;

    Ok(())
}

pub async fn list_media_by_channel(pool: &SqlitePool, channel_id: i64) -> AppResult<Vec<MediaRow>> {
    sqlx::query_as::<_, MediaRow>(sqlx::AssertSqlSafe(format!(
        "SELECT {MEDIA_COLUMNS} FROM videos WHERE channel_id = ? ORDER BY created_at DESC, id DESC"
    )))
    .bind(channel_id)
    .fetch_all(pool)
    .await
    .map_err(|error| db_error("failed to list media by channel", error))
}

pub async fn find_media_by_channel_and_file_path(
    pool: &SqlitePool,
    channel_id: i64,
    file_path: &str,
) -> AppResult<Option<MediaRow>> {
    sqlx::query_as::<_, MediaRow>(sqlx::AssertSqlSafe(format!(
        "SELECT {MEDIA_COLUMNS} FROM videos WHERE channel_id = ? AND file_path = ? LIMIT 1"
    )))
    .bind(channel_id)
    .bind(file_path)
    .fetch_optional(pool)
    .await
    .map_err(|error| db_error("failed to find media by file path", error))
}

/// Cheap pre-check for the yt-dlp (URL) add flow: whether `channel_id` already has a media row
/// for `youtube_video_id`, mirroring the "non-empty trimmed id" semantics of the unique partial
/// index `idx_videos_channel_youtube_video_id_unique`. Letting the caller run this before
/// downloading the video avoids downloading the whole file only to have `insert_media` fail on
/// that index afterwards.
pub async fn media_exists_for_channel_and_youtube_id(
    pool: &SqlitePool,
    channel_id: i64,
    youtube_video_id: &str,
) -> AppResult<bool> {
    let normalized_id = youtube_video_id.trim();

    if normalized_id.is_empty() {
        return Ok(false);
    }

    let (exists,): (i64,) = sqlx::query_as(
        "SELECT EXISTS(SELECT 1 FROM videos WHERE channel_id = ? AND youtube_video_id = ?)",
    )
    .bind(channel_id)
    .bind(normalized_id)
    .fetch_one(pool)
    .await
    .map_err(|error| {
        db_error(
            "failed to check media existence for youtube video id",
            error,
        )
    })?;

    Ok(exists != 0)
}

#[allow(clippy::too_many_arguments)]
pub async fn insert_media(
    pool: &SqlitePool,
    channel_id: i64,
    title: &str,
    file_path: &str,
    thumbnail_path: Option<&str>,
    media_type: &str,
    youtube_video_id: Option<&str>,
    published_at: Option<&str>,
    duration_seconds: Option<i64>,
    is_live: bool,
    live_chat_file_path: Option<&str>,
) -> AppResult<Option<i64>> {
    let normalized_live_chat = live_chat_file_path
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let has_live_chat = normalized_live_chat.is_some();

    sqlx::query(
        "INSERT INTO videos (
            channel_id, title, file_path, thumbnail_path, media_type, youtube_video_id,
            published_at, duration_seconds, progress_seconds, has_comments, comments_count,
            is_live, has_live_chat, live_chat_file_path
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)
         ON CONFLICT(channel_id, file_path) DO NOTHING",
    )
    .bind(channel_id)
    .bind(title)
    .bind(file_path)
    .bind(thumbnail_path)
    .bind(media_type)
    .bind(youtube_video_id)
    .bind(published_at)
    .bind(duration_seconds)
    .bind(if is_live { 1_i64 } else { 0_i64 })
    .bind(if has_live_chat { 1_i64 } else { 0_i64 })
    .bind(normalized_live_chat)
    .execute(pool)
    .await
    .map_err(|error| {
        // The (channel_id, file_path) conflict is absorbed by ON CONFLICT DO NOTHING above, so
        // a surfacing unique violation can only be the (channel_id, youtube_video_id) index:
        // the same YouTube video already registered for this channel under a different path.
        // Map it to the same friendly code the frontend pre-check raises, closing the
        // check-then-act race with a consistent message instead of a raw SQLite error.
        if is_unique_violation(&error) {
            return AppError::from_code(
                AppErrorCode::VideoAlreadyExistsForChannel,
                "this video is already saved for this channel",
            );
        }

        db_error("failed to insert media", error)
    })?;

    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT id FROM videos WHERE channel_id = ? AND file_path = ? ORDER BY id DESC LIMIT 1",
    )
    .bind(channel_id)
    .bind(file_path)
    .fetch_optional(pool)
    .await
    .map_err(|error| db_error("failed to resolve inserted media id", error))?;

    Ok(row.map(|(id,)| id))
}

pub async fn list_media_comments_by_media_id(
    pool: &SqlitePool,
    media_id: i64,
) -> AppResult<Vec<MediaCommentRow>> {
    sqlx::query_as::<_, MediaCommentRow>(
        "SELECT id, video_id, comment_id, parent_comment_id, author_name, author_handle,
            author_channel_id, author_thumbnail, text, like_count, reply_count,
            is_author_uploader, is_favorited, is_pinned, is_edited, time_text, published_at,
            created_at
         FROM video_comments
         WHERE video_id = ?
         ORDER BY id ASC",
    )
    .bind(media_id)
    .fetch_all(pool)
    .await
    .map_err(|error| db_error("failed to list media comments", error))
}

/// Marks a media as watched and returns the timestamp actually persisted by the database, so
/// the frontend can reflect the same value the next reload would show instead of fabricating its
/// own client clock value (which could drift from the stored one).
pub async fn mark_media_as_watched(pool: &SqlitePool, media_id: i64) -> AppResult<String> {
    let row: Option<(String,)> = sqlx::query_as(
        "UPDATE videos SET watched_at = CURRENT_TIMESTAMP, progress_seconds = 0 \
         WHERE id = ? RETURNING watched_at",
    )
    .bind(media_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| db_error("failed to mark media as watched", error))?;

    row.map(|(watched_at,)| watched_at)
        .ok_or_else(|| AppError::invalid_input("media not found"))
}

pub async fn mark_media_as_unwatched(pool: &SqlitePool, media_id: i64) -> AppResult<()> {
    sqlx::query("UPDATE videos SET watched_at = NULL WHERE id = ?")
        .bind(media_id)
        .execute(pool)
        .await
        .map_err(|error| db_error("failed to mark media as unwatched", error))?;

    Ok(())
}

pub async fn update_media_progress(
    pool: &SqlitePool,
    media_id: i64,
    progress_seconds: i64,
) -> AppResult<()> {
    sqlx::query("UPDATE videos SET progress_seconds = ? WHERE id = ? AND watched_at IS NULL")
        .bind(progress_seconds)
        .bind(media_id)
        .execute(pool)
        .await
        .map_err(|error| db_error("failed to update media progress", error))?;

    Ok(())
}

pub async fn count_media_using_thumbnail_outside_media(
    pool: &SqlitePool,
    thumbnail_path: &str,
    media_id: i64,
) -> AppResult<i64> {
    let (total,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) AS total FROM videos WHERE thumbnail_path = ? AND id <> ?")
            .bind(thumbnail_path)
            .bind(media_id)
            .fetch_one(pool)
            .await
            .map_err(|error| db_error("failed to count media using thumbnail", error))?;

    Ok(total)
}

pub async fn count_media_using_file_path_outside_media(
    pool: &SqlitePool,
    file_path: &str,
    media_id: i64,
) -> AppResult<i64> {
    let (total,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) AS total FROM videos WHERE file_path = ? AND id <> ?")
            .bind(file_path)
            .bind(media_id)
            .fetch_one(pool)
            .await
            .map_err(|error| db_error("failed to count media using file path", error))?;

    Ok(total)
}

pub async fn count_media_using_live_chat_outside_media(
    pool: &SqlitePool,
    live_chat_file_path: &str,
    media_id: i64,
) -> AppResult<i64> {
    let (total,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) AS total FROM videos WHERE live_chat_file_path = ? AND id <> ?",
    )
    .bind(live_chat_file_path)
    .bind(media_id)
    .fetch_one(pool)
    .await
    .map_err(|error| db_error("failed to count media using live chat file", error))?;

    Ok(total)
}

pub async fn get_media_repository_stats(pool: &SqlitePool) -> AppResult<MediaRepositoryStats> {
    sqlx::query_as::<_, MediaRepositoryStats>(
        "SELECT
            COUNT(*) AS total_media,
            COALESCE(SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END), 0) AS total_video_media,
            COALESCE(SUM(CASE WHEN media_type = 'audio' THEN 1 ELSE 0 END), 0) AS total_audio_media,
            COALESCE(SUM(CASE WHEN thumbnail_path IS NOT NULL AND TRIM(thumbnail_path) <> '' THEN 1 ELSE 0 END), 0) AS total_with_thumbnail,
            COALESCE(SUM(CASE WHEN thumbnail_path IS NULL OR TRIM(thumbnail_path) = '' THEN 1 ELSE 0 END), 0) AS total_without_thumbnail,
            COALESCE(SUM(CASE WHEN watched_at IS NOT NULL AND TRIM(watched_at) <> '' THEN 1 ELSE 0 END), 0) AS total_watched,
            COALESCE(SUM(CASE WHEN watched_at IS NULL OR TRIM(watched_at) = '' THEN 1 ELSE 0 END), 0) AS total_unwatched,
            COALESCE(SUM(CASE WHEN is_live = 1 THEN 1 ELSE 0 END), 0) AS total_live_media,
            COALESCE(SUM(CASE WHEN has_live_chat = 1 THEN 1 ELSE 0 END), 0) AS total_with_live_chat,
            COALESCE(SUM(CASE WHEN has_live_chat = 0 THEN 1 ELSE 0 END), 0) AS total_without_live_chat,
            COALESCE(SUM(CASE WHEN has_live_chat = 1 AND (live_chat_file_path IS NULL OR TRIM(live_chat_file_path) = '') THEN 1 ELSE 0 END), 0) AS total_media_with_live_chat_flag_but_no_path,
            COALESCE(SUM(CASE WHEN is_live = 0 AND live_chat_file_path IS NOT NULL AND TRIM(live_chat_file_path) <> '' THEN 1 ELSE 0 END), 0) AS total_media_with_live_chat_path_but_not_live
         FROM videos",
    )
    .fetch_one(pool)
    .await
    .map_err(|error| db_error("failed to compute media repository stats", error))
}

pub async fn list_media_integrity_references(
    pool: &SqlitePool,
) -> AppResult<Vec<MediaIntegrityReference>> {
    sqlx::query_as::<_, MediaIntegrityReference>(
        "SELECT id, channel_id, title, file_path, thumbnail_path, live_chat_file_path
         FROM videos
         ORDER BY id ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(|error| db_error("failed to list media integrity references", error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

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

        sqlx::query(
            "CREATE TABLE videos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                file_path TEXT NOT NULL,
                thumbnail_path TEXT,
                media_type TEXT NOT NULL DEFAULT 'video',
                youtube_video_id TEXT,
                watched_at TEXT,
                published_at TEXT,
                duration_seconds INTEGER,
                progress_seconds INTEGER NOT NULL DEFAULT 0,
                has_comments INTEGER NOT NULL DEFAULT 0,
                comments_count INTEGER NOT NULL DEFAULT 0,
                is_live INTEGER NOT NULL DEFAULT 0,
                has_live_chat INTEGER NOT NULL DEFAULT 0,
                live_chat_file_path TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE (channel_id, file_path)
            );",
        )
        .execute(&pool)
        .await
        .expect("create videos table");

        // Mirror the production partial unique index so the youtube_video_id conflict path is
        // exercised by tests (the table-level UNIQUE above only covers file_path).
        sqlx::query(
            "CREATE UNIQUE INDEX idx_videos_channel_youtube_video_id_unique
             ON videos(channel_id, youtube_video_id)
             WHERE youtube_video_id IS NOT NULL AND TRIM(youtube_video_id) <> ''",
        )
        .execute(&pool)
        .await
        .expect("create youtube_video_id unique index");

        pool
    }

    #[tokio::test]
    async fn insert_find_and_list_media() {
        let pool = create_test_pool().await;

        let id = insert_media(
            &pool,
            1,
            "Video A",
            "video/a.mp4",
            Some("thumb/a.jpg"),
            "video",
            Some("yt1"),
            Some("2026-01-01"),
            Some(120),
            false,
            None,
        )
        .await
        .unwrap()
        .unwrap();
        assert!(id > 0);

        let found = find_media_by_channel_and_file_path(&pool, 1, "video/a.mp4")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(found.title, "Video A");
        assert_eq!(found.duration_seconds, Some(120));
        assert_eq!(found.has_live_chat, 0);

        let list = list_media_by_channel(&pool, 1).await.unwrap();
        assert_eq!(list.len(), 1);
    }

    #[tokio::test]
    async fn insert_media_sets_live_chat_flag_from_path() {
        let pool = create_test_pool().await;

        let id = insert_media(
            &pool,
            1,
            "Live",
            "video/live.mp4",
            None,
            "video",
            None,
            None,
            None,
            true,
            Some("live_chat/live.json"),
        )
        .await
        .unwrap()
        .unwrap();

        let found = find_media_by_channel_and_file_path(&pool, 1, "video/live.mp4")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(found.id, id);
        assert_eq!(found.is_live, 1);
        assert_eq!(found.has_live_chat, 1);
        assert_eq!(
            found.live_chat_file_path.as_deref(),
            Some("live_chat/live.json")
        );
    }

    #[tokio::test]
    async fn insert_media_conflict_returns_existing_id() {
        let pool = create_test_pool().await;

        let first = insert_media(
            &pool,
            1,
            "A",
            "video/a.mp4",
            None,
            "video",
            None,
            None,
            None,
            false,
            None,
        )
        .await
        .unwrap()
        .unwrap();

        let second = insert_media(
            &pool,
            1,
            "A duplicate",
            "video/a.mp4",
            None,
            "video",
            None,
            None,
            None,
            false,
            None,
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(first, second);
        let found = find_media_by_channel_and_file_path(&pool, 1, "video/a.mp4")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(found.title, "A");
    }

    #[tokio::test]
    async fn insert_media_maps_a_duplicate_youtube_id_to_a_friendly_error() {
        let pool = create_test_pool().await;

        insert_media(
            &pool,
            1,
            "A",
            "video/a.mp4",
            None,
            "video",
            Some("yt1"),
            None,
            None,
            false,
            None,
        )
        .await
        .unwrap()
        .unwrap();

        // Same channel + youtube_video_id but a different file_path: the file_path ON CONFLICT
        // does not cover it, so it hits the youtube_video_id unique index and must surface as
        // the friendly domain error rather than a raw SQLite message.
        let error = insert_media(
            &pool,
            1,
            "A again",
            "video/b.mp4",
            None,
            "video",
            Some("yt1"),
            None,
            None,
            false,
            None,
        )
        .await
        .unwrap_err();

        assert_eq!(
            error.code,
            AppErrorCode::VideoAlreadyExistsForChannel.as_str()
        );
    }

    #[tokio::test]
    async fn media_exists_for_channel_and_youtube_id_matches_channel_and_id() {
        let pool = create_test_pool().await;
        insert_media(
            &pool,
            1,
            "A",
            "video/a.mp4",
            None,
            "video",
            Some("yt1"),
            None,
            None,
            false,
            None,
        )
        .await
        .unwrap();

        assert!(media_exists_for_channel_and_youtube_id(&pool, 1, "yt1")
            .await
            .unwrap());

        // Same youtube id but a different channel: not a duplicate for that channel.
        assert!(!media_exists_for_channel_and_youtube_id(&pool, 2, "yt1")
            .await
            .unwrap());

        // Same channel but a different youtube id: not a duplicate.
        assert!(!media_exists_for_channel_and_youtube_id(&pool, 1, "yt2")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn media_exists_for_channel_and_youtube_id_treats_blank_id_as_absent() {
        let pool = create_test_pool().await;
        insert_media(
            &pool,
            1,
            "A",
            "video/a.mp4",
            None,
            "video",
            Some("yt1"),
            None,
            None,
            false,
            None,
        )
        .await
        .unwrap();

        assert!(!media_exists_for_channel_and_youtube_id(&pool, 1, "   ")
            .await
            .unwrap());
        assert!(!media_exists_for_channel_and_youtube_id(&pool, 1, "")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn update_title_and_watched_state_and_progress() {
        let pool = create_test_pool().await;
        let id = insert_media(
            &pool,
            1,
            "A",
            "video/a.mp4",
            None,
            "video",
            None,
            None,
            None,
            false,
            None,
        )
        .await
        .unwrap()
        .unwrap();

        update_media_title(&pool, id, "Renamed").await.unwrap();
        update_media_progress(&pool, id, 42).await.unwrap();

        let media = find_media_by_channel_and_file_path(&pool, 1, "video/a.mp4")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(media.title, "Renamed");
        assert_eq!(media.progress_seconds, 42);
        assert!(media.watched_at.is_none());

        let returned_watched_at = mark_media_as_watched(&pool, id).await.unwrap();
        let watched = find_media_by_channel_and_file_path(&pool, 1, "video/a.mp4")
            .await
            .unwrap()
            .unwrap();
        assert!(watched.watched_at.is_some());
        // The command returns the exact timestamp the database stored, so the UI never diverges
        // from what a reload would show.
        assert_eq!(
            watched.watched_at.as_deref(),
            Some(returned_watched_at.as_str())
        );
        assert_eq!(watched.progress_seconds, 0);

        // progress is not updated while watched
        update_media_progress(&pool, id, 99).await.unwrap();
        let still_watched = find_media_by_channel_and_file_path(&pool, 1, "video/a.mp4")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(still_watched.progress_seconds, 0);

        mark_media_as_unwatched(&pool, id).await.unwrap();
        assert!(find_media_by_channel_and_file_path(&pool, 1, "video/a.mp4")
            .await
            .unwrap()
            .unwrap()
            .watched_at
            .is_none());
    }

    #[tokio::test]
    async fn mark_media_as_watched_errors_when_media_does_not_exist() {
        let pool = create_test_pool().await;

        let result = mark_media_as_watched(&pool, 9999).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn count_media_using_live_chat_outside_media_counts_other_rows() {
        let pool = create_test_pool().await;
        let a = insert_media(
            &pool,
            1,
            "A",
            "video/a.mp4",
            None,
            "video",
            None,
            None,
            None,
            false,
            Some("live_chat/shared.json"),
        )
        .await
        .unwrap()
        .unwrap();
        insert_media(
            &pool,
            2,
            "B",
            "video/b.mp4",
            None,
            "video",
            None,
            None,
            None,
            false,
            Some("live_chat/shared.json"),
        )
        .await
        .unwrap()
        .unwrap();

        // Two rows share the live chat file; excluding `a` leaves exactly one other user.
        assert_eq!(
            count_media_using_live_chat_outside_media(&pool, "live_chat/shared.json", a)
                .await
                .unwrap(),
            1
        );

        // A live chat path referenced by no row returns zero (safe to delete).
        assert_eq!(
            count_media_using_live_chat_outside_media(&pool, "live_chat/orphan.json", -1)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn delete_and_counts_and_stats() {
        let pool = create_test_pool().await;
        let a = insert_media(
            &pool,
            1,
            "A",
            "video/a.mp4",
            Some("thumb/s.jpg"),
            "video",
            None,
            None,
            None,
            false,
            None,
        )
        .await
        .unwrap()
        .unwrap();
        insert_media(
            &pool,
            2,
            "B",
            "video/a.mp4",
            Some("thumb/s.jpg"),
            "audio",
            None,
            None,
            None,
            false,
            None,
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(
            count_media_using_thumbnail_outside_media(&pool, "thumb/s.jpg", a)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            count_media_using_file_path_outside_media(&pool, "video/a.mp4", a)
                .await
                .unwrap(),
            1
        );

        let stats = get_media_repository_stats(&pool).await.unwrap();
        assert_eq!(stats.total_media, 2);
        assert_eq!(stats.total_video_media, 1);
        assert_eq!(stats.total_audio_media, 1);
        assert_eq!(stats.total_with_thumbnail, 2);

        let refs = list_media_integrity_references(&pool).await.unwrap();
        assert_eq!(refs.len(), 2);
    }

    #[tokio::test]
    async fn stats_on_empty_table_returns_zeroes() {
        let pool = create_test_pool().await;
        let stats = get_media_repository_stats(&pool).await.unwrap();
        assert_eq!(stats.total_media, 0);
        assert_eq!(stats.total_with_thumbnail, 0);
        assert_eq!(stats.total_without_live_chat, 0);
    }
}
