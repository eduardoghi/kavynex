use std::collections::HashSet;

use sqlx::SqlitePool;

use crate::models::yt_dlp::YtDlpComment;
use crate::{AppError, AppErrorCode, AppResult};

fn normalize_optional_text(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn sqlite_error(message: impl Into<String>, error: impl std::fmt::Display) -> AppError {
    AppError::from_code_with_details(AppErrorCode::AppError, message, error.to_string())
}

/// Drops comments that share a non-null `comment_id` with an earlier one in the same payload,
/// keeping the first occurrence. There is no UNIQUE(video_id, comment_id) constraint on the
/// table, so a yt-dlp payload with a repeated id would otherwise insert both rows. Comments
/// with a null/empty id (e.g. replies yt-dlp did not assign one) are never deduplicated against
/// each other, since they are legitimately distinct rows.
fn dedupe_comments_by_id(comments: Vec<YtDlpComment>) -> Vec<YtDlpComment> {
    let mut seen_ids = HashSet::new();

    comments
        .into_iter()
        .filter(
            |comment| match normalize_optional_text(&comment.comment_id) {
                Some(id) => seen_ids.insert(id),
                None => true,
            },
        )
        .collect()
}

pub async fn replace_media_comments(
    pool: &SqlitePool,
    media_id: i64,
    comments: Vec<YtDlpComment>,
) -> AppResult<u64> {
    if media_id <= 0 {
        return Err(AppError::from_code(
            AppErrorCode::InvalidInput,
            "media id must be a positive number",
        ));
    }

    replace_media_comments_in_pool(pool, media_id, comments).await
}

async fn replace_media_comments_in_pool(
    pool: &SqlitePool,
    media_id: i64,
    comments: Vec<YtDlpComment>,
) -> AppResult<u64> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| sqlite_error("failed to begin comments transaction", error))?;

    let result = async {
        sqlx::query("DELETE FROM video_comments WHERE video_id = ?")
            .bind(media_id)
            .execute(&mut *tx)
            .await?;

        let mut inserted_count = 0_u64;

        for comment in dedupe_comments_by_id(comments) {
            let normalized_text = comment.text.trim().to_owned();

            if normalized_text.is_empty() {
                continue;
            }

            sqlx::query(
                r#"
                INSERT INTO video_comments (
                    video_id,
                    comment_id,
                    parent_comment_id,
                    author_name,
                    author_handle,
                    author_channel_id,
                    author_thumbnail,
                    text,
                    like_count,
                    reply_count,
                    is_author_uploader,
                    is_favorited,
                    is_pinned,
                    is_edited,
                    time_text,
                    published_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                "#,
            )
            .bind(media_id)
            .bind(normalize_optional_text(&comment.comment_id))
            .bind(normalize_optional_text(&comment.parent_comment_id))
            .bind({
                let author_name = comment.author_name.trim();
                if author_name.is_empty() {
                    "Unknown author"
                } else {
                    author_name
                }
            })
            .bind(normalize_optional_text(&comment.author_handle))
            .bind(normalize_optional_text(&comment.author_channel_id))
            .bind(normalize_optional_text(&comment.author_thumbnail))
            .bind(normalized_text)
            // like_count/reply_count are u64 from yt-dlp; saturate to i64::MAX on the
            // (practically impossible) overflow rather than failing the whole insert over a count.
            .bind(i64::try_from(comment.like_count).unwrap_or(i64::MAX))
            .bind(i64::try_from(comment.reply_count).unwrap_or(i64::MAX))
            .bind(if comment.is_author_uploader {
                1_i64
            } else {
                0_i64
            })
            .bind(if comment.is_favorited { 1_i64 } else { 0_i64 })
            .bind(if comment.is_pinned { 1_i64 } else { 0_i64 })
            .bind(if comment.is_edited { 1_i64 } else { 0_i64 })
            .bind(normalize_optional_text(&comment.time_text))
            .bind(normalize_optional_text(&comment.published_at))
            .execute(&mut *tx)
            .await?;

            inserted_count += 1;
        }

        sqlx::query(
            r#"
            UPDATE videos
            SET has_comments = ?,
                comments_count = ?
            WHERE id = ?
            "#,
        )
        .bind(if inserted_count > 0 { 1_i64 } else { 0_i64 })
        .bind(i64::try_from(inserted_count).unwrap_or(i64::MAX))
        .bind(media_id)
        .execute(&mut *tx)
        .await?;

        Ok::<u64, sqlx::Error>(inserted_count)
    }
    .await;

    match result {
        Ok(inserted_count) => {
            tx.commit()
                .await
                .map_err(|error| sqlite_error("failed to commit comments transaction", error))?;
            Ok(inserted_count)
        }
        Err(error) => {
            let rollback_result = tx.rollback().await;

            if let Err(rollback_error) = rollback_result {
                return Err(AppError::from_code_with_details(
                    AppErrorCode::AppError,
                    "failed to persist comments and rollback transaction",
                    format!("persist error: {error}; rollback error: {rollback_error}"),
                ));
            }

            Err(sqlite_error("failed to persist comments", error))
        }
    }
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    use super::*;

    async fn create_test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create sqlite memory pool");

        sqlx::query(
            r#"
            CREATE TABLE videos (
                id INTEGER PRIMARY KEY,
                has_comments INTEGER NOT NULL DEFAULT 0,
                comments_count INTEGER NOT NULL DEFAULT 0
            );
            "#,
        )
        .execute(&pool)
        .await
        .expect("create videos table");

        sqlx::query(
            r#"
            CREATE TABLE video_comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                video_id INTEGER NOT NULL,
                comment_id TEXT,
                parent_comment_id TEXT,
                author_name TEXT NOT NULL,
                author_handle TEXT,
                author_channel_id TEXT,
                author_thumbnail TEXT,
                text TEXT NOT NULL CHECK (text <> 'Invalid'),
                like_count INTEGER NOT NULL DEFAULT 0,
                reply_count INTEGER NOT NULL DEFAULT 0,
                is_author_uploader INTEGER NOT NULL DEFAULT 0,
                is_favorited INTEGER NOT NULL DEFAULT 0,
                is_pinned INTEGER NOT NULL DEFAULT 0,
                is_edited INTEGER NOT NULL DEFAULT 0,
                time_text TEXT,
                published_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
            );
            "#,
        )
        .execute(&pool)
        .await
        .expect("create comments table");

        sqlx::query("INSERT INTO videos (id) VALUES (1)")
            .execute(&pool)
            .await
            .expect("insert video");

        pool
    }

    fn sample_comment(text: &str) -> YtDlpComment {
        comment_with_id(text, Some("c1"))
    }

    fn comment_with_id(text: &str, comment_id: Option<&str>) -> YtDlpComment {
        YtDlpComment {
            comment_id: comment_id.map(ToOwned::to_owned),
            parent_comment_id: None,
            author_name: "Alice".to_string(),
            author_handle: Some("@alice".to_string()),
            author_channel_id: None,
            author_thumbnail: None,
            text: text.to_string(),
            like_count: 5,
            reply_count: 1,
            is_author_uploader: false,
            is_favorited: false,
            is_pinned: true,
            is_edited: false,
            time_text: Some("1 day ago".to_string()),
            published_at: Some("2026-01-01".to_string()),
        }
    }

    #[test]
    fn dedupe_comments_by_id_keeps_first_occurrence_and_all_null_id_rows() {
        let comments = vec![
            comment_with_id("first", Some("c1")),
            comment_with_id("duplicate", Some("c1")),
            comment_with_id("other", Some("c2")),
            comment_with_id("reply without id 1", None),
            comment_with_id("reply without id 2", None),
        ];

        let deduped = dedupe_comments_by_id(comments);

        assert_eq!(deduped.len(), 4);
        assert_eq!(deduped[0].text, "first");
        assert_eq!(deduped[1].text, "other");
        assert_eq!(deduped[2].text, "reply without id 1");
        assert_eq!(deduped[3].text, "reply without id 2");
    }

    #[tokio::test]
    async fn replace_media_comments_inserts_non_blank_comments_and_updates_flags() {
        let pool = create_test_pool().await;

        let inserted = replace_media_comments_in_pool(
            &pool,
            1,
            vec![sample_comment("Great video!"), sample_comment("   ")],
        )
        .await
        .expect("replace comments");

        let (total_comments,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM video_comments WHERE video_id = 1")
                .fetch_one(&pool)
                .await
                .expect("count comments");
        let (has_comments, comments_count): (i64, i64) =
            sqlx::query_as("SELECT has_comments, comments_count FROM videos WHERE id = 1")
                .fetch_one(&pool)
                .await
                .expect("read video flags");

        assert_eq!(inserted, 1);
        assert_eq!(total_comments, 1);
        assert_eq!(has_comments, 1);
        assert_eq!(comments_count, 1);
    }

    #[tokio::test]
    async fn replace_media_comments_drops_repeated_comment_id_but_keeps_null_id_rows() {
        let pool = create_test_pool().await;

        let inserted = replace_media_comments_in_pool(
            &pool,
            1,
            vec![
                comment_with_id("first", Some("c1")),
                comment_with_id("duplicate", Some("c1")),
                comment_with_id("reply without id 1", None),
                comment_with_id("reply without id 2", None),
            ],
        )
        .await
        .expect("replace comments");

        let (total_comments,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM video_comments WHERE video_id = 1")
                .fetch_one(&pool)
                .await
                .expect("count comments");
        let (c1_count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM video_comments WHERE comment_id = 'c1'")
                .fetch_one(&pool)
                .await
                .expect("count c1 comments");
        let (kept_text,): (String,) =
            sqlx::query_as("SELECT text FROM video_comments WHERE comment_id = 'c1'")
                .fetch_one(&pool)
                .await
                .expect("read kept comment");

        // The repeated "c1" is collapsed to a single row (the first occurrence), while the
        // two null-id replies are both kept since they are legitimately distinct rows.
        assert_eq!(inserted, 3);
        assert_eq!(total_comments, 3);
        assert_eq!(c1_count, 1);
        assert_eq!(kept_text, "first");
    }

    #[tokio::test]
    async fn replace_media_comments_rolls_back_when_insert_fails() {
        let pool = create_test_pool().await;

        replace_media_comments_in_pool(&pool, 1, vec![sample_comment("Original")])
            .await
            .expect("seed comments");

        let result =
            replace_media_comments_in_pool(&pool, 1, vec![sample_comment("Invalid")]).await;

        let (total_comments,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM video_comments WHERE video_id = 1")
                .fetch_one(&pool)
                .await
                .expect("count comments");
        let (text,): (String,) =
            sqlx::query_as("SELECT text FROM video_comments WHERE video_id = 1")
                .fetch_one(&pool)
                .await
                .expect("read original comment");

        assert!(result.is_err());
        assert_eq!(total_comments, 1);
        assert_eq!(text, "Original");
    }
}
