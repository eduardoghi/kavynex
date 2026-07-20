use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Sqlite, SqlitePool};
use ts_rs::TS;

use crate::services::database::{db_error, is_foreign_key_violation, is_unique_violation};
use crate::utils::text::{escape_like_pattern, normalize_search_text};
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

/// One page of a channel's media plus the total number of rows matching the same filters (not
/// just the returned page), so the frontend can show "X of Y" and know when to stop paging.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct MediaPage {
    pub items: Vec<MediaRow>,
    #[ts(type = "number")]
    pub total: i64,
}

/// The filter/sort/pagination request for [`list_media_page`], sent by the frontend. The string
/// fields carry the same literal unions the frontend already models in
/// `src/utils/media-library-filters.ts`; `search` is the raw term (normalized in Rust so it
/// matches `title_normalized`), and `limit`/`offset` drive the page window.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct MediaPageQuery {
    #[ts(type = "\"all\" | \"video\" | \"audio\"")]
    pub media_type: String,
    #[ts(type = "\"all\" | \"watched\" | \"unwatched\"")]
    pub watched: String,
    #[ts(type = "\"all\" | \"with\" | \"without\"")]
    pub publication: String,
    pub search: String,
    #[ts(type = "\"publication_date\" | \"added_date\" | \"title\" | \"duration\" | \"comments\"")]
    pub sort_category: String,
    #[ts(type = "\"asc\" | \"desc\"")]
    pub sort_direction: String,
    #[ts(type = "number")]
    pub limit: i64,
    #[ts(type = "number")]
    pub offset: i64,
}

/// Upper bound on a single page so a caller (or a bug) cannot request an unbounded result set
/// and defeat the point of paginating.
const MAX_MEDIA_PAGE_LIMIT: i64 = 500;

/// Upper bound on the search term length. The only caller is the app's own frontend, but the
/// backend is the trust boundary (the same reason the import mode and download inputs are validated
/// server-side), so the term that becomes a LIKE pattern is bounded here too: an unbounded term
/// would let a compromised frontend drive a pathologically long scan. Generous - real titles, which
/// this searches, are far shorter.
const MAX_SEARCH_TERM_CHARS: usize = 200;

/// Upper bound on how many comments a single media loads at once. Comments are threaded on the
/// client, which needs them all in one shot, so this is not a page size but a defensive ceiling: a
/// video with a pathologically large comment backup would otherwise pull every row into memory,
/// across IPC, and through client-side validation and tree-building on the main thread. The earliest
/// rows are kept (ORDER BY id ASC); the frontend compares the loaded count against the stored
/// `comments_count` and tells the user when some were not loaded. Set high enough that no realistic
/// backup is ever truncated.
const MAX_MEDIA_COMMENTS_LOADED: i64 = 50_000;

const MEDIA_COLUMNS: &str = "id, channel_id, title, file_path, thumbnail_path, media_type, \
    youtube_video_id, watched_at, published_at, duration_seconds, progress_seconds, has_comments, \
    comments_count, is_live, has_live_chat, live_chat_file_path, created_at";

fn ensure_allowed(value: &str, allowed: &[&str], field: &str) -> AppResult<()> {
    if allowed.contains(&value) {
        return Ok(());
    }

    Err(AppError::invalid_input(format!(
        "invalid {field}: '{value}'"
    )))
}

/// Maps a validated (sort category, direction) pair to a fixed `ORDER BY` clause. The clause is
/// always a compile-time constant chosen by `match`, so no caller-supplied text is ever
/// interpolated into the SQL. The clauses mirror the frontend's original `filterAndSortMedia`
/// ordering as closely as SQL allows: `title_normalized` gives accent/case-insensitive title
/// ordering, published-date sorts always keep dated media before undated (with the undated group
/// ordered by title), and every category tie-breaks by title then `id` for a deterministic page.
fn resolve_order_by(sort_category: &str, sort_direction: &str) -> AppResult<&'static str> {
    let ascending = match sort_direction {
        "asc" => true,
        "desc" => false,
        other => {
            return Err(AppError::invalid_input(format!(
                "invalid sort direction: '{other}'"
            )))
        }
    };

    let clause = match (sort_category, ascending) {
        ("title", true) => "ORDER BY title_normalized ASC, id DESC",
        ("title", false) => "ORDER BY title_normalized DESC, id DESC",
        ("added_date", true) => "ORDER BY created_at ASC, title_normalized ASC, id DESC",
        ("added_date", false) => "ORDER BY created_at DESC, title_normalized DESC, id DESC",
        ("duration", true) => {
            "ORDER BY COALESCE(duration_seconds, 0) ASC, title_normalized ASC, id DESC"
        }
        ("duration", false) => {
            "ORDER BY COALESCE(duration_seconds, 0) DESC, title_normalized DESC, id DESC"
        }
        ("comments", true) => "ORDER BY comments_count ASC, title_normalized ASC, id DESC",
        ("comments", false) => "ORDER BY comments_count DESC, title_normalized DESC, id DESC",
        // Dated media first (group key 0 vs 1), then the date in the requested direction, then a
        // direction-independent title tie-break - matching filterAndSortMedia, where undated
        // media always sort last and ties always fall back to an ascending title compare.
        ("publication_date", true) => {
            "ORDER BY (CASE WHEN published_at IS NOT NULL AND TRIM(published_at) <> '' THEN 0 ELSE 1 END) ASC, \
             (CASE WHEN published_at IS NOT NULL AND TRIM(published_at) <> '' THEN published_at END) ASC, \
             title_normalized ASC, id DESC"
        }
        ("publication_date", false) => {
            "ORDER BY (CASE WHEN published_at IS NOT NULL AND TRIM(published_at) <> '' THEN 0 ELSE 1 END) ASC, \
             (CASE WHEN published_at IS NOT NULL AND TRIM(published_at) <> '' THEN published_at END) DESC, \
             title_normalized ASC, id DESC"
        }
        (other, _) => {
            return Err(AppError::invalid_input(format!(
                "invalid sort category: '{other}'"
            )))
        }
    };

    Ok(clause)
}

