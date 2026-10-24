use std::collections::HashSet;

use sqlx::{QueryBuilder, SqlitePool};

use crate::models::yt_dlp::YtDlpComment;
use crate::{AppError, AppErrorCode, AppResult};

/// Upper bound (in Unicode scalar values) on a stored comment body. yt-dlp comment text is bounded
/// in practice (YouTube caps a comment at ~10k characters), so a value past this is a malformed or
/// adversarial response. The text is truncated rather than the whole batch rejected. A comment
/// backup is bulk, best-effort data, and losing every other comment over one oversized entry would
/// be the worse failure. The database also enforces this ceiling (a `CHECK` on fresh installs, a
/// trigger on ones whose table predates it, see db_schema), so an out-of-band writer cannot store
/// an unbounded value. This app-side truncation keeps the normal write path from ever tripping it.
/// The two must stay in sync, and a db_schema test pins the DDL value against this constant.
pub(crate) const MAX_COMMENT_TEXT_CHARS: usize = 16_000;

/// Upper bound on every other text field of a comment (author, handle, channel id, avatar URL, the
/// relative time, the date, the ids). Real values are a few dozen characters, a URL a couple of
/// hundred. The text has its own ceiling above, and without one here a payload could carry a
/// megabyte in the author's name of each of its hundred thousand comments.
pub(crate) const MAX_COMMENT_FIELD_CHARS: usize = 512;

/// Upper bound on how many comments one media may be handed in a single merge.
///
/// The body of each comment is capped above. This caps the count. The vector comes straight from
/// yt-dlp's output (`fetch_youtube_comments_async`, which asks for at most this many) and is written
/// in one transaction that holds the SQLite write lock until it commits, so a run returning millions
/// of rows would hold every other command (they wait up to the busy timeout and then fail) and grow
/// the database by hundreds of megabytes, with nothing refusing it. Refused rather than truncated,
/// unlike the body. A body cut at a character boundary loses the tail of one comment, while silently
/// dropping comments from a backup is the kind of loss the user only finds when they go looking for
/// one. yt-dlp's comment run is also bounded by its timeout and by `MAX_YT_DLP_JSON_BYTES`, so this
/// only trips on a run that ignored `max_comments`.
///
/// It bounds one payload, not what a media holds. A merge keeps every comment stored before it, so
/// repeated refreshes of a video whose comments keep changing can leave more than this on the row.
pub(crate) const MAX_COMMENTS_PER_MEDIA: usize = 100_000;

/// The states this code *writes* to `videos.comments_state`.
///
/// The column has a third value, `unknown`, and it is deliberately not here. It is the column's
/// DEFAULT, produced by SQLite when a row is inserted, and nothing in this crate ever writes it
/// back. That is a property worth having rather than an omission. The state only moves forward,
/// from "nobody has asked" to an answer, so no write path can quietly undo a recorded outcome and
/// return a media to looking un-fetched.
///
/// **Two answers, not three, and the missing one is deliberate too.** The obvious third is a
/// `disabled` distinct from `none`, so the player could say the author turned comments off. yt-dlp
/// does not report that. Its metadata carries `comment_count: Option<i64>` and no separate flag, so
/// telling a video with comments switched off from one that simply has none would rest on reading
/// an absent field as an intention. That inference is usually right and is not something to store
/// in a column and then show a user as fact. Both are also the same answer to the only question the
/// UI asks, which is whether fetching again could return anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CommentsState {
    /// A fetch ran and stored comments.
    Available,
    /// A fetch ran and there was nothing to store. A final answer. Fetching again cannot help.
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
        .map(|value| truncate_to_chars(value, MAX_COMMENT_FIELD_CHARS))
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
// commented video would otherwise hold the transaction open for into a handful.
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

/// What a comment fetch did, as the renderer needs it. The comments themselves never cross IPC.
/// The backend fetches and stores them in one command (`commands::comments::fetch_media_comments`),
/// so a window closed between the two halves can no longer lose a fetch, and the largest payload
/// the app had (up to 100,000 comments, there and back) is gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaCommentsFetch {
    /// How many comments the fetch returned, before blank and repeated ones were dropped.
    pub fetched: u32,
    /// How many comments the media holds after the merge. More than `fetched` when earlier fetches
    /// stored comments this one no longer found, since a merge removes nothing.
    pub stored: u32,
}

