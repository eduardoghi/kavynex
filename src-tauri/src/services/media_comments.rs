use std::collections::HashSet;

use sqlx::{QueryBuilder, SqlitePool};

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
    // Reuse the single db_error constructor (services::database) rather than re-deriving the
    // same AppError::from_code_with_details(AppErrorCode::AppError, ...) shape here.
    crate::services::database::db_error(message, error)
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

// Comments are written in multi-row batches instead of one INSERT per row. Each row binds 16
// columns, so 50 rows is 800 bound parameters - comfortably under SQLite's default variable
// limit (999 on older builds) - while collapsing the thousands of round-trips a heavily
// commented video used to hold the transaction open for into a handful.
const COMMENT_INSERT_CHUNK_SIZE: usize = 50;

/// One comment row, already normalized into the exact column order the INSERT below binds.
/// Preparing the rows up front (deduped, blank text dropped, counts saturated) lets them be
/// inserted in batches rather than one statement per comment.
struct PreparedComment {
    comment_id: Option<String>,
    parent_comment_id: Option<String>,
    author_name: String,
    author_handle: Option<String>,
    author_channel_id: Option<String>,
    author_thumbnail: Option<String>,
    text: String,
    like_count: i64,
    reply_count: i64,
    is_author_uploader: i64,
    is_favorited: i64,
    is_pinned: i64,
    is_edited: i64,
    time_text: Option<String>,
    published_at: Option<String>,
}

