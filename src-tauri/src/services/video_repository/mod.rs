use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use ts_rs::TS;

use crate::services::database::{
    database_error_message, db_error, is_foreign_key_violation, is_unique_violation,
};
use crate::utils::path::ensure_managed_library_relative_path;
use crate::utils::text::normalize_search_text;
use crate::utils::validation::{ensure_valid_media_title, ensure_valid_media_type};
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
    /// What a comment fetch last concluded: `unknown`, `none` or `available`. See
    /// `media_comments::CommentsState`; the CHECK on the column keeps it to those three, and
    /// the player reads it to decide whether offering a Fetch button would be honest.
    #[ts(type = "\"unknown\" | \"none\" | \"available\"")]
    pub comments_state: String,
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

/// The stored paths of one media row, plus what a reported path needs to resolve back to it.
///
/// Backend-only, and deliberately not `ts(export)`ed: it used to cross the IPC boundary so the
/// renderer could assemble the integrity check's inputs, and that resolution now happens in
/// `library::integrity` on this side. Nothing in `src/` names this shape any more. What the
/// frontend receives is `LibraryIntegrityCheck`, which is bounded by what the report named.
#[derive(Debug, sqlx::FromRow)]
pub struct MediaIntegrityReference {
    pub id: i64,
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
/// would let a compromised frontend drive a pathologically long scan. Generous. Real titles, which
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
    comments_count, comments_state, is_live, has_live_chat, live_chat_file_path, created_at";

// The channel media grid's paginated query and its filter/sort SQL-building helpers live in the
// `media_page` submodule. list_media_page is re-exported; resolve_order_by is reached by the
// parent's EXPLAIN-QUERY-PLAN tests.
mod media_page;
pub use media_page::list_media_page;
#[cfg(test)]
use media_page::resolve_order_by;

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

/// Inserts a media row and returns its id, or returns the id of the existing row when the same
/// `(channel_id, file_path)` is already registered.
///
/// This is an idempotent "add", NOT an upsert of the row's contents: on an existing
/// `(channel_id, file_path)` the `ON CONFLICT DO UPDATE` is a deliberate no-op (see the comment
/// on the statement below), so re-adding the same file keeps the previously stored `title`,
/// `thumbnail_path`, `duration_seconds`, etc. untouched. A caller that needs to change an
/// existing row's metadata must use the dedicated update path (e.g. `update_media_title`), not
/// re-`insert_media`, which will silently leave every field but the id as it was.
///
/// # The write boundary is here
///
/// The validation below used to live one layer up, in the `insert_media` Tauri command, which made
/// it a property of *arriving over IPC* rather than of writing a row. That was the wrong place for
/// it twice over: the command has since been removed from the IPC surface (a media is created
/// through `create_media`, which exposes an operation rather than its steps), and the remaining
/// caller (`services::media_creation`) would then have been trusted to have done it itself.
/// It mostly had, but not entirely: the `media_type` a yt-dlp download reports is the download's
/// own, never the normalized request's, so it reached the row with nothing but the table's `CHECK`
/// behind it.
///
/// So the rule the rest of the backend follows applies here too: every write boundary calls the
/// shared validators. The paths must be managed and library-relative, because the deletion path acts
/// on whatever a row holds; the text fields are validated and stored trimmed, because the partial
/// unique index on `youtube_video_id` compares the stored column verbatim and a padded value would
/// dodge the dedupe.
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
    ensure_valid_media_title(title)?;
    ensure_valid_media_type(media_type)?;

    ensure_managed_library_relative_path(file_path)?;

    if let Some(path) = thumbnail_path {
        ensure_managed_library_relative_path(path)?;
    }

    if let Some(path) = live_chat_file_path {
        ensure_managed_library_relative_path(path)?;
    }

    // A blank youtube id is "no id": stored as an empty string it would sit in the partial unique
    // index as a *present* value and collide with the next blank one, which is the opposite of what
    // that index is for.
    let title = title.trim();
    let media_type = media_type.trim();
    let youtube_video_id = youtube_video_id
        .map(str::trim)
        .filter(|value| !value.is_empty());

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
        // above, so a surfacing unique violation is expected to be the (channel_id,
        // youtube_video_id) index: the same YouTube video already registered for this channel under
        // a different path. Confirm that from the failing constraint's own message rather than
        // assuming it. The previous code mapped *any* unique violation to this error, so a unique
        // constraint added to `videos` later (see db_schema::INDEX_DDLS) would have been mislabeled
        // as "already saved". A violation that does not name youtube_video_id falls through to the
        // generic db_error below instead of lying about the cause.
        if is_unique_violation(&error)
            && database_error_message(&error)
                .map(|message| message.contains("youtube_video_id"))
                .unwrap_or(false)
        {
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

/// Writes the duration a media was measured at, once its row exists.
///
/// Split from the insert because the measurement is: the renderer probes the file through a media
/// element after `create_media` returns, since that decoder is a webview capability and running one
/// FFmpeg per import to re-derive a number the player already knows would be the wrong trade. The
/// column is nullable, so a row simply carries no duration until this lands, and carries none
/// forever if the probe cannot read the file, which is the pre-existing behavior for an unreadable
/// or exotic container.
///
/// Idempotent, and deliberately not an error when it matches no row: the media may have been deleted
/// between the insert and the probe settling, which is a harmless no-op rather than a failure worth
/// surfacing to someone who has already moved on.
pub async fn update_media_duration(
    pool: &SqlitePool,
    media_id: i64,
    duration_seconds: Option<i64>,
) -> AppResult<()> {
    sqlx::query("UPDATE videos SET duration_seconds = ? WHERE id = ?")
        .bind(duration_seconds)
        .bind(media_id)
        .execute(pool)
        .await
        .map_err(|error| db_error("failed to update media duration", error))?;

    Ok(())
}

pub async fn update_media_progress(
    pool: &SqlitePool,
    media_id: i64,
    progress_seconds: i64,
) -> AppResult<()> {
    // Deliberately idempotent. A zero-row result is expected here, not an error: the watched
    // guard means a watched media matches no row (progress is not tracked once watched), and
    // saving progress for a since-deleted media is a harmless no-op. This is unlike the
    // title/unwatched updates above, where zero rows means the media id is unknown.
    //
    // The guard mirrors the "unwatched" predicate every other query in this file uses
    // (push_media_filters, the stats query) (NULL *or* a blank string), rather than `IS NULL`
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
// (see services::library::cleanup), which is what makes the count-then-act atomic. Standalone
// versions like these are a check-then-act race waiting to happen if a future caller reaches for
// them instead, so they are gated to `#[cfg(test)]`. Compiling them out of production builds means
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
mod tests;
