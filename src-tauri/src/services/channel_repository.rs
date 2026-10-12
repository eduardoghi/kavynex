use serde::Serialize;
use sqlx::SqlitePool;

use crate::services::database::{db_error, is_unique_violation};
use crate::{AppError, AppErrorCode, AppResult};

// Exposed to the frontend as `Channel`; `id` is annotated as `number` (see MediaRow).
#[derive(Debug, Serialize, sqlx::FromRow)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export, rename = "Channel", export_to = "../../src/types/generated/")
)]
pub struct ChannelRow {
    #[cfg_attr(test, ts(type = "number"))]
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

/// Every non-blank channel avatar path.
///
/// Read by the library integrity check, which has to count an avatar as a *referenced* thumbnail.
/// Avatars live under `thumbnails/` but are referenced by the channels table rather than by any
/// media row, so without them an avatar that is not also a media thumbnail would be reported as an
/// orphan. Inviting the user to delete a file the app is still using.
///
/// Selects only the column it needs rather than reusing `list_channels`. This runs on every
/// Diagnostics open, the blank filter is what keeps an empty-string path out of the expected set,
/// and `idx_channels_avatar_path` can serve it without touching the table.
pub async fn list_channel_avatar_paths(pool: &SqlitePool) -> AppResult<Vec<String>> {
    sqlx::query_scalar::<_, String>(
        "SELECT avatar_path
         FROM channels
         WHERE avatar_path IS NOT NULL AND TRIM(avatar_path) <> ''",
    )
    .fetch_all(pool)
    .await
    .map_err(|error| db_error("failed to list channel avatar paths", error))
}

pub async fn find_channel_by_youtube_handle(
    pool: &SqlitePool,
    youtube_handle: &str,
) -> AppResult<Option<ChannelRow>> {
    sqlx::query_as::<_, ChannelRow>(
        "SELECT id, name, youtube_handle, avatar_path, created_at
         FROM channels
         WHERE youtube_handle = ? COLLATE NOCASE
         ORDER BY youtube_handle = ? DESC, id
         LIMIT 1",
    )
    .bind(youtube_handle)
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
) -> AppResult<i64> {
    // YouTube handles are case-insensitive, so `@Foo` and `@foo` are one channel, while the column's
    // UNIQUE compares them as text. The check is in the same statement as the insert so two adds
    // cannot both pass it. The UNIQUE stays behind it for the exact spelling.
    let result = sqlx::query(
        "INSERT INTO channels (name, youtube_handle, avatar_path)
         SELECT ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM channels WHERE youtube_handle = ? COLLATE NOCASE)",
    )
    .bind(name)
    .bind(youtube_handle)
    .bind(avatar_path)
    .bind(youtube_handle)
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

    if result.rows_affected() == 0 {
        return Err(AppError::from_code(
            AppErrorCode::ChannelAlreadyExists,
            "a channel with this YouTube handle already exists",
        ));
    }

    let inserted_id = result.last_insert_rowid();

    // A successful INSERT always yields a positive rowid, so the non-positive case is a
    // should-never-happen guard, not a real null the caller must handle.
    if inserted_id > 0 {
        Ok(inserted_id)
    } else {
        Err(AppError::internal("channel insert produced no row id"))
    }
}

pub async fn update_channel_name_and_handle(
    pool: &SqlitePool,
    channel_id: i64,
    name: &str,
    youtube_handle: &str,
) -> AppResult<()> {
    // The same case-insensitive rule as insert_channel, in the same statement as the update. A
    // handle the row already holds, spelled exactly, passes regardless. A database from before the
    // rule can hold two channels whose handles differ only in case, and without that a rename of
    // either would be refused for a conflict it did not introduce.
    let result = sqlx::query(
        "UPDATE channels SET name = ?, youtube_handle = ?
         WHERE id = ?
           AND (
               youtube_handle = ?
               OR NOT EXISTS (
                   SELECT 1 FROM channels WHERE youtube_handle = ? COLLATE NOCASE AND id <> ?
               )
           )",
    )
    .bind(name)
    .bind(youtube_handle)
    .bind(channel_id)
    .bind(youtube_handle)
    .bind(youtube_handle)
    .bind(channel_id)
    .execute(pool)
    .await
    .map_err(|error| {
        // Same UNIQUE column as insert_channel, so a rename onto a handle another channel
        // already holds must report the same actionable code. Without this it fell through
        // to db_error's generic AppError, whose details the frontend deliberately suppresses,
        // leaving the user with an unactionable message for a fixable mistake.
        if is_unique_violation(&error) {
            return AppError::from_code(
                AppErrorCode::ChannelAlreadyExists,
                "a channel with this YouTube handle already exists",
            );
        }

        db_error("failed to update channel name and handle", error)
    })?;

    if result.rows_affected() == 0 {
        // Either the channel is gone or another one holds the handle in another case.
        if get_channel_by_id(pool, channel_id).await?.is_some() {
            return Err(AppError::from_code(
                AppErrorCode::ChannelAlreadyExists,
                "a channel with this YouTube handle already exists",
            ));
        }

        return Err(AppError::from_code(
            AppErrorCode::ChannelNotFound,
            "the channel no longer exists",
        ));
    }

    Ok(())
}