/// Dedupes the payload, drops comments whose text is blank, and normalizes every field into the
/// row shape persisted below, preserving insertion order.
fn prepare_comment_rows(comments: Vec<YtDlpComment>) -> Vec<PreparedComment> {
    // Drop blank-text comments before deduping by id. Dedup keeps the first occurrence of a repeated
    // comment_id, so a payload whose first occurrence has blank text and a later one has real content
    // would otherwise keep the blank one here and then drop it, silently losing the real comment.
    // Filtering first makes the real comment the first occurrence dedup sees.
    let non_blank: Vec<YtDlpComment> = comments
        .into_iter()
        .filter(|comment| !comment.text.trim().is_empty())
        .collect();

    dedupe_comments_by_id(non_blank)
        .into_iter()
        .map(|comment| {
            let text = comment.text.trim().to_owned();

            let author_name = {
                let trimmed = comment.author_name.trim();
                if trimmed.is_empty() {
                    "Unknown author".to_owned()
                } else {
                    trimmed.to_owned()
                }
            };

            PreparedComment {
                comment_id: normalize_optional_text(&comment.comment_id),
                parent_comment_id: normalize_optional_text(&comment.parent_comment_id),
                author_name,
                author_handle: normalize_optional_text(&comment.author_handle),
                author_channel_id: normalize_optional_text(&comment.author_channel_id),
                author_thumbnail: normalize_optional_text(&comment.author_thumbnail),
                text,
                // like_count/reply_count are u64 from yt-dlp; saturate to i64::MAX on the
                // (practically impossible) overflow rather than dropping the whole batch over a count.
                like_count: i64::try_from(comment.like_count).unwrap_or(i64::MAX),
                reply_count: i64::try_from(comment.reply_count).unwrap_or(i64::MAX),
                is_author_uploader: i64::from(comment.is_author_uploader),
                is_favorited: i64::from(comment.is_favorited),
                is_pinned: i64::from(comment.is_pinned),
                is_edited: i64::from(comment.is_edited),
                time_text: normalize_optional_text(&comment.time_text),
                published_at: normalize_optional_text(&comment.published_at),
            }
        })
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

        let rows = prepare_comment_rows(comments);
        let inserted_count = rows.len() as u64;

        // Insert in multi-row batches so a video with thousands of comments no longer holds the
        // transaction open across thousands of individual round-trips (see COMMENT_INSERT_CHUNK_SIZE).
        for chunk in rows.chunks(COMMENT_INSERT_CHUNK_SIZE) {
            let mut query_builder = QueryBuilder::new(
                "INSERT INTO video_comments (\
                 video_id, comment_id, parent_comment_id, author_name, author_handle, \
                 author_channel_id, author_thumbnail, text, like_count, reply_count, \
                 is_author_uploader, is_favorited, is_pinned, is_edited, time_text, published_at) ",
            );

            query_builder.push_values(chunk, |mut row, comment| {
                row.push_bind(media_id)
                    .push_bind(comment.comment_id.as_deref())
                    .push_bind(comment.parent_comment_id.as_deref())
                    .push_bind(comment.author_name.as_str())
                    .push_bind(comment.author_handle.as_deref())
                    .push_bind(comment.author_channel_id.as_deref())
                    .push_bind(comment.author_thumbnail.as_deref())
                    .push_bind(comment.text.as_str())
                    .push_bind(comment.like_count)
                    .push_bind(comment.reply_count)
                    .push_bind(comment.is_author_uploader)
                    .push_bind(comment.is_favorited)
                    .push_bind(comment.is_pinned)
                    .push_bind(comment.is_edited)
                    .push_bind(comment.time_text.as_deref())
                    .push_bind(comment.published_at.as_deref());
            });

            query_builder.build().execute(&mut *tx).await?;
        }

        let update_result = sqlx::query(
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

        Ok::<(u64, u64), sqlx::Error>((inserted_count, update_result.rows_affected()))
    }
    .await;

    match result {
        Ok((inserted_count, updated_rows)) => {
            // With no comments to insert, the video_comments foreign key that maps a vanished media
            // row to MediaNotFound never fires (the insert loop is skipped), so a media deleted
            // concurrently while its zero-length comment fetch was finishing is detected here
            // instead: the UPDATE matched no row. Roll back and report it, mirroring the non-empty
            // path's foreign-key handling below.
            if updated_rows == 0 {
                let _ = tx.rollback().await;
                return Err(AppError::from_code(
                    AppErrorCode::MediaNotFound,
                    "the media no longer exists",
                ));
            }

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

            // The video_comments.video_id foreign key no longer resolves: the media row was
            // removed (e.g. deleted concurrently while a yt-dlp comment fetch was finishing).
            // Map it to a friendly code instead of a raw SQLite foreign-key constraint error,
            // mirroring insert_media's channel_id handling (video_repository.rs).
            if crate::services::database::is_foreign_key_violation(&error) {
                return Err(AppError::from_code(
                    AppErrorCode::MediaNotFound,
                    "the media no longer exists",
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
    async fn replace_media_comments_maps_foreign_key_violation_to_media_not_found() {
        let pool = create_test_pool().await;
        // The real pool opens with foreign_keys ON (services::database); the in-memory test pool
        // must enable it explicitly to exercise the mapping. max_connections(1) keeps this PRAGMA
        // on the same connection the transaction below reuses.
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .expect("enable foreign keys");

        // media id 999 has no `videos` row, so the comment insert violates the video_id FK.
        let error = replace_media_comments_in_pool(&pool, 999, vec![sample_comment("orphan")])
            .await
            .expect_err("insert against a missing media must fail");

        assert_eq!(error.code, AppErrorCode::MediaNotFound.as_str());
    }

    #[tokio::test]
    async fn replace_media_comments_keeps_the_real_comment_behind_a_blank_duplicate_id() {
        let pool = create_test_pool().await;

        // Two entries share comment_id "c1": the first is blank, the second has real content. The
        // blank one must not win the dedup and then be dropped, silently losing the real comment.
        let inserted = replace_media_comments_in_pool(
            &pool,
            1,
            vec![
                comment_with_id("   ", Some("c1")),
                comment_with_id("the real comment", Some("c1")),
            ],
        )
        .await
        .expect("replace comments");

        let (kept_text,): (String,) =
            sqlx::query_as("SELECT text FROM video_comments WHERE comment_id = 'c1'")
                .fetch_one(&pool)
                .await
                .expect("read kept comment");

        assert_eq!(inserted, 1);
        assert_eq!(kept_text, "the real comment");
    }

    #[tokio::test]
    async fn replace_media_comments_maps_a_missing_media_with_zero_comments_to_media_not_found() {
        let pool = create_test_pool().await;
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .expect("enable foreign keys");

        // media id 999 has no `videos` row and there are no comments to insert, so the foreign-key
        // path never fires - the missing row is caught by the UPDATE matching no row instead. A
        // false success here would report "nothing updated" for a media that no longer exists.
        let error = replace_media_comments_in_pool(&pool, 999, Vec::new())
            .await
            .expect_err("replacing comments on a missing media must fail even with zero comments");

        assert_eq!(error.code, AppErrorCode::MediaNotFound.as_str());
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