/// Pushes the shared `WHERE` conditions (channel + the active filters) onto a query builder.
/// Only constant SQL fragments are pushed as text; every caller-supplied value is bound, so this
/// never interpolates user input. Used for both the count and the page query so they filter
/// identically.
fn push_media_filters(
    builder: &mut QueryBuilder<Sqlite>,
    channel_id: i64,
    query: &MediaPageQuery,
    search_pattern: Option<&str>,
) {
    builder.push(" WHERE channel_id = ").push_bind(channel_id);

    if matches!(query.media_type.as_str(), "video" | "audio") {
        builder
            .push(" AND media_type = ")
            .push_bind(query.media_type.clone());
    }

    match query.watched.as_str() {
        "watched" => {
            builder.push(" AND watched_at IS NOT NULL AND TRIM(watched_at) <> ''");
        }
        "unwatched" => {
            builder.push(" AND (watched_at IS NULL OR TRIM(watched_at) = '')");
        }
        _ => {}
    }

    match query.publication.as_str() {
        "with" => {
            builder.push(" AND published_at IS NOT NULL AND TRIM(published_at) <> ''");
        }
        "without" => {
            builder.push(" AND (published_at IS NULL OR TRIM(published_at) = '')");
        }
        _ => {}
    }

    if let Some(pattern) = search_pattern {
        builder
            .push(" AND title_normalized LIKE ")
            .push_bind(pattern.to_string())
            .push(" ESCAPE '\\'");
    }
}

/// Returns one filtered, sorted page of a channel's media plus the total match count.
///
/// Filtering, sorting and windowing all happen in SQLite so the whole channel is never loaded
/// over IPC just to be filtered in the webview. Search is accent/case-insensitive via the
/// `title_normalized` column (both the stored value and the term here go through
/// `normalize_search_text`). The `limit` is clamped to [`MAX_MEDIA_PAGE_LIMIT`] and the offset
/// floored at 0.
pub async fn list_media_page(
    pool: &SqlitePool,
    channel_id: i64,
    query: &MediaPageQuery,
) -> AppResult<MediaPage> {
    ensure_allowed(&query.media_type, &["all", "video", "audio"], "media type")?;
    ensure_allowed(&query.watched, &["all", "watched", "unwatched"], "watched")?;
    ensure_allowed(
        &query.publication,
        &["all", "with", "without"],
        "publication",
    )?;
    let order_by = resolve_order_by(&query.sort_category, &query.sort_direction)?;

    let limit = query.limit.clamp(1, MAX_MEDIA_PAGE_LIMIT);
    let offset = query.offset.max(0);

    // Bound the term length before it becomes a LIKE pattern (defense in depth at the trust
    // boundary; the frontend already sends short terms). See MAX_SEARCH_TERM_CHARS.
    let bounded_search: String = query.search.chars().take(MAX_SEARCH_TERM_CHARS).collect();
    let normalized_search = normalize_search_text(&bounded_search);
    let search_pattern = (!normalized_search.is_empty())
        .then(|| format!("%{}%", escape_like_pattern(&normalized_search)));

    // The count and the page run inside one transaction so they answer from the same snapshot.
    // Taken from the pool separately they can straddle a concurrent insert or delete (a download
    // finishing, a delete committing), and the grid then renders a page drawn from one version of
    // the table while reporting a total from another - an off-by-one "x of y", or a page whose
    // offset no longer means what the total says it does. Deferred and read-only: it never asks for
    // the write lock, so it cannot hit the SQLITE_BUSY_SNAPSHOT upgrade that makes the
    // read-then-write transactions elsewhere use BEGIN IMMEDIATE. In WAL a reader takes its
    // snapshot on the first read and holds it, which is exactly the guarantee wanted here.
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| db_error("failed to open the media page read transaction", error))?;

    let mut count_builder = QueryBuilder::<Sqlite>::new("SELECT COUNT(*) FROM videos");
    push_media_filters(
        &mut count_builder,
        channel_id,
        query,
        search_pattern.as_deref(),
    );
    let (total,): (i64,) = count_builder
        .build_query_as::<(i64,)>()
        .fetch_one(&mut *tx)
        .await
        .map_err(|error| db_error("failed to count channel media page", error))?;

    let mut page_builder =
        QueryBuilder::<Sqlite>::new(format!("SELECT {MEDIA_COLUMNS} FROM videos"));
    push_media_filters(
        &mut page_builder,
        channel_id,
        query,
        search_pattern.as_deref(),
    );
    page_builder.push(" ").push(order_by);
    page_builder.push(" LIMIT ").push_bind(limit);
    page_builder.push(" OFFSET ").push_bind(offset);

    let items = page_builder
        .build_query_as::<MediaRow>()
        .fetch_all(&mut *tx)
        .await
        .map_err(|error| db_error("failed to list channel media page", error))?;

    // Nothing was written, so this only releases the snapshot; a rollback would do the same.
    tx.commit()
        .await
        .map_err(|error| db_error("failed to close the media page read transaction", error))?;

    Ok(MediaPage { items, total })
}

