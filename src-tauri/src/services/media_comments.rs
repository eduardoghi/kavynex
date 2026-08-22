use std::collections::HashSet;

use sqlx::{QueryBuilder, SqlitePool};

use crate::models::yt_dlp::YtDlpComment;
use crate::{AppError, AppErrorCode, AppResult};

/// Upper bound (in Unicode scalar values) on a stored comment body. yt-dlp comment text is bounded
/// in practice (YouTube caps a comment at ~10k characters), so a value past this is a malformed or
/// adversarial response. The text is truncated rather than the whole batch rejected: a comment
/// backup is bulk, best-effort data, and losing every other comment over one oversized entry would
/// be the worse failure. The database also enforces this ceiling now (a `CHECK` on fresh installs, a
/// trigger on ones whose table predates it (see db_schema), so an out-of-band writer cannot store
/// an unbounded value; this app-side truncation keeps the normal write path from ever tripping it.
/// The two must stay in sync), a db_schema test pins the DDL value against this constant.
pub(crate) const MAX_COMMENT_TEXT_CHARS: usize = 16_000;

/// Upper bound on how many comments one media may be handed in a single replace.
///
/// The body of each comment is capped above; this caps the count, which was the one input from the
/// renderer left without a ceiling. The vector arrives over IPC and is written in one transaction
/// that holds the SQLite write lock until it commits, so a renderer sending millions of rows would
/// hold every other command (they wait up to the busy timeout and then fail) and grow the database
/// by hundreds of megabytes, with nothing refusing it. Refused rather than truncated, unlike the
/// body: a body cut at a character boundary loses the tail of one comment, while silently dropping
/// comments from a backup is the kind of loss the user only finds when they go looking for one.
/// The limit sits far above what a real fetch delivers (yt-dlp's comment run is itself bounded by
/// its timeout and by `MAX_YT_DLP_JSON_BYTES`), so it only ever trips on a caller that is not the
/// app's own flow.
pub(crate) const MAX_COMMENTS_PER_MEDIA: usize = 100_000;

/// The states this code *writes* to `videos.comments_state`.
///
/// The column has a third value, `unknown`, and it is deliberately not here: it is the column's
/// DEFAULT, produced by SQLite when a row is inserted, and nothing in this crate ever writes it
/// back. That is a property worth having rather than an omission. The state only moves forward,
/// from "nobody has asked" to an answer, so no write path can quietly undo a recorded outcome and
/// return a media to looking un-fetched.
///
/// **Two answers, not three, and the missing one is deliberate too.** The obvious third is a
/// `disabled` distinct from `none`, so the player could say the author turned comments off. yt-dlp
/// does not report that: its metadata carries `comment_count: Option<i64>` and no separate flag, so
/// telling a video with comments switched off from one that simply has none would rest on reading
/// an absent field as an intention. That inference is usually right and is not something to store
/// in a column and then show a user as fact. Both are also the same answer to the only question the
/// UI asks, which is whether fetching again could return anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CommentsState {
    /// A fetch ran and stored comments.
    Available,
    /// A fetch ran and there was nothing to store. A final answer: fetching again cannot help.
    ///
    /// Reached only after a *successful* fetch. A fetch that failed, or one the metadata says was
    /// incomplete (`comments_extraction_looks_incomplete`), errors before any of this, so a
    /// rate-limited attempt is never recorded as an empty video.
    None,
}

impl CommentsState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::None => "none",
        }
    }
}