/// Merges a fetch's comments into the media's stored ones and reports both counts.
///
/// An empty fetch goes through the same merge. It stores nothing and records the media as having no
/// comments unless earlier fetches stored some, which keep their `available` state (see
/// `merge_media_comments_in_pool`).
pub async fn store_fetched_comments(
    pool: &SqlitePool,
    media_id: i64,
    comments: Vec<YtDlpComment>,
) -> AppResult<MediaCommentsFetch> {
    let fetched = u32::try_from(comments.len()).unwrap_or(u32::MAX);
    let stored = merge_media_comments(pool, media_id, comments).await?;

    Ok(MediaCommentsFetch {
        fetched,
        stored: u32::try_from(stored).unwrap_or(u32::MAX),
    })
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
            let text = truncate_to_chars(comment.text.trim(), MAX_COMMENT_TEXT_CHARS);

            let author_name = {
                let trimmed = comment.author_name.trim();
                if trimmed.is_empty() {
                    "Unknown author".to_owned()
                } else {
                    truncate_to_chars(trimmed, MAX_COMMENT_FIELD_CHARS)
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
                // like_count/reply_count are u64 from yt-dlp, so saturate to i64::MAX on the
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

/// Merges a fetched set of comments into what is already stored for the media, and returns how many
/// the media holds afterwards.
///
/// Nothing stored is ever removed. A comment that left YouTube since the last fetch is exactly what
/// this app exists to keep, and a later fetch always misses some of them, since authors, channels
/// and YouTube itself delete comments over time. Replacing the stored set with the fetched one
/// would make a refresh of an old video quietly destroy that part of the archive.
///
/// A comment with an id is matched on `(video_id, comment_id)`, the partial unique index v10
/// created, and updated in place, so a refresh still picks up edits and new like counts, with the
/// text it first stored kept in `original_text` (see `COMMENT_UPSERT_CLAUSE`). One
/// without an id has nothing to match on, so it is inserted only when no stored id-less comment has
/// the same parent, author and text. That keeps a refresh from duplicating it without ever dropping
/// one.
pub async fn merge_media_comments(
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

    // Checked before the transaction opens, on the raw count rather than after dedup. The cost
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

    merge_media_comments_in_pool(pool, media_id, comments).await
}

const COMMENT_INSERT_COLUMNS: &str = "INSERT INTO video_comments (\
     video_id, comment_id, parent_comment_id, author_name, author_handle, \
     author_channel_id, author_thumbnail, text, like_count, reply_count, \
     is_author_uploader, is_favorited, is_pinned, is_edited, time_text, published_at) ";

// The conflict target has to repeat the partial index's WHERE for SQLite to use that index as the
// arbiter (db_schema::ddl::COMMENT_UNIQUE_INDEX_DDL). `parent_comment_id` is left as stored, since
// a comment does not move between threads. `published_at` keeps the stored value when there is
// one. yt-dlp derives it from YouTube's relative "2 years ago" text, which only gets coarser as the
// comment ages, so the first fetch is the most precise it will ever be.
//
// The text follows the newest fetch, so an edit is picked up, and the text it replaces goes to
// `original_text` the first time the two differ. Later changes leave `original_text` as it is, so it
// always holds what the comment said when it was first archived, which is the version an author's
// edit or a moderation removes from YouTube. The right-hand sides read the row as it was before the
// update, so both assignments compare against the stored text.
//
// The author fields follow the newest fetch only when it has them. A later fetch can come back
// without an author (a channel since closed, a response that left the field out), and taking that
// would turn a stored name into "Unknown author" and drop the handle the archive had. The
// placeholder name never replaces a real one for the same reason.
const COMMENT_UPSERT_CLAUSE: &str = " ON CONFLICT(video_id, comment_id) \
     WHERE comment_id IS NOT NULL AND TRIM(comment_id) <> '' DO UPDATE SET \
     author_name = CASE WHEN excluded.author_name = 'Unknown author' \
         THEN video_comments.author_name ELSE excluded.author_name END, \
     author_handle = COALESCE(excluded.author_handle, video_comments.author_handle), \
     author_channel_id = COALESCE(excluded.author_channel_id, video_comments.author_channel_id), \
     author_thumbnail = COALESCE(excluded.author_thumbnail, video_comments.author_thumbnail), \
     original_text = COALESCE(video_comments.original_text,          CASE WHEN excluded.text <> video_comments.text THEN video_comments.text END),      text = excluded.text, \
     like_count = excluded.like_count, \
     reply_count = excluded.reply_count, \
     is_author_uploader = excluded.is_author_uploader, \
     is_favorited = excluded.is_favorited, \
     is_pinned = excluded.is_pinned, \
     is_edited = excluded.is_edited, \
     time_text = excluded.time_text, \
     published_at = COALESCE(video_comments.published_at, excluded.published_at)";

async fn upsert_comments_with_id(
    tx: &mut sqlx::SqliteConnection,
    media_id: i64,
    rows: &[&PreparedComment],
) -> Result<(), sqlx::Error> {
    // Multi-row batches rather than one statement per comment (see COMMENT_INSERT_CHUNK_SIZE).
    // The payload is already deduped by id, so no batch can conflict with itself.
    for chunk in rows.chunks(COMMENT_INSERT_CHUNK_SIZE) {
        let mut query_builder = QueryBuilder::new(COMMENT_INSERT_COLUMNS);

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

        query_builder.push(COMMENT_UPSERT_CLAUSE);
        query_builder.build().execute(&mut *tx).await?;
    }

    Ok(())
}

async fn insert_comments_without_id(
    tx: &mut sqlx::SqliteConnection,
    media_id: i64,
    rows: &[&PreparedComment],
) -> Result<(), sqlx::Error> {
    // One statement per comment, which is fine because yt-dlp gives YouTube comments an id and this
    // only runs for the odd one it did not. The NOT EXISTS reads rows this loop inserted too, so two
    // identical id-less comments in one payload store once. Rows written before ids were trimmed
    // can hold an empty string rather than NULL, hence the TRIM.
    for comment in rows {
        sqlx::query(
            r#"
            INSERT INTO video_comments (
                video_id, comment_id, parent_comment_id, author_name, author_handle,
                author_channel_id, author_thumbnail, text, like_count, reply_count,
                is_author_uploader, is_favorited, is_pinned, is_edited, time_text, published_at
            )
            SELECT ?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
            WHERE NOT EXISTS (
                SELECT 1 FROM video_comments
                WHERE video_id = ?1
                  AND (comment_id IS NULL OR TRIM(comment_id) = '')
                  AND parent_comment_id IS ?2
                  AND author_name = ?3
                  AND text = ?7
            )
            "#,
        )
        .bind(media_id)
        .bind(comment.parent_comment_id.as_deref())
        .bind(comment.author_name.as_str())
        .bind(comment.author_handle.as_deref())
        .bind(comment.author_channel_id.as_deref())
        .bind(comment.author_thumbnail.as_deref())
        .bind(comment.text.as_str())
        .bind(comment.like_count)
        .bind(comment.reply_count)
        .bind(comment.is_author_uploader)
        .bind(comment.is_favorited)
        .bind(comment.is_pinned)
        .bind(comment.is_edited)
        .bind(comment.time_text.as_deref())
        .bind(comment.published_at.as_deref())
        .execute(&mut *tx)
        .await?;
    }

    Ok(())
}

async fn merge_media_comments_in_pool(
    pool: &SqlitePool,
    media_id: i64,
    comments: Vec<YtDlpComment>,
) -> AppResult<u64> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| sqlite_error("failed to begin comments transaction", error))?;

    let result = async {
        let rows = prepare_comment_rows(comments);
        let (with_id, without_id): (Vec<&PreparedComment>, Vec<&PreparedComment>) = rows
            .iter()
            .partition(|comment| comment.comment_id.is_some());

        upsert_comments_with_id(&mut tx, media_id, &with_id).await?;
        insert_comments_without_id(&mut tx, media_id, &without_id).await?;

        // Counted from the table rather than from the payload, since the media now holds what was
        // stored before plus what this fetch added. Counted inside the UPDATE rather than by a
        // SELECT ahead of it, so a merge with nothing to insert still opens with a write. A
        // deferred transaction that reads first and writes second fails with SQLITE_BUSY_SNAPSHOT
        // when another connection commits in between, without waiting (see docs/DATABASE.md).
        //
        // Reaching here means a fetch ran and succeeded, so a media with nothing stored has a final
        // answer rather than the absence of an attempt. That is the whole distinction the state
        // column exists for. `has_comments = 0` alone cannot tell the two apart, and the player
        // offered its Fetch button on both. No row back means the media is gone.
        let stored_count: Option<(i64,)> = sqlx::query_as(
            r#"
            UPDATE videos
            SET comments_count = (SELECT COUNT(*) FROM video_comments WHERE video_id = ?1),
                has_comments = EXISTS (SELECT 1 FROM video_comments WHERE video_id = ?1),
                comments_state = CASE
                    WHEN EXISTS (SELECT 1 FROM video_comments WHERE video_id = ?1) THEN ?2
                    ELSE ?3
                END
            WHERE id = ?1
            RETURNING comments_count
            "#,
        )
        .bind(media_id)
        .bind(CommentsState::Available.as_str())
        .bind(CommentsState::None.as_str())
        .fetch_optional(&mut *tx)
        .await?;

        Ok::<Option<u64>, sqlx::Error>(
            stored_count.map(|(count,)| u64::try_from(count).unwrap_or(0)),
        )
    }
    .await;

    match result {
        Ok(None) => {
            // With no comments to insert, the video_comments foreign key that maps a vanished media
            // row to MediaNotFound never fires (the insert loop is skipped), so a media deleted
            // concurrently while its zero-length comment fetch was finishing is detected here
            // instead. The UPDATE matched no row. Roll back and report it, mirroring the non-empty
            // path's foreign-key handling below.
            let _ = tx.rollback().await;
            Err(AppError::from_code(
                AppErrorCode::MediaNotFound,
                "the media no longer exists",
            ))
        }
        Ok(Some(stored_count)) => {
            tx.commit()
                .await
                .map_err(|error| sqlite_error("failed to commit comments transaction", error))?;
            Ok(stored_count)
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

            // The video_comments.video_id foreign key no longer resolves. The media row was
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

    /// The ceiling both sides assert against. The player marks a stored comment as truncated by
    /// its length reaching this number (`isCommentTextTruncated` in
    /// `src/utils/comment-tree.ts`), so the two constants have to move together, and
    /// the fixture is what holds them to it.
    fn shared_comment_text_limit() -> usize {
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/comment-text-limit.json"
        ));
        let fixture: serde_json::Value =
            serde_json::from_str(raw).expect("the shared fixture must be valid JSON");

        fixture["maxCommentTextChars"]
            .as_u64()
            .expect("maxCommentTextChars must be a number") as usize
    }

    #[test]
    fn the_comment_text_ceiling_matches_the_shared_fixture() {
        assert_eq!(MAX_COMMENT_TEXT_CHARS, shared_comment_text_limit());
    }

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
                original_text TEXT,
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

        sqlx::query(crate::services::db_schema::COMMENT_UNIQUE_INDEX_DDL)
            .execute(&pool)
            .await
            .expect("create the comment unique index the upsert arbitrates on");

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
        // On a character boundary, not a byte one. A 4-scalar multi-byte string capped at 2 keeps
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
    fn prepare_comment_rows_caps_every_other_field() {
        let long = "b".repeat(MAX_COMMENT_FIELD_CHARS + 100);
        let mut comment = sample_comment("text");
        comment.author_name = long.clone();
        comment.author_thumbnail = Some(long.clone());
        comment.time_text = Some(long);

        let rows = prepare_comment_rows(vec![comment]);

        assert_eq!(rows[0].author_name.chars().count(), MAX_COMMENT_FIELD_CHARS);
        assert_eq!(
            rows[0]
                .author_thumbnail
                .as_deref()
                .map(|value| value.chars().count()),
            Some(MAX_COMMENT_FIELD_CHARS)
        );
        assert_eq!(
            rows[0]
                .time_text
                .as_deref()
                .map(|value| value.chars().count()),
            Some(MAX_COMMENT_FIELD_CHARS)
        );
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
    async fn merge_media_comments_refuses_a_payload_past_the_count_ceiling() {
        // One over the ceiling is refused before anything is written, and the refusal leaves the
        // stored comments alone.
        let pool = create_test_pool().await;

        merge_media_comments(&pool, 1, vec![sample_comment("kept")])
            .await
            .expect("seed one stored comment");

        let oversized: Vec<YtDlpComment> = (0..=MAX_COMMENTS_PER_MEDIA)
            .map(|index| comment_with_id("flood", Some(&index.to_string())))
            .collect();

        let error = merge_media_comments(&pool, 1, oversized)
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
            "the existing backup must survive a refused merge"
        );
    }

    #[tokio::test]
    async fn merge_media_comments_accepts_a_payload_at_the_count_ceiling() {
        // The boundary itself is allowed, so the ceiling is a refusal of abuse and not a silent
        // cap on a large but legitimate fetch. Distinct ids, or dedup would shrink the count.
        let pool = create_test_pool().await;

        let at_ceiling: Vec<YtDlpComment> = (0..MAX_COMMENTS_PER_MEDIA)
            .map(|index| comment_with_id("ok", Some(&index.to_string())))
            .collect();

        let inserted = merge_media_comments(&pool, 1, at_ceiling)
            .await
            .expect("a payload at the ceiling is accepted");

        assert_eq!(inserted as usize, MAX_COMMENTS_PER_MEDIA);
    }

    #[tokio::test]
    async fn merge_media_comments_inserts_non_blank_comments_and_updates_flags() {
        let pool = create_test_pool().await;

        let inserted = merge_media_comments_in_pool(
            &pool,
            1,
            vec![sample_comment("Great video!"), sample_comment("   ")],
        )
        .await
        .expect("merge comments");

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
    async fn a_refetch_without_an_author_keeps_the_stored_one() {
        // A later fetch can come back with no author for a comment the archive already names.
        // Taking it turned the stored name into "Unknown author" and dropped the handle.
        let pool = create_test_pool().await;
        merge_media_comments_in_pool(&pool, 1, vec![sample_comment("Great video!")])
            .await
            .expect("first fetch");

        let anonymous = YtDlpComment {
            author_name: "   ".to_string(),
            author_handle: None,
            like_count: 9,
            ..sample_comment("Great video!")
        };
        merge_media_comments_in_pool(&pool, 1, vec![anonymous])
            .await
            .expect("second fetch");

        let (author_name, author_handle, like_count): (String, Option<String>, i64) =
            sqlx::query_as(
                "SELECT author_name, author_handle, like_count FROM video_comments WHERE video_id = 1",
            )
            .fetch_one(&pool)
            .await
            .expect("read comment");

        assert_eq!(author_name, "Alice");
        assert_eq!(author_handle.as_deref(), Some("@alice"));
        assert_eq!(like_count, 9, "what the fetch does carry still updates");
    }

    async fn stored_texts(pool: &SqlitePool) -> (String, Option<String>) {
        sqlx::query_as("SELECT text, original_text FROM video_comments WHERE video_id = 1")
            .fetch_one(pool)
            .await
            .expect("read comment")
    }

    #[tokio::test]
    async fn an_edited_comment_keeps_the_text_it_was_first_archived_with() {
        // The archive is for what leaves YouTube, and an edit that removes or censors a comment is
        // one way it leaves. The refresh shows the new text and keeps the first.
        let pool = create_test_pool().await;
        merge_media_comments_in_pool(&pool, 1, vec![sample_comment("The first version")])
            .await
            .expect("first fetch");

        merge_media_comments_in_pool(&pool, 1, vec![sample_comment("[removed]")])
            .await
            .expect("second fetch");

        assert_eq!(
            stored_texts(&pool).await,
            (
                "[removed]".to_string(),
                Some("The first version".to_string())
            )
        );

        // A third version moves the text again and leaves the first one where it is.
        merge_media_comments_in_pool(&pool, 1, vec![sample_comment("A third version")])
            .await
            .expect("third fetch");

        assert_eq!(
            stored_texts(&pool).await,
            (
                "A third version".to_string(),
                Some("The first version".to_string())
            )
        );
    }

    #[tokio::test]
    async fn a_refresh_with_the_same_text_records_no_original() {
        let pool = create_test_pool().await;

        for _ in 0..2 {
            merge_media_comments_in_pool(&pool, 1, vec![sample_comment("Unchanged")])
                .await
                .expect("fetch");
        }

        assert_eq!(stored_texts(&pool).await, ("Unchanged".to_string(), None));
    }

    #[tokio::test]
    async fn a_refetch_with_a_new_author_name_takes_it() {
        let pool = create_test_pool().await;
        merge_media_comments_in_pool(&pool, 1, vec![sample_comment("Great video!")])
            .await
            .expect("first fetch");

        let renamed = YtDlpComment {
            author_name: "Alice Renamed".to_string(),
            ..sample_comment("Great video!")
        };
        merge_media_comments_in_pool(&pool, 1, vec![renamed])
            .await
            .expect("second fetch");

        let (author_name,): (String,) =
            sqlx::query_as("SELECT author_name FROM video_comments WHERE video_id = 1")
                .fetch_one(&pool)
                .await
                .expect("read comment");

        assert_eq!(author_name, "Alice Renamed");
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

        merge_media_comments_in_pool(&pool, 1, vec![sample_comment("Great video!")])
            .await
            .expect("merge comments");

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

        // Spelled as a literal because `CommentsState` deliberately does not name it. `unknown`
        // is the column's DEFAULT and nothing in this crate writes it, which is what keeps the
        // state from ever moving backwards.
        assert_eq!(
            stored_state(&pool, 1).await,
            "unknown",
            "a row starts out never having been asked"
        );

        merge_media_comments_in_pool(&pool, 1, vec![])
            .await
            .expect("merge comments");

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
    async fn storing_a_fetch_reports_what_it_returned_and_what_the_media_holds() {
        let pool = create_test_pool().await;

        merge_media_comments(
            &pool,
            1,
            vec![comment_with_id("from an earlier fetch", Some("old"))],
        )
        .await
        .expect("earlier fetch");

        // Two returned, one of them blank. The media ends up with the earlier comment and the one
        // real comment of this fetch.
        let outcome = store_fetched_comments(
            &pool,
            1,
            vec![
                comment_with_id("new", Some("new")),
                comment_with_id("   ", Some("blank")),
            ],
        )
        .await
        .expect("store the fetch");

        assert_eq!(
            outcome,
            MediaCommentsFetch {
                fetched: 2,
                stored: 2
            }
        );
    }

    #[tokio::test]
    async fn storing_an_empty_fetch_never_downgrades_a_media_that_has_comments() {
        // A video whose comments were removed from YouTube still has the copy this app saved, and an
        // empty fetch of it must not report the backup as absent.
        let pool = create_test_pool().await;

        merge_media_comments(&pool, 1, vec![sample_comment("Kept forever")])
            .await
            .expect("merge comments");

        let outcome = store_fetched_comments(&pool, 1, Vec::new())
            .await
            .expect("store the empty fetch");

        assert_eq!(
            outcome,
            MediaCommentsFetch {
                fetched: 0,
                stored: 1
            }
        );
        assert_eq!(
            stored_state(&pool, 1).await,
            CommentsState::Available.as_str()
        );
    }

    #[tokio::test]
    async fn storing_a_fetch_refuses_an_invalid_media_id() {
        let pool = create_test_pool().await;

        let error = store_fetched_comments(&pool, 0, Vec::new())
            .await
            .unwrap_err();

        assert_eq!(error.code, AppErrorCode::InvalidInput.as_str());
    }

    #[tokio::test]
    async fn merge_media_comments_drops_repeated_comment_id_but_keeps_null_id_rows() {
        let pool = create_test_pool().await;

        let inserted = merge_media_comments_in_pool(
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
        .expect("merge comments");

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
    async fn merge_media_comments_maps_foreign_key_violation_to_media_not_found() {
        let pool = create_test_pool().await;
        // The real pool opens with foreign_keys ON (services::database). The in-memory test pool
        // must enable it explicitly to exercise the mapping. max_connections(1) keeps this PRAGMA
        // on the same connection the transaction below reuses.
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .expect("enable foreign keys");

        // media id 999 has no `videos` row, so the comment insert violates the video_id FK.
        let error = merge_media_comments_in_pool(&pool, 999, vec![sample_comment("orphan")])
            .await
            .expect_err("insert against a missing media must fail");

        assert_eq!(error.code, AppErrorCode::MediaNotFound.as_str());
    }

    #[tokio::test]
    async fn merge_media_comments_keeps_the_real_comment_behind_a_blank_duplicate_id() {
        let pool = create_test_pool().await;

        // Two entries share comment_id "c1". The first is blank, the second has real content. The
        // blank one must not win the dedup and then be dropped, silently losing the real comment.
        let inserted = merge_media_comments_in_pool(
            &pool,
            1,
            vec![
                comment_with_id("   ", Some("c1")),
                comment_with_id("the real comment", Some("c1")),
            ],
        )
        .await
        .expect("merge comments");

        let (kept_text,): (String,) =
            sqlx::query_as("SELECT text FROM video_comments WHERE comment_id = 'c1'")
                .fetch_one(&pool)
                .await
                .expect("read kept comment");

        assert_eq!(inserted, 1);
        assert_eq!(kept_text, "the real comment");
    }

    #[tokio::test]
    async fn merge_media_comments_maps_a_missing_media_with_zero_comments_to_media_not_found() {
        let pool = create_test_pool().await;
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .expect("enable foreign keys");

        // media id 999 has no `videos` row and there are no comments to insert, so the foreign-key
        // path never fires. The missing row is caught by the UPDATE matching no row instead. A
        // false success here would report "nothing updated" for a media that no longer exists.
        let error = merge_media_comments_in_pool(&pool, 999, Vec::new())
            .await
            .expect_err("replacing comments on a missing media must fail even with zero comments");

        assert_eq!(error.code, AppErrorCode::MediaNotFound.as_str());
    }

    #[tokio::test]
    async fn merge_media_comments_rolls_back_when_insert_fails() {
        let pool = create_test_pool().await;

        merge_media_comments_in_pool(&pool, 1, vec![sample_comment("Original")])
            .await
            .expect("seed comments");

        let result = merge_media_comments_in_pool(&pool, 1, vec![sample_comment("Invalid")]).await;

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

    /// Every stored `(comment_id, text)` for media 1, ordered so assertions read the same way.
    async fn stored_comments(pool: &SqlitePool) -> Vec<(Option<String>, String)> {
        sqlx::query_as(
            "SELECT comment_id, text FROM video_comments WHERE video_id = 1 \
             ORDER BY comment_id IS NULL, comment_id, text",
        )
        .fetch_all(pool)
        .await
        .expect("read stored comments")
    }

    #[tokio::test]
    async fn a_refresh_keeps_the_comments_it_no_longer_finds() {
        // The case this module exists for. Comments disappear from YouTube over time, so a later
        // fetch of an old video returns fewer than the backup holds, and those missing ones are
        // exactly what nothing else has a copy of anymore.
        let pool = create_test_pool().await;

        merge_media_comments(
            &pool,
            1,
            vec![
                comment_with_id("first", Some("c1")),
                comment_with_id("second", Some("c2")),
                comment_with_id("third", Some("c3")),
            ],
        )
        .await
        .expect("first fetch");

        let stored = merge_media_comments(
            &pool,
            1,
            vec![
                comment_with_id("second, edited", Some("c2")),
                comment_with_id("fourth", Some("c4")),
            ],
        )
        .await
        .expect("later fetch");

        assert_eq!(
            stored, 4,
            "what the media holds, not what the fetch returned"
        );
        assert_eq!(
            stored_comments(&pool).await,
            vec![
                (Some("c1".to_string()), "first".to_string()),
                (Some("c2".to_string()), "second, edited".to_string()),
                (Some("c3".to_string()), "third".to_string()),
                (Some("c4".to_string()), "fourth".to_string()),
            ]
        );

        let (comments_count,): (i64,) =
            sqlx::query_as("SELECT comments_count FROM videos WHERE id = 1")
                .fetch_one(&pool)
                .await
                .expect("read count");
        assert_eq!(comments_count, 4);
    }

    #[tokio::test]
    async fn a_refresh_updates_what_changed_on_a_comment_it_finds_again() {
        let pool = create_test_pool().await;

        merge_media_comments(&pool, 1, vec![comment_with_id("before", Some("c1"))])
            .await
            .expect("first fetch");

        let mut edited = comment_with_id("after", Some("c1"));
        edited.like_count = 900;
        edited.is_edited = true;
        edited.is_pinned = false;

        merge_media_comments(&pool, 1, vec![edited])
            .await
            .expect("later fetch");

        let (text, like_count, is_edited, is_pinned): (String, i64, i64, i64) = sqlx::query_as(
            "SELECT text, like_count, is_edited, is_pinned FROM video_comments WHERE comment_id = 'c1'",
        )
        .fetch_one(&pool)
        .await
        .expect("read comment");

        assert_eq!(
            (text.as_str(), like_count, is_edited, is_pinned),
            ("after", 900, 1, 0)
        );
    }

    #[tokio::test]
    async fn a_refresh_keeps_the_first_publication_date_it_stored() {
        // yt-dlp derives the date from YouTube's relative text, which only gets coarser with age, so
        // the earliest fetch carries the most precise value. A missing one is still filled in.
        let pool = create_test_pool().await;

        let mut dated = comment_with_id("dated", Some("c1"));
        dated.published_at = Some("2026-01-01".to_string());
        let mut undated = comment_with_id("undated", Some("c2"));
        undated.published_at = None;

        merge_media_comments(&pool, 1, vec![dated, undated])
            .await
            .expect("first fetch");

        let mut coarser = comment_with_id("dated", Some("c1"));
        coarser.published_at = Some("2025-10-08".to_string());
        let mut now_dated = comment_with_id("undated", Some("c2"));
        now_dated.published_at = Some("2026-02-02".to_string());

        merge_media_comments(&pool, 1, vec![coarser, now_dated])
            .await
            .expect("later fetch");

        let dates: Vec<(String, Option<String>)> = sqlx::query_as(
            "SELECT comment_id, published_at FROM video_comments WHERE video_id = 1 ORDER BY comment_id",
        )
        .fetch_all(&pool)
        .await
        .expect("read dates");

        assert_eq!(
            dates,
            vec![
                ("c1".to_string(), Some("2026-01-01".to_string())),
                ("c2".to_string(), Some("2026-02-02".to_string())),
            ]
        );
    }

    #[tokio::test]
    async fn a_comment_without_an_id_is_neither_duplicated_nor_dropped_by_a_refresh() {
        let pool = create_test_pool().await;

        merge_media_comments(
            &pool,
            1,
            vec![
                comment_with_id("no id, first fetch only", None),
                comment_with_id("no id, both fetches", None),
            ],
        )
        .await
        .expect("first fetch");

        let stored = merge_media_comments(
            &pool,
            1,
            vec![
                comment_with_id("no id, both fetches", None),
                comment_with_id("no id, second fetch only", None),
            ],
        )
        .await
        .expect("later fetch");

        assert_eq!(stored, 3);
        assert_eq!(
            stored_comments(&pool).await,
            vec![
                (None, "no id, both fetches".to_string()),
                (None, "no id, first fetch only".to_string()),
                (None, "no id, second fetch only".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn an_empty_merge_leaves_stored_comments_and_their_state_alone() {
        // An empty fetch is stored through the same merge, so a merge handed nothing must leave the
        // stored comments and their state as they were.
        let pool = create_test_pool().await;

        merge_media_comments(&pool, 1, vec![sample_comment("kept")])
            .await
            .expect("first fetch");

        let stored = merge_media_comments(&pool, 1, Vec::new())
            .await
            .expect("empty fetch");

        assert_eq!(stored, 1);
        assert_eq!(
            stored_state(&pool, 1).await,
            CommentsState::Available.as_str()
        );
    }
}