pub async fn update_media_title(pool: &SqlitePool, media_id: i64, title: &str) -> AppResult<()> {
    // Keep title_normalized in step with title so the server-side search/sort stays correct after
    // a rename (see utils::text::normalize_search_text).
    let result = sqlx::query("UPDATE videos SET title = ?, title_normalized = ? WHERE id = ?")
        .bind(title)
        .bind(normalize_search_text(title))
        .bind(media_id)
        .execute(pool)
        .await
        .map_err(|error| db_error("failed to update media title", error))?;

    if result.rows_affected() == 0 {
        return Err(AppError::invalid_input("media not found"));
    }

    Ok(())
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

/// Clears the live-chat columns on any video row that references `relative_path`. Used by the
/// standalone delete-live-chat command so removing a replay file never leaves a row flagged
/// `has_live_chat = 1` pointing at a file that no longer exists - a state the v13 CHECK constraint
/// (flag-without-path) does not catch. Setting both columns keeps the row consistent with that
/// CHECK (`has_live_chat = 0 OR live_chat_file_path IS NOT NULL`).
pub async fn clear_live_chat_reference(pool: &SqlitePool, relative_path: &str) -> AppResult<()> {
    let normalized = relative_path.trim();

    if normalized.is_empty() {
        return Ok(());
    }

    sqlx::query(
        "UPDATE videos SET has_live_chat = 0, live_chat_file_path = NULL \
         WHERE live_chat_file_path = ?",
    )
    .bind(normalized)
    .execute(pool)
    .await
    .map_err(|error| db_error("failed to clear live chat reference", error))?;

    Ok(())
}

/// Inserts a media row and returns its id, or returns the id of the existing row when the same
/// `(channel_id, file_path)` is already registered.
///
/// This is an idempotent "add", NOT an upsert of the row's contents: on an existing
/// `(channel_id, file_path)` the `ON CONFLICT DO UPDATE` is a deliberate no-op (see the comment
/// on the statement below), so re-adding the same file keeps the previously stored `title`,
/// `thumbnail_path`, `duration_seconds`, etc. untouched. A caller that needs to change an
/// existing row's metadata must use the dedicated update path (e.g. `update_media_title`), not
/// re-`insert_media`, which will silently leave every field but the id as it was.
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
) -> AppResult<i64> {
    let normalized_live_chat = live_chat_file_path
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let has_live_chat = normalized_live_chat.is_some();

    // `RETURNING id` on the insert yields the row id atomically, whether the row was freshly
    // inserted or already existed. The conflict target uses a no-op `DO UPDATE` (rather than
    // `DO NOTHING`) precisely so `RETURNING` still fires on an existing (channel_id, file_path):
    // `DO NOTHING` suppresses `RETURNING`, which would otherwise force a separate `SELECT` and
    // reopen a TOCTOU window (a concurrent delete between the insert and the lookup would make
    // the row vanish and the function wrongly report "nothing inserted").
    let row: Option<(i64,)> = sqlx::query_as(
        "INSERT INTO videos (
            channel_id, title, title_normalized, file_path, thumbnail_path, media_type,
            youtube_video_id, published_at, duration_seconds, progress_seconds, has_comments,
            comments_count, is_live, has_live_chat, live_chat_file_path
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)
         ON CONFLICT(channel_id, file_path) DO UPDATE SET file_path = excluded.file_path
         RETURNING id",
    )
    .bind(channel_id)
    .bind(title)
    .bind(normalize_search_text(title))
    .bind(file_path)
    .bind(thumbnail_path)
    .bind(media_type)
    .bind(youtube_video_id)
    .bind(published_at)
    .bind(duration_seconds)
    .bind(if is_live { 1_i64 } else { 0_i64 })
    .bind(if has_live_chat { 1_i64 } else { 0_i64 })
    .bind(normalized_live_chat)
    .fetch_optional(pool)
    .await
    .map_err(|error| {
        // The (channel_id, file_path) conflict is absorbed by the no-op ON CONFLICT DO UPDATE
        // above, so a surfacing unique violation can only be the (channel_id, youtube_video_id)
        // index: the same YouTube video already registered for this channel under a different
        // path. Map it to the same friendly code the frontend pre-check raises, closing the
        // check-then-act race with a consistent message instead of a raw SQLite error. This is a
        // closed-world assumption over the unique indexes on `videos` (see db_schema::INDEX_DDLS):
        // a new unique constraint added there would surface here mislabeled as this error, so the
        // two must be kept in sync.
        if is_unique_violation(&error) {
            return AppError::from_code(
                AppErrorCode::VideoAlreadyExistsForChannel,
                "this video is already saved for this channel",
            );
        }

        // The channel_id foreign key no longer resolves: the channel was removed (e.g. deleted
        // concurrently while this download was finishing). Map it to a friendly code instead of
        // a raw SQLite foreign-key constraint error.
        if is_foreign_key_violation(&error) {
            return AppError::from_code(
                AppErrorCode::ChannelNotFound,
                "the channel no longer exists",
            );
        }

        db_error("failed to insert media", error)
    })?;

    // The upsert's RETURNING clause always yields the row (freshly inserted or already existing),
    // so a missing id is a should-never-happen guard rather than a real null case.
    row.map(|(id,)| id)
        .ok_or_else(|| AppError::internal("media insert produced no row id"))
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
         ORDER BY id ASC
         LIMIT ?",
    )
    .bind(media_id)
    .bind(MAX_MEDIA_COMMENTS_LOADED)
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
    let result = sqlx::query("UPDATE videos SET watched_at = NULL WHERE id = ?")
        .bind(media_id)
        .execute(pool)
        .await
        .map_err(|error| db_error("failed to mark media as unwatched", error))?;

    if result.rows_affected() == 0 {
        return Err(AppError::invalid_input("media not found"));
    }

    Ok(())
}

