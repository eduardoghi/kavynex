use serde::Serialize;
use sqlx::SqlitePool;
use ts_rs::TS;

use crate::services::database::{db_error, is_unique_violation};
use crate::{AppError, AppErrorCode, AppResult};

// Exposed to the frontend as `Channel`; `id` is annotated as `number` (see MediaRow).
#[derive(Debug, Serialize, sqlx::FromRow, TS)]
#[ts(export, rename = "Channel", export_to = "../../src/types/generated/")]
pub struct ChannelRow {
    #[ts(type = "number")]
    pub id: i64,
    pub name: String,
    pub youtube_handle: String,
    pub avatar_path: Option<String>,
    pub created_at: String,
}

pub async fn list_channels(pool: &SqlitePool) -> AppResult<Vec<ChannelRow>> {
    sqlx::query_as::<_, ChannelRow>(
        "SELECT id, name, youtube_handle, avatar_path, created_at
         FROM channels
         ORDER BY name ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(|error| db_error("failed to list channels", error))
}

pub async fn find_channel_by_youtube_handle(
    pool: &SqlitePool,
    youtube_handle: &str,
) -> AppResult<Option<ChannelRow>> {
    sqlx::query_as::<_, ChannelRow>(
        "SELECT id, name, youtube_handle, avatar_path, created_at
         FROM channels
         WHERE youtube_handle = ?
         LIMIT 1",
    )
    .bind(youtube_handle)
    .fetch_optional(pool)
    .await
    .map_err(|error| db_error("failed to find channel by handle", error))
}

pub async fn get_channel_by_id(
    pool: &SqlitePool,
    channel_id: i64,
) -> AppResult<Option<ChannelRow>> {
    sqlx::query_as::<_, ChannelRow>(
        "SELECT id, name, youtube_handle, avatar_path, created_at
         FROM channels
         WHERE id = ?
         LIMIT 1",
    )
    .bind(channel_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| db_error("failed to get channel by id", error))
}

pub async fn insert_channel(
    pool: &SqlitePool,
    name: &str,
    youtube_handle: &str,
    avatar_path: Option<&str>,
) -> AppResult<Option<i64>> {
    let result =
        sqlx::query("INSERT INTO channels (name, youtube_handle, avatar_path) VALUES (?, ?, ?)")
            .bind(name)
            .bind(youtube_handle)
            .bind(avatar_path)
            .execute(pool)
            .await
            .map_err(|error| {
                // youtube_handle is the only UNIQUE column, so a surfacing unique violation is a
                // duplicate handle. Map it to the same friendly code the frontend pre-check
                // raises, closing the check-then-act race with a consistent message.
                if is_unique_violation(&error) {
                    return AppError::from_code(
                        AppErrorCode::ChannelAlreadyExists,
                        "a channel with this YouTube handle already exists",
                    );
                }

                db_error("failed to insert channel", error)
            })?;

    let inserted_id = result.last_insert_rowid();

    Ok(if inserted_id > 0 {
        Some(inserted_id)
    } else {
        None
    })
}

pub async fn update_channel_name_and_handle(
    pool: &SqlitePool,
    channel_id: i64,
    name: &str,
    youtube_handle: &str,
) -> AppResult<()> {
    sqlx::query("UPDATE channels SET name = ?, youtube_handle = ? WHERE id = ?")
        .bind(name)
        .bind(youtube_handle)
        .bind(channel_id)
        .execute(pool)
        .await
        .map_err(|error| db_error("failed to update channel name and handle", error))?;

    Ok(())
}

pub async fn update_channel_avatar_path(
    pool: &SqlitePool,
    channel_id: i64,
    avatar_path: Option<&str>,
) -> AppResult<()> {
    sqlx::query("UPDATE channels SET avatar_path = ? WHERE id = ?")
        .bind(avatar_path)
        .bind(channel_id)
        .execute(pool)
        .await
        .map_err(|error| db_error("failed to update channel avatar path", error))?;

    Ok(())
}

pub async fn count_channels_using_avatar_path_outside_channel(
    pool: &SqlitePool,
    avatar_path: &str,
    channel_id: i64,
) -> AppResult<i64> {
    let (total,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) AS total FROM channels WHERE avatar_path = ? AND id <> ?")
            .bind(avatar_path)
            .bind(channel_id)
            .fetch_one(pool)
            .await
            .map_err(|error| db_error("failed to count channels using avatar path", error))?;

    Ok(total)
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
            "CREATE TABLE channels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                youtube_handle TEXT NOT NULL UNIQUE,
                avatar_path TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );",
        )
        .execute(&pool)
        .await
        .expect("create channels table");

        sqlx::query(
            "CREATE TABLE videos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                file_path TEXT NOT NULL,
                thumbnail_path TEXT,
                media_type TEXT NOT NULL DEFAULT 'video',
                FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
            );",
        )
        .execute(&pool)
        .await
        .expect("create videos table");

        pool
    }

    #[tokio::test]
    async fn insert_and_get_channel_roundtrip() {
        let pool = create_test_pool().await;

        let id = insert_channel(&pool, "Alice", "@alice", Some("thumbnails/a.jpg"))
            .await
            .unwrap()
            .unwrap();
        assert!(id > 0);

        let channel = get_channel_by_id(&pool, id).await.unwrap().unwrap();
        assert_eq!(channel.name, "Alice");
        assert_eq!(channel.youtube_handle, "@alice");
        assert_eq!(channel.avatar_path.as_deref(), Some("thumbnails/a.jpg"));
    }

    #[tokio::test]
    async fn insert_channel_maps_a_duplicate_handle_to_a_friendly_error() {
        let pool = create_test_pool().await;

        insert_channel(&pool, "Alice", "@alice", None)
            .await
            .unwrap()
            .unwrap();

        // A second channel with the same handle hits the UNIQUE constraint and must surface as
        // the friendly domain error, not a raw SQLite message.
        let error = insert_channel(&pool, "Also Alice", "@alice", None)
            .await
            .unwrap_err();

        assert_eq!(error.code, AppErrorCode::ChannelAlreadyExists.as_str());
    }

    #[tokio::test]
    async fn get_channel_by_id_returns_none_when_missing() {
        let pool = create_test_pool().await;
        assert!(get_channel_by_id(&pool, 999).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn list_channels_orders_by_name() {
        let pool = create_test_pool().await;
        insert_channel(&pool, "Zebra", "@z", None).await.unwrap();
        insert_channel(&pool, "Alpha", "@a", None).await.unwrap();
        insert_channel(&pool, "Mango", "@m", None).await.unwrap();

        let names: Vec<String> = list_channels(&pool)
            .await
            .unwrap()
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(names, vec!["Alpha", "Mango", "Zebra"]);
    }

    #[tokio::test]
    async fn find_channel_by_youtube_handle_works() {
        let pool = create_test_pool().await;
        insert_channel(&pool, "Alice", "@alice", None)
            .await
            .unwrap();

        assert_eq!(
            find_channel_by_youtube_handle(&pool, "@alice")
                .await
                .unwrap()
                .unwrap()
                .name,
            "Alice"
        );
        assert!(find_channel_by_youtube_handle(&pool, "@nobody")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn update_name_handle_and_avatar() {
        let pool = create_test_pool().await;
        let id = insert_channel(&pool, "Old", "@old", None)
            .await
            .unwrap()
            .unwrap();

        update_channel_name_and_handle(&pool, id, "New", "@new")
            .await
            .unwrap();
        update_channel_avatar_path(&pool, id, Some("thumbnails/x.jpg"))
            .await
            .unwrap();

        let channel = get_channel_by_id(&pool, id).await.unwrap().unwrap();
        assert_eq!(channel.name, "New");
        assert_eq!(channel.youtube_handle, "@new");
        assert_eq!(channel.avatar_path.as_deref(), Some("thumbnails/x.jpg"));

        update_channel_avatar_path(&pool, id, None).await.unwrap();
        assert!(get_channel_by_id(&pool, id)
            .await
            .unwrap()
            .unwrap()
            .avatar_path
            .is_none());
    }

    #[tokio::test]
    async fn count_channels_using_avatar_path_outside_channel_excludes_own_channel() {
        let pool = create_test_pool().await;
        let a = insert_channel(&pool, "A", "@a", Some("shared.jpg"))
            .await
            .unwrap()
            .unwrap();
        insert_channel(&pool, "B", "@b", Some("shared.jpg"))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            count_channels_using_avatar_path_outside_channel(&pool, "shared.jpg", a)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            count_channels_using_avatar_path_outside_channel(&pool, "unused.jpg", a)
                .await
                .unwrap(),
            0
        );
    }
}
