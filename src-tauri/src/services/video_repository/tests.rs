// The tests for the parent module, kept in a file of their own so the module reads as its
// production code. Same module as before (`mod tests` declared under `#[cfg(test)]` in the
// parent), so `use super::*` still reaches every private item it did.

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
/// enough. A direction the clause reverses only partially (a mixed-direction ORDER BY) cannot
/// be served by walking a same-direction index forwards or backwards, so the two directions of
/// one category are genuinely different plans. `publication_date desc` (the grid's default
/// view) is exactly that case, and went unnoticed while only its `asc` twin was pinned.
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
/// terms match term for term, so reordering a clause (or indexing `duration_seconds` instead
/// of the `COALESCE(duration_seconds, 0)` the clause actually sorts on), silently drops the
/// index and reintroduces the full sort with no other symptom than a slow grid.
#[tokio::test]
async fn every_media_page_sort_is_served_by_an_index() {
    let pool = schema_pool().await;

    for &(category, direction, expected_index) in SORT_INDEX_EXPECTATIONS {
        let order_by = resolve_order_by(category, direction).unwrap();
        let sql = format!(
            "EXPLAIN QUERY PLAN SELECT id FROM videos WHERE channel_id = 1 {order_by} LIMIT 60 OFFSET 0"
        );

        // AssertSqlSafe. The only interpolated part is `resolve_order_by`'s return value,
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

        // Exactly one temp-B-tree form is acceptable. "... FOR LAST TERM OF ORDER BY", which
        // only breaks ties inside an already-ordered index walk. Every other form sorts rows
        // the index was supposed to have ordered. The blanket "FOR ORDER BY" (a full sort)
        // and, just as bad, "FOR LAST <n> TERMS OF ORDER BY", where only the leading terms are
        // served. Matching the benign form rather than blacklisting the bad ones is what keeps
        // a new SQLite wording from silently passing. Anything unrecognized fails loudly.
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
/// `id ASC`. Pin that it is served by `idx_video_comments_video_id` without a sort. The index
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
/// another, which must still be an index search, never a full scan of the channel's videos. Pin
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
            comments_state TEXT NOT NULL DEFAULT 'unknown'
                CHECK (comments_state IN ('unknown', 'none', 'available')),
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
        Some("thumbnails/a.jpg"),
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
            comments_state TEXT NOT NULL DEFAULT 'unknown'
                CHECK (comments_state IN ('unknown', 'none', 'available')),
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

    // Same channel + youtube_video_id but a different file_path. The file_path ON CONFLICT
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

    // Same youtube id but a different channel. Not a duplicate for that channel.
    assert!(!media_exists_for_channel_and_youtube_id(&pool, 2, "yt1")
        .await
        .unwrap());

    // Same channel but a different youtube id. Not a duplicate.
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
        Some("thumbnails/s.jpg"),
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
        Some("thumbnails/s.jpg"),
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
        count_media_using_thumbnail_outside_media(&pool, "thumbnails/s.jpg", a)
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

/// `insert_media` with only the fields a validation test cares about, so each one below names
/// the value it is actually about.
async fn insert_with(
    pool: &SqlitePool,
    title: &str,
    file_path: &str,
    media_type: &str,
    youtube_video_id: Option<&str>,
) -> AppResult<i64> {
    insert_media(
        pool,
        1,
        title,
        file_path,
        None,
        media_type,
        youtube_video_id,
        None,
        None,
        false,
        None,
    )
    .await
}

/// What the row actually holds, which is the only thing these tests can assert about a value
/// that was normalized on the way in.
async fn stored_youtube_video_id(pool: &SqlitePool, media_id: i64) -> Option<String> {
    sqlx::query_as::<_, (Option<String>,)>("SELECT youtube_video_id FROM videos WHERE id = ?")
        .bind(media_id)
        .fetch_one(pool)
        .await
        .expect("the inserted row must be readable")
        .0
}

// The five tests below moved here with the validation they pin, from the `insert_media` Tauri
// command that used to perform it and has since been removed from the IPC surface. They assert
// the same behaviors against the function that performs them now, which is also the function
// every caller reaches, where the command was only one of them.

#[tokio::test]
async fn insert_media_stores_a_trimmed_youtube_video_id() {
    // A padded youtube id has to be stored trimmed, so the partial unique index and the id
    // lookup (both of which compare the column verbatim), see the same value. This also pins
    // that the non-empty filter does not swallow a real id. Without its `!`, every id would be
    // dropped to NULL instead of stored.
    let pool = create_test_pool().await;

    let media_id = insert_with(&pool, "A", "video/a.mp4", "video", Some("  vid123  "))
        .await
        .unwrap();

    assert_eq!(
        stored_youtube_video_id(&pool, media_id).await.as_deref(),
        Some("vid123")
    );
}

#[tokio::test]
async fn insert_media_normalizes_a_blank_youtube_video_id_to_null() {
    // A whitespace-only id is "no id". Stored as an empty string it would sit in the partial
    // unique index as a *present* value and collide with the next blank one, which is the
    // opposite of what that index is for.
    let pool = create_test_pool().await;

    let media_id = insert_with(&pool, "A", "video/a.mp4", "video", Some("   "))
        .await
        .unwrap();

    assert_eq!(stored_youtube_video_id(&pool, media_id).await, None);
}

#[tokio::test]
async fn insert_media_rejects_a_path_outside_the_managed_layout() {
    // The deletion path acts on whatever a row holds, so a traversing or bare path persisted
    // here would let a later delete or move operate outside the app's own tree. Every stored
    // path is checked, not only the media file.
    let pool = create_test_pool().await;

    assert_eq!(
        insert_with(&pool, "A", "../escape.mp4", "video", None)
            .await
            .unwrap_err()
            .code,
        AppErrorCode::InvalidRelativePath.as_str()
    );

    assert_eq!(
        insert_media(
            &pool,
            1,
            "A",
            "video/a.mp4",
            Some("/etc/passwd"),
            "video",
            None,
            None,
            None,
            false,
            None,
        )
        .await
        .unwrap_err()
        .code,
        AppErrorCode::InvalidRelativePath.as_str()
    );

    assert_eq!(
        insert_media(
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
            Some("../outside.json.gz"),
        )
        .await
        .unwrap_err()
        .code,
        AppErrorCode::InvalidRelativePath.as_str()
    );
}

#[tokio::test]
async fn insert_media_rejects_an_empty_title() {
    let pool = create_test_pool().await;

    assert_eq!(
        insert_with(&pool, "   ", "video/a.mp4", "video", None)
            .await
            .unwrap_err()
            .code,
        AppErrorCode::InvalidMediaTitle.as_str()
    );
}

#[tokio::test]
async fn insert_media_rejects_a_media_type_the_schema_would_refuse() {
    // The table's own CHECK would refuse this too, so what this buys is the message. A named
    // validation failure rather than a constraint violation. It is also the one field a yt-dlp
    // creation does not route through the request normalizer (the value comes off the download),
    // so before this check moved here, nothing but that CHECK stood behind it.
    let pool = create_test_pool().await;

    assert_eq!(
        insert_with(&pool, "A", "video/a.mp4", "image", None)
            .await
            .unwrap_err()
            .code,
        AppErrorCode::InvalidMediaCreationArguments.as_str()
    );
}