pub async fn update_media_progress(
    pool: &SqlitePool,
    media_id: i64,
    progress_seconds: i64,
) -> AppResult<()> {
    // Deliberately idempotent - a zero-row result is expected here, not an error: the watched
    // guard means a watched media matches no row (progress is not tracked once watched), and
    // saving progress for a since-deleted media is a harmless no-op. This is unlike the
    // title/unwatched updates above, where zero rows means the media id is unknown.
    //
    // The guard mirrors the "unwatched" predicate every other query in this file uses
    // (push_media_filters, the stats query) - NULL *or* a blank string - rather than `IS NULL`
    // alone. The app's own writes never leave `watched_at = ''`, but an imported or hand-edited
    // database can, and treating such a row as watched here (while the rest of the app shows it
    // unwatched) would silently drop its playback progress forever.
    sqlx::query(
        "UPDATE videos SET progress_seconds = ? \
         WHERE id = ? AND (watched_at IS NULL OR TRIM(watched_at) = '')",
    )
    .bind(progress_seconds)
    .bind(media_id)
    .execute(pool)
    .await
    .map_err(|error| db_error("failed to update media progress", error))?;

    Ok(())
}

// These three artifact reference-count helpers are test-only on purpose. The production delete
// paths do the same count *inside* the same `BEGIN IMMEDIATE` transaction that removes the row
// (see services::library_cleanup), which is what makes the count-then-act atomic. Standalone
// versions like these are a check-then-act race waiting to happen if a future caller reaches for
// them instead, so they are gated to `#[cfg(test)]` - compiling them out of production builds means
// no such caller can exist, while the SQL stays exercised by the tests below.
#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
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