// `update_channel_avatar_path` and `count_channels_using_avatar_path_outside_channel` lived here
// until they were superseded by `library::cleanup::replace_channel_avatar_and_plan_cleanup`, which
// does the update and the reference decision in one transaction. Both were removed rather than
// kept "in case". Neither had a caller outside its own test, and the count encoded the *older*
// rule. It only looked at other channels' avatars, missing the video thumbnails that can point
// at the same content-addressed file, which is the exact bug the replacement fixes. A dead
// helper that still passes its own tests is the kind of thing a future change reaches for.

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
            .unwrap();

        // A second channel with the same handle hits the UNIQUE constraint and must surface as
        // the friendly domain error, not a raw SQLite message.
        let error = insert_channel(&pool, "Also Alice", "@alice", None)
            .await
            .unwrap_err();

        assert_eq!(error.code, AppErrorCode::ChannelAlreadyExists.as_str());
    }

    #[tokio::test]
    async fn update_channel_name_and_handle_maps_a_duplicate_handle_to_a_friendly_error() {
        let pool = create_test_pool().await;

        insert_channel(&pool, "Alice", "@alice", None)
            .await
            .unwrap();
        let bob_id = insert_channel(&pool, "Bob", "@bob", None).await.unwrap();

        // Renaming Bob onto Alice's handle hits the same UNIQUE constraint insert_channel does,
        // so it must surface the same actionable code rather than a generic database error.
        let error = update_channel_name_and_handle(&pool, bob_id, "Bob", "@alice")
            .await
            .unwrap_err();

        assert_eq!(error.code, AppErrorCode::ChannelAlreadyExists.as_str());
    }

    #[tokio::test]
    async fn update_channel_name_and_handle_renames_to_a_free_handle() {
        let pool = create_test_pool().await;

        let id = insert_channel(&pool, "Bob", "@bob", None).await.unwrap();

        // The guard above must not reject a legitimate rename.
        update_channel_name_and_handle(&pool, id, "Bobby", "@bobby")
            .await
            .unwrap();

        let channel = get_channel_by_id(&pool, id).await.unwrap().unwrap();
        assert_eq!(channel.name, "Bobby");
        assert_eq!(channel.youtube_handle, "@bobby");
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
    async fn update_name_and_handle() {
        let pool = create_test_pool().await;
        let id = insert_channel(&pool, "Old", "@old", None).await.unwrap();

        update_channel_name_and_handle(&pool, id, "New", "@new")
            .await
            .unwrap();

        let channel = get_channel_by_id(&pool, id).await.unwrap().unwrap();
        assert_eq!(channel.name, "New");
        assert_eq!(channel.youtube_handle, "@new");
    }

    #[tokio::test]
    async fn a_handle_that_differs_only_in_case_is_the_same_channel() {
        let pool = create_test_pool().await;
        insert_channel(&pool, "Alice", "@Alice", None)
            .await
            .unwrap();

        let error = insert_channel(&pool, "Alice again", "@alice", None)
            .await
            .expect_err("YouTube handles ignore case");

        assert_eq!(error.code, AppErrorCode::ChannelAlreadyExists.as_str());
        assert!(find_channel_by_youtube_handle(&pool, "@ALICE")
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn a_rename_onto_another_channels_handle_in_another_case_is_refused() {
        let pool = create_test_pool().await;
        insert_channel(&pool, "Alice", "@alice", None)
            .await
            .unwrap();
        let bob = insert_channel(&pool, "Bob", "@bob", None).await.unwrap();

        let error = update_channel_name_and_handle(&pool, bob, "Bob", "@ALICE")
            .await
            .expect_err("the handle belongs to Alice");

        assert_eq!(error.code, AppErrorCode::ChannelAlreadyExists.as_str());
    }

    #[tokio::test]
    async fn a_channel_can_change_the_case_of_its_own_handle() {
        let pool = create_test_pool().await;
        let alice = insert_channel(&pool, "Alice", "@alice", None)
            .await
            .unwrap();

        update_channel_name_and_handle(&pool, alice, "Alice", "@Alice")
            .await
            .expect("its own handle in another case is not a conflict");
    }

    /// Two channels whose handles differ only in case, which a database from before the
    /// case-insensitive rule can hold. Written past the rule on purpose.
    async fn legacy_case_duplicates(pool: &SqlitePool) -> (i64, i64) {
        let upper = insert_channel(pool, "Foo", "@Foo", None).await.unwrap();
        let lower =
            sqlx::query("INSERT INTO channels (name, youtube_handle) VALUES ('foo', '@foo')")
                .execute(pool)
                .await
                .unwrap()
                .last_insert_rowid();

        (upper, lower)
    }

    #[tokio::test]
    async fn a_legacy_case_duplicate_can_still_be_renamed_keeping_its_handle() {
        let pool = create_test_pool().await;
        let (_, lower) = legacy_case_duplicates(&pool).await;

        update_channel_name_and_handle(&pool, lower, "Foo (second)", "@foo")
            .await
            .expect("a channel keeping the handle it already holds is not a conflict");

        let channel = get_channel_by_id(&pool, lower).await.unwrap().unwrap();
        assert_eq!(channel.name, "Foo (second)");
    }

    #[tokio::test]
    async fn the_lookup_prefers_the_channel_holding_the_exact_spelling() {
        let pool = create_test_pool().await;
        let (upper, lower) = legacy_case_duplicates(&pool).await;

        let found = |handle: &'static str| {
            let pool = pool.clone();
            async move {
                find_channel_by_youtube_handle(&pool, handle)
                    .await
                    .unwrap()
                    .unwrap()
                    .id
            }
        };

        assert_eq!(found("@foo").await, lower);
        assert_eq!(found("@Foo").await, upper);
        assert_eq!(found("@FOO").await, upper);
    }
}
