//! The channel media grid's paginated query - the app's hottest read path - and the pure
//! filter/sort SQL-building helpers behind it. Filtering, sorting and windowing all run in
//! SQLite so the whole channel is never loaded over IPC just to be filtered in the webview.
//! Split out of the repository so this one large query and its `ORDER BY`/`WHERE` construction
//! read as a unit. The row/query types and the shared constants stay in the parent module.
//!
//! Tests (including the `EXPLAIN QUERY PLAN` sort-index checks) live in the parent's `mod tests`.

use sqlx::{QueryBuilder, Sqlite, SqlitePool};

use super::{
    MediaPage, MediaPageQuery, MediaRow, MAX_MEDIA_PAGE_LIMIT, MAX_SEARCH_TERM_CHARS, MEDIA_COLUMNS,
};
use crate::services::database::db_error;
use crate::utils::text::{escape_like_pattern, normalize_search_text};
use crate::{AppError, AppResult};

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
pub(super) fn resolve_order_by(
    sort_category: &str,
    sort_direction: &str,
) -> AppResult<&'static str> {
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