/// Returns `value` unchanged when it is within `max_chars`, otherwise its first `max_chars` scalar
/// values. Truncation is on a character boundary (never mid-scalar), so the result is always valid
/// UTF-8.
fn truncate_to_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_owned();
    }

    value.chars().take(max_chars).collect()
}

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
// columns, so 50 rows is 800 bound parameters (comfortably under SQLite's default variable
// limit (999 on older builds)), while collapsing the thousands of round-trips a heavily
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
/// Records that a comment fetch found nothing, without touching the comments already stored.
///
/// The manual refresh needs this and `replace_media_comments` cannot serve it: that one deletes the
/// existing rows before inserting, so calling it with an empty payload would wipe a backup because
/// a later fetch came back empty, which is the opposite of what this app is for. The refresh
/// therefore returns early on an empty result and leaves the stored comments alone. What it could
/// not do before was record that it had *asked*, so the media stayed `unknown` and the user could
/// re-run a fetch that could never return anything.
///
/// The `comments_count = 0` guard is what makes it safe to call blind: a media that does have
/// stored comments keeps its `available` state, so an empty refresh of a video whose comments were
/// removed from YouTube never downgrades the backup this app exists to keep.
pub async fn mark_media_comments_absent(pool: &SqlitePool, media_id: i64) -> AppResult<()> {
    if media_id <= 0 {
        return Err(AppError::from_code(
            AppErrorCode::InvalidInput,
            "media id must be a positive number",
        ));
    }

    sqlx::query("UPDATE videos SET comments_state = ? WHERE id = ? AND comments_count = 0")
        .bind(CommentsState::None.as_str())
        .bind(media_id)
        .execute(pool)
        .await
        .map_err(|error| sqlite_error("failed to record that no comments were found", error))?;

    Ok(())
}

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
            let text = truncate_to_chars(comment.text.trim(), MAX_COMMENT_TEXT_CHARS);

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

    // Checked before the transaction opens, on the raw count rather than after dedup: the cost
    // being bounded is what the caller handed over, and a vector this large has already been
    // materialized by the time it gets here.
    if comments.len() > MAX_COMMENTS_PER_MEDIA {
        return Err(AppError::from_code(
            AppErrorCode::InvalidInput,
            format!(
                "too many comments for one media ({} given, at most {MAX_COMMENTS_PER_MEDIA})",
                comments.len()
            ),
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
                comments_count = ?,
                comments_state = ?
            WHERE id = ?
            "#,
        )
        .bind(if inserted_count > 0 { 1_i64 } else { 0_i64 })
        .bind(i64::try_from(inserted_count).unwrap_or(i64::MAX))
        // Reaching here means a fetch ran and succeeded, so zero stored comments is a final answer
        // rather than the absence of an attempt. That is the whole distinction the column exists
        // for: `has_comments = 0` alone cannot tell the two apart, and the player offered its Fetch
        // button on both.
        .bind(
            if inserted_count > 0 {
                CommentsState::Available
            } else {
                CommentsState::None
            }
            .as_str(),
        )
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
                comments_count INTEGER NOT NULL DEFAULT 0,
                -- The CHECK is mirrored from the real DDL rather than left off: these tests are
                -- what pin which state each write records, and a column that accepted any string
                -- would let a typo pass here and fail against the real schema.
                comments_state TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (comments_state IN ('unknown', 'none', 'available'))
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
    fn truncate_to_chars_caps_only_over_length_values() {
        assert_eq!(truncate_to_chars("short", 16_000), "short");
        assert_eq!(truncate_to_chars("abcdef", 3), "abc");
        // On a character boundary, not a byte one: a 4-scalar multi-byte string capped at 2 keeps
        // two whole characters rather than slicing one in half.
        assert_eq!(
            truncate_to_chars("\u{e9}\u{e9}\u{e9}\u{e9}", 2),
            "\u{e9}\u{e9}"
        );
    }

    #[test]
    fn prepare_comment_rows_truncates_over_length_text() {
        // A comment far longer than the ceiling is kept (not dropped) but capped, so one oversized
        // entry cannot bloat a row while the rest of the batch still imports.
        let long = "a".repeat(MAX_COMMENT_TEXT_CHARS + 500);
        let rows = prepare_comment_rows(vec![sample_comment(&long)]);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].text.chars().count(), MAX_COMMENT_TEXT_CHARS);
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
    async fn replace_media_comments_refuses_a_payload_past_the_count_ceiling() {
        // One over the ceiling is refused before anything is written, and the refusal leaves the
        // stored comments alone: this is a replace, so an accepted oversized payload would first
        // delete the backup it then failed to rewrite.
        let pool = create_test_pool().await;

        replace_media_comments(&pool, 1, vec![sample_comment("kept")])
            .await
            .expect("seed one stored comment");

        let oversized: Vec<YtDlpComment> = (0..=MAX_COMMENTS_PER_MEDIA)
            .map(|index| comment_with_id("flood", Some(&index.to_string())))
            .collect();

        let error = replace_media_comments(&pool, 1, oversized)
            .await
            .expect_err("a payload past the ceiling must be refused");

        assert_eq!(error.code, AppErrorCode::InvalidInput.as_str());
        assert!(
            error.message.contains("too many comments"),
            "the refusal should name the reason: {}",
            error.message
        );

        let (stored,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM video_comments WHERE video_id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            stored, 1,
            "the existing backup must survive a refused replace"
        );
    }

    #[tokio::test]
    async fn replace_media_comments_accepts_a_payload_at_the_count_ceiling() {
        // The boundary itself is allowed, so the ceiling is a refusal of abuse and not a silent
        // cap on a large but legitimate fetch. Distinct ids, or dedup would shrink the count.
        let pool = create_test_pool().await;

        let at_ceiling: Vec<YtDlpComment> = (0..MAX_COMMENTS_PER_MEDIA)
            .map(|index| comment_with_id("ok", Some(&index.to_string())))
            .collect();

        let inserted = replace_media_comments(&pool, 1, at_ceiling)
            .await
            .expect("a payload at the ceiling is accepted");

        assert_eq!(inserted as usize, MAX_COMMENTS_PER_MEDIA);
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

    /// The state stored on a media row, so each test below reads it the same way.
    async fn stored_state(pool: &SqlitePool, media_id: i64) -> String {
        let (state,): (String,) = sqlx::query_as("SELECT comments_state FROM videos WHERE id = ?")
            .bind(media_id)
            .fetch_one(pool)
            .await
            .expect("read comments state");

        state
    }

    #[tokio::test]
    async fn storing_comments_records_that_a_fetch_found_some() {
        let pool = create_test_pool().await;

        replace_media_comments_in_pool(&pool, 1, vec![sample_comment("Great video!")])
            .await
            .expect("replace comments");

        assert_eq!(
            stored_state(&pool, 1).await,
            CommentsState::Available.as_str()
        );
    }

    #[tokio::test]
    async fn storing_no_comments_records_a_final_answer_rather_than_an_absent_attempt() {
        // The distinction the column was added for. `has_comments` and `comments_count` are both 0
        // here and were also 0 before any fetch ran, so neither can say that this media has been
        // asked about and has nothing to give. Without that, the player kept offering a Fetch
        // button for an operation that could never return anything.
        let pool = create_test_pool().await;

        // Spelled as a literal because `CommentsState` deliberately does not name it: `unknown`
        // is the column's DEFAULT and nothing in this crate writes it, which is what keeps the
        // state from ever moving backwards.
        assert_eq!(
            stored_state(&pool, 1).await,
            "unknown",
            "a row starts out never having been asked"
        );

        replace_media_comments_in_pool(&pool, 1, vec![])
            .await
            .expect("replace comments");

        assert_eq!(stored_state(&pool, 1).await, CommentsState::None.as_str());

        let (has_comments, comments_count): (i64, i64) =
            sqlx::query_as("SELECT has_comments, comments_count FROM videos WHERE id = 1")
                .fetch_one(&pool)
                .await
                .expect("read video flags");
        assert_eq!(
            (has_comments, comments_count),
            (0, 0),
            "the two older columns cannot tell this apart, which is why the state exists"
        );
    }

    #[tokio::test]
    async fn marking_comments_absent_records_the_outcome_without_deleting_anything() {
        // What the manual refresh needs: it returns early on an empty result so a later fetch coming
        // back empty can never wipe a saved backup, and this is how it records that it asked.
        let pool = create_test_pool().await;

        mark_media_comments_absent(&pool, 1)
            .await
            .expect("mark absent");

        assert_eq!(stored_state(&pool, 1).await, CommentsState::None.as_str());
    }

    #[tokio::test]
    async fn marking_comments_absent_never_downgrades_a_media_that_has_some() {
        // The guard that makes the call safe to make blind. A video whose comments were removed from
        // YouTube still has the copy this app saved, and an empty refresh of it must not report the
        // backup as absent. That would be the app contradicting its own stored data.
        let pool = create_test_pool().await;

        replace_media_comments_in_pool(&pool, 1, vec![sample_comment("Kept forever")])
            .await
            .expect("replace comments");

        mark_media_comments_absent(&pool, 1)
            .await
            .expect("mark absent");

        assert_eq!(
            stored_state(&pool, 1).await,
            CommentsState::Available.as_str(),
            "a media with stored comments keeps its state"
        );

        let (total,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM video_comments WHERE video_id = 1")
                .fetch_one(&pool)
                .await
                .expect("count comments");
        assert_eq!(total, 1, "and keeps the comments themselves");
    }

    #[tokio::test]
    async fn marking_comments_absent_refuses_an_invalid_media_id() {
        let pool = create_test_pool().await;

        let error = mark_media_comments_absent(&pool, 0).await.unwrap_err();

        assert_eq!(error.code, AppErrorCode::InvalidInput.as_str());
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
        // path never fires. The missing row is caught by the UPDATE matching no row instead. A
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