/// Computes every library statistic in a single pass over `videos` (one scan with `CASE` sums
/// rather than a dozen separate `COUNT` queries). It is a full-table aggregate, but it is invoked
/// only when the user opens the Diagnostics dialog (via `diagnostics-service.ts`), never on
/// startup or on a poll, so the one-time scan is an acceptable cost and no cached/materialized
/// counter is warranted. If it ever becomes a hot path, revisit with incremental counters.
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

    /// A pool carrying the *real* schema (`db_schema::ensure_schema`), unlike `create_test_pool`
    /// below, which hand-rolls a minimal `videos` table. The sort-index test needs the real index
    /// set, since that is exactly what it is asserting about.
    async fn schema_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create sqlite memory pool");

        crate::services::db_schema::ensure_schema(&pool)
            .await
            .expect("apply schema");

        pool
    }

    /// Each `list_media_page` sort category and the index that must serve its ORDER BY.
    ///
    /// Every category is pinned in *both* directions. Pinning one direction per category is not
    /// enough: a direction the clause reverses only partially (a mixed-direction ORDER BY) cannot
    /// be served by walking a same-direction index forwards or backwards, so the two directions of
    /// one category are genuinely different plans. `publication_date desc` - the grid's default
    /// view - is exactly that case, and went unnoticed while only its `asc` twin was pinned.
    const SORT_INDEX_EXPECTATIONS: &[(&str, &str, &str)] = &[
        ("added_date", "asc", "idx_videos_channel_created_title_id"),
        ("added_date", "desc", "idx_videos_channel_created_title_id"),
        ("title", "asc", "idx_videos_channel_title_normalized"),
        ("title", "desc", "idx_videos_channel_title_normalized"),
        ("comments", "asc", "idx_videos_channel_comments_count"),
        ("comments", "desc", "idx_videos_channel_comments_count"),
        ("duration", "asc", "idx_videos_channel_duration"),
        ("duration", "desc", "idx_videos_channel_duration"),
        (
            "publication_date",
            "asc",
            "idx_videos_channel_published_ordered",
        ),
        (
            "publication_date",
            "desc",
            "idx_videos_channel_published_desc",
        ),
    ];

    /// Every sort category must be answered from an index rather than by pulling the channel's
    /// whole matching set into a sort. This pins the coupling between `resolve_order_by` and the
    /// index DDLs in db_schema: SQLite only walks an index in ORDER BY order when the leading
    /// terms match term for term, so reordering a clause - or indexing `duration_seconds` instead
    /// of the `COALESCE(duration_seconds, 0)` the clause actually sorts on - silently drops the
    /// index and reintroduces the full sort with no other symptom than a slow grid.
    #[tokio::test]
    async fn every_media_page_sort_is_served_by_an_index() {
        let pool = schema_pool().await;

        for &(category, direction, expected_index) in SORT_INDEX_EXPECTATIONS {
            let order_by = resolve_order_by(category, direction).unwrap();
            let sql = format!(
                "EXPLAIN QUERY PLAN SELECT id FROM videos WHERE channel_id = 1 {order_by} LIMIT 60 OFFSET 0"
            );

            // AssertSqlSafe: the only interpolated part is `resolve_order_by`'s return value,
            // which is a fixed &'static str chosen by a match, never caller input.
            let plan: Vec<String> =
                sqlx::query_as::<_, (i64, i64, i64, String)>(sqlx::AssertSqlSafe(sql))
                    .fetch_all(&pool)
                    .await
                    .unwrap_or_else(|error| panic!("explain {category}: {error}"))
                    .into_iter()
                    .map(|(_, _, _, detail)| detail)
                    .collect();

            let detail = plan.join(" | ");

            assert!(
                detail.contains(expected_index),
                "{category} {direction} should use {expected_index}, plan was: {detail}"
            );

            // Exactly one temp-B-tree form is acceptable: "... FOR LAST TERM OF ORDER BY", which
            // only breaks ties inside an already-ordered index walk. Every other form sorts rows
            // the index was supposed to have ordered - the blanket "FOR ORDER BY" (a full sort)
            // and, just as bad, "FOR LAST <n> TERMS OF ORDER BY", where only the leading terms are
            // served. Matching the benign form rather than blacklisting the bad ones is what keeps
            // a new SQLite wording from silently passing: anything unrecognized fails loudly.
            for fragment in detail.split(" | ") {
                assert!(
                    !fragment.contains("USE TEMP B-TREE")
                        || fragment.contains("USE TEMP B-TREE FOR LAST TERM OF ORDER BY"),
                    "{category} {direction} sorts rows the index should have ordered, \
                     plan was: {detail}"
                );
            }
        }
    }

    /// The media-comments read (`list_media_comments_by_media_id`) filters `video_id = ?` and sorts
    /// `id ASC`. Pin that it is served by `idx_video_comments_video_id` without a sort: the index
    /// stores `(video_id, rowid)`, and `id` is the rowid alias, so a fixed `video_id` walks the
    /// matching rows already in `id` order. This mirrors the sort-index pin above for the other hot
    /// ordered read, so a dropped/renamed index or a reordered clause fails a test rather than
    /// quietly reintroducing a full sort on a video with many comments.
    #[tokio::test]
    async fn media_comments_query_is_served_by_its_index() {
        let pool = schema_pool().await;

        let plan: Vec<String> = sqlx::query_as::<_, (i64, i64, i64, String)>(
            "EXPLAIN QUERY PLAN SELECT id FROM video_comments \
             WHERE video_id = 1 ORDER BY id ASC LIMIT 50",
        )
        .fetch_all(&pool)
        .await
        .expect("explain media comments query")
        .into_iter()
        .map(|(_, _, _, detail)| detail)
        .collect();

        let detail = plan.join(" | ");

        assert!(
            detail.contains("idx_video_comments_video_id"),
            "media comments query should use idx_video_comments_video_id, plan was: {detail}"
        );
        assert!(
            !detail.contains("USE TEMP B-TREE"),
            "media comments query should not sort rows the index already orders, plan was: {detail}"
        );
    }

    /// The URL-add pre-check (`media_exists_for_channel_and_youtube_id`) filters
    /// `channel_id = ? AND youtube_video_id = ?`. The partial unique index's `TRIM(...) <> ''`
    /// predicate cannot be proven from `= ?`, so the planner cannot use that index and falls back to
    /// another - which must still be an index search, never a full scan of the channel's videos. Pin
    /// that here so a schema change that leaves this pre-check scanning the table fails loudly.
    #[tokio::test]
    async fn media_existence_pre_check_is_served_by_an_index() {
        let pool = schema_pool().await;

        let plan: Vec<String> = sqlx::query_as::<_, (i64, i64, i64, String)>(
            "EXPLAIN QUERY PLAN \
             SELECT EXISTS(SELECT 1 FROM videos WHERE channel_id = 1 AND youtube_video_id = 'abc')",
        )
        .fetch_all(&pool)
        .await
        .expect("explain media existence pre-check")
        .into_iter()
        .map(|(_, _, _, detail)| detail)
        .collect();

        let detail = plan.join(" | ");

        assert!(
            detail.contains("USING INDEX") || detail.contains("USING COVERING INDEX"),
            "media existence pre-check should be served by an index, plan was: {detail}"
        );
        assert!(
            !detail.contains("SCAN videos"),
            "media existence pre-check should not scan the whole videos table, plan was: {detail}"
        );
    }

    #[tokio::test]
    async fn clear_live_chat_reference_clears_the_columns_on_the_referencing_row() {
        let pool = create_test_pool().await;

        let id = insert_media(
            &pool,
            1,
            "Live stream",
            "video/live.mp4",
            None,
            "video",
            Some("yt-live"),
            None,
            None,
            true,
            Some("live_chat/live.live_chat.json.gz"),
        )
        .await
        .unwrap();

        clear_live_chat_reference(&pool, "live_chat/live.live_chat.json.gz")
            .await
            .unwrap();

        // The row must be left consistent with the has_live_chat/live_chat_file_path CHECK: the flag
        // off and the path null, so a deleted replay file never leaves a dangling reference.
        let (has_live_chat, live_chat_path): (i64, Option<String>) =
            sqlx::query_as("SELECT has_live_chat, live_chat_file_path FROM videos WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();

        assert_eq!(has_live_chat, 0);
        assert_eq!(live_chat_path, None);
    }

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
                title_normalized TEXT,
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
        .unwrap();
        assert!(id > 0);

        let found = find_media_by_channel_and_file_path(&pool, 1, "video/a.mp4")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(found.title, "Video A");
        assert_eq!(found.duration_seconds, Some(120));
        assert_eq!(found.has_live_chat, 0);
    }

    #[tokio::test]
    async fn update_media_title_errors_when_the_media_is_missing() {
        let pool = create_test_pool().await;

        let error = update_media_title(&pool, 999, "New title")
            .await
            .unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidInput.as_str());
    }

    #[tokio::test]
    async fn mark_media_as_unwatched_errors_when_the_media_is_missing() {
        let pool = create_test_pool().await;

        let error = mark_media_as_unwatched(&pool, 999).await.unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidInput.as_str());
    }

    /// A pool whose `videos.channel_id` actually references a `channels` table, so the
    /// foreign-key violation path in `insert_media` can be exercised (the main test pool has no
    /// FK, since most tests do not need one).
    async fn create_test_pool_with_channel_fk() -> SqlitePool {
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
            "CREATE TABLE channels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);",
        )
        .execute(&pool)
        .await
        .expect("create channels table");

        sqlx::query(
            "CREATE TABLE videos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                title_normalized TEXT,
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
                FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
                UNIQUE (channel_id, file_path)
            );",
        )
        .execute(&pool)
        .await
        .expect("create videos table with a channel foreign key");

        pool
    }

    #[tokio::test]
    async fn insert_media_maps_a_missing_channel_to_channel_not_found() {
        let pool = create_test_pool_with_channel_fk().await;

        // No channel row exists, so the channel_id foreign key does not resolve.
        let error = insert_media(
            &pool,
            999,
            "Orphan",
            "video/orphan.mp4",
            None,
            "video",
            None,
            None,
            None,
            false,
            None,
        )
        .await
        .unwrap_err();

        assert_eq!(error.code, AppErrorCode::ChannelNotFound.as_str());
    }

    #[tokio::test]
    async fn insert_media_succeeds_for_an_existing_channel_with_fk_enforced() {
        let pool = create_test_pool_with_channel_fk().await;

        sqlx::query("INSERT INTO channels (id, name) VALUES (1, 'Chan')")
            .execute(&pool)
            .await
            .unwrap();

        let id = insert_media(
            &pool,
            1,
            "Video",
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
        .unwrap();
        assert!(id > 0);
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
    async fn progress_is_saved_for_a_media_whose_watched_at_is_a_blank_string() {
        // The app's own writes only ever set watched_at to a timestamp or NULL, but an imported or
        // hand-edited database can carry a blank string, which every "unwatched" query in this file
        // treats as unwatched. update_media_progress must agree, or such a row would show unwatched
        // everywhere yet never persist playback progress.
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
        .unwrap();

        sqlx::query("UPDATE videos SET watched_at = '' WHERE id = ?")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();

        update_media_progress(&pool, id, 55).await.unwrap();

        let media = find_media_by_channel_and_file_path(&pool, 1, "video/a.mp4")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(media.progress_seconds, 55);
    }

    #[tokio::test]
    async fn lists_comments_in_id_order_within_the_load_cap() {
        // The load is capped (MAX_MEDIA_COMMENTS_LOADED) so a pathological backup cannot pull every
        // row at once, but a normal set must come back whole and ordered by id. Guards the query's
        // LIMIT/ORDER BY so the cap never accidentally truncates or reorders an ordinary load.
        let pool = create_test_pool().await;
        sqlx::query(
            "CREATE TABLE video_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, video_id INTEGER, \
             comment_id TEXT, parent_comment_id TEXT, author_name TEXT NOT NULL DEFAULT '', \
             author_handle TEXT, author_channel_id TEXT, author_thumbnail TEXT, \
             text TEXT NOT NULL DEFAULT '', like_count INTEGER NOT NULL DEFAULT 0, \
             reply_count INTEGER NOT NULL DEFAULT 0, is_author_uploader INTEGER NOT NULL DEFAULT 0, \
             is_favorited INTEGER NOT NULL DEFAULT 0, is_pinned INTEGER NOT NULL DEFAULT 0, \
             is_edited INTEGER NOT NULL DEFAULT 0, time_text TEXT, published_at TEXT, \
             created_at TEXT NOT NULL DEFAULT (datetime('now')));",
        )
        .execute(&pool)
        .await
        .unwrap();

        for text in ["first", "second", "third"] {
            sqlx::query("INSERT INTO video_comments (video_id, text) VALUES (7, ?)")
                .bind(text)
                .execute(&pool)
                .await
                .unwrap();
        }
        // A comment on a different media must not leak into the result.
        sqlx::query("INSERT INTO video_comments (video_id, text) VALUES (8, 'other')")
            .execute(&pool)
            .await
            .unwrap();

        let comments = list_media_comments_by_media_id(&pool, 7).await.unwrap();

        assert_eq!(
            comments.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(),
            ["first", "second", "third"]
        );
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

    fn default_page_query() -> MediaPageQuery {
        MediaPageQuery {
            media_type: "all".to_string(),
            watched: "all".to_string(),
            publication: "all".to_string(),
            search: String::new(),
            sort_category: "added_date".to_string(),
            sort_direction: "desc".to_string(),
            limit: 100,
            offset: 0,
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn seed_media(
        pool: &SqlitePool,
        channel_id: i64,
        title: &str,
        file_path: &str,
        media_type: &str,
        published_at: Option<&str>,
        duration_seconds: Option<i64>,
        watched: bool,
    ) -> i64 {
        let id = insert_media(
            pool,
            channel_id,
            title,
            file_path,
            None,
            media_type,
            None,
            published_at,
            duration_seconds,
            false,
            None,
        )
        .await
        .unwrap();

        if watched {
            mark_media_as_watched(pool, id).await.unwrap();
        }

        id
    }

    #[tokio::test]
    async fn insert_media_populates_title_normalized_for_search() {
        let pool = create_test_pool().await;
        seed_media(
            &pool,
            1,
            "Café com Pão",
            "video/a.mp4",
            "video",
            None,
            None,
            false,
        )
        .await;
        seed_media(
            &pool,
            1,
            "Random Clip",
            "video/b.mp4",
            "video",
            None,
            None,
            false,
        )
        .await;

        // An unaccented, differently-cased query still matches the accented title, proving the
        // stored title_normalized and the search term share one normalization.
        let mut query = default_page_query();
        query.search = "CAFE com pao".to_string();

        let page = list_media_page(&pool, 1, &query).await.unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].title, "Café com Pão");
    }

    #[tokio::test]
    async fn update_media_title_keeps_search_in_sync() {
        let pool = create_test_pool().await;
        let id = seed_media(
            &pool,
            1,
            "Original",
            "video/a.mp4",
            "video",
            None,
            None,
            false,
        )
        .await;

        update_media_title(&pool, id, "Renomeado É Ótimo")
            .await
            .unwrap();

        let mut query = default_page_query();
        query.search = "otimo".to_string();
        let page = list_media_page(&pool, 1, &query).await.unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, id);

        // The old title no longer matches.
        query.search = "original".to_string();
        assert_eq!(list_media_page(&pool, 1, &query).await.unwrap().total, 0);
    }

    #[tokio::test]
    async fn list_media_page_filters_by_type_watched_and_publication() {
        let pool = create_test_pool().await;
        seed_media(
            &pool,
            1,
            "V watched dated",
            "video/a.mp4",
            "video",
            Some("2026-01-01"),
            None,
            true,
        )
        .await;
        seed_media(
            &pool,
            1,
            "V unwatched undated",
            "video/b.mp4",
            "video",
            None,
            None,
            false,
        )
        .await;
        seed_media(
            &pool,
            1,
            "A unwatched dated",
            "audio/c.m4a",
            "audio",
            Some("2026-02-01"),
            None,
            false,
        )
        .await;

        let mut query = default_page_query();
        query.media_type = "video".to_string();
        assert_eq!(list_media_page(&pool, 1, &query).await.unwrap().total, 2);

        let mut query = default_page_query();
        query.watched = "watched".to_string();
        let watched_page = list_media_page(&pool, 1, &query).await.unwrap();
        assert_eq!(watched_page.total, 1);
        assert_eq!(watched_page.items[0].title, "V watched dated");

        let mut query = default_page_query();
        query.watched = "unwatched".to_string();
        assert_eq!(list_media_page(&pool, 1, &query).await.unwrap().total, 2);

        let mut query = default_page_query();
        query.publication = "with".to_string();
        assert_eq!(list_media_page(&pool, 1, &query).await.unwrap().total, 2);

        let mut query = default_page_query();
        query.publication = "without".to_string();
        let undated = list_media_page(&pool, 1, &query).await.unwrap();
        assert_eq!(undated.total, 1);
        assert_eq!(undated.items[0].title, "V unwatched undated");
    }

    #[tokio::test]
    async fn list_media_page_windows_results_and_reports_full_total() {
        let pool = create_test_pool().await;
        for index in 0..5 {
            seed_media(
                &pool,
                1,
                &format!("Title {index}"),
                &format!("video/{index}.mp4"),
                "video",
                None,
                None,
                false,
            )
            .await;
        }

        let mut query = default_page_query();
        query.sort_category = "title".to_string();
        query.sort_direction = "asc".to_string();
        query.limit = 2;
        query.offset = 0;

        let first = list_media_page(&pool, 1, &query).await.unwrap();
        // total counts all matches, not just the returned window.
        assert_eq!(first.total, 5);
        assert_eq!(first.items.len(), 2);
        assert_eq!(first.items[0].title, "Title 0");
        assert_eq!(first.items[1].title, "Title 1");

        query.offset = 4;
        let last = list_media_page(&pool, 1, &query).await.unwrap();
        assert_eq!(last.total, 5);
        assert_eq!(last.items.len(), 1);
        assert_eq!(last.items[0].title, "Title 4");
    }

    #[tokio::test]
    async fn list_media_page_publication_sort_keeps_dated_before_undated() {
        let pool = create_test_pool().await;
        seed_media(
            &pool,
            1,
            "Older dated",
            "video/a.mp4",
            "video",
            Some("2025-01-01"),
            None,
            false,
        )
        .await;
        seed_media(
            &pool,
            1,
            "Newer dated",
            "video/b.mp4",
            "video",
            Some("2026-01-01"),
            None,
            false,
        )
        .await;
        seed_media(
            &pool,
            1,
            "Undated",
            "video/c.mp4",
            "video",
            None,
            None,
            false,
        )
        .await;

        let mut query = default_page_query();
        query.sort_category = "publication_date".to_string();
        query.sort_direction = "desc".to_string();

        let titles: Vec<String> = list_media_page(&pool, 1, &query)
            .await
            .unwrap()
            .items
            .into_iter()
            .map(|item| item.title)
            .collect();

        // Newest dated first, then older dated, then the undated media last regardless of direction.
        assert_eq!(titles, vec!["Newer dated", "Older dated", "Undated"]);
    }

    #[tokio::test]
    async fn list_media_page_search_treats_like_metacharacters_literally() {
        let pool = create_test_pool().await;
        seed_media(
            &pool,
            1,
            "100% real",
            "video/a.mp4",
            "video",
            None,
            None,
            false,
        )
        .await;
        seed_media(
            &pool,
            1,
            "100 percent",
            "video/b.mp4",
            "video",
            None,
            None,
            false,
        )
        .await;

        let mut query = default_page_query();
        query.search = "100%".to_string();

        // "%" is escaped, so only the title literally containing "100%" matches, not "100 percent".
        let page = list_media_page(&pool, 1, &query).await.unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].title, "100% real");
    }

    #[tokio::test]
    async fn list_media_page_rejects_invalid_filter_and_sort_values() {
        let pool = create_test_pool().await;

        let mut query = default_page_query();
        query.media_type = "image".to_string();
        assert_eq!(
            list_media_page(&pool, 1, &query).await.unwrap_err().code,
            AppErrorCode::InvalidInput.as_str()
        );

        let mut query = default_page_query();
        query.sort_category = "views".to_string();
        assert_eq!(
            list_media_page(&pool, 1, &query).await.unwrap_err().code,
            AppErrorCode::InvalidInput.as_str()
        );

        let mut query = default_page_query();
        query.sort_direction = "sideways".to_string();
        assert_eq!(
            list_media_page(&pool, 1, &query).await.unwrap_err().code,
            AppErrorCode::InvalidInput.as_str()
        );
    }
}
