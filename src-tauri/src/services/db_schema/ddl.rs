//! The schema's DDL as data (the `CREATE TABLE`/index/trigger statements and the additive-column
//! list the migrations in the parent module apply). Constants plus the version filter over the
//! index list, split out so the migration code reads as migration steps rather than being buried
//! under the SQL text. `pub(super)` so the parent (and its tests, via `super::*`) reach them.

use super::BASELINE_SCHEMA_VERSION;

pub(super) const CHANNELS_TABLE_DDL: &str = "CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (TRIM(name) <> ''),
    youtube_handle TEXT NOT NULL UNIQUE CHECK (TRIM(youtube_handle) <> ''),
    avatar_path TEXT CHECK (avatar_path IS NULL OR TRIM(avatar_path) <> ''),
    -- The channel's banner, the wide image behind the avatar on its page. Added by v18.
    banner_path TEXT CHECK (banner_path IS NULL OR TRIM(banner_path) <> ''),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
)";

pub(super) const VIDEOS_TABLE_DDL: &str = "CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    title TEXT NOT NULL CHECK (TRIM(title) <> ''),
    title_normalized TEXT,
    file_path TEXT NOT NULL CHECK (TRIM(file_path) <> ''),
    thumbnail_path TEXT CHECK (thumbnail_path IS NULL OR TRIM(thumbnail_path) <> ''),
    media_type TEXT NOT NULL CHECK (media_type IN ('video', 'audio')),
    youtube_video_id TEXT,
    watched_at TEXT,
    published_at TEXT,
    duration_seconds INTEGER,
    progress_seconds INTEGER NOT NULL DEFAULT 0,
    has_comments INTEGER NOT NULL DEFAULT 0,
    comments_count INTEGER NOT NULL DEFAULT 0,
    -- What a comment fetch last concluded for this media, which has_comments cannot say. That
    -- flag is derived from the stored count, so 0 covers both a media nothing was ever fetched
    -- for and one whose fetch ran and found nothing to store. The second is a final answer and
    -- the first is not, and the player offered its Fetch button on both, so a user could re-run
    -- an operation that could never return anything. 'unknown' is this DEFAULT and nothing in
    -- the crate writes it, so the state only moves forward. See media_comments::CommentsState
    -- for the two values that are written and why there are two rather than three.
    comments_state TEXT NOT NULL DEFAULT 'unknown'
        CHECK (comments_state IN ('unknown', 'none', 'available')),
    is_live INTEGER NOT NULL DEFAULT 0,
    has_live_chat INTEGER NOT NULL DEFAULT 0,
    live_chat_file_path TEXT CHECK (live_chat_file_path IS NULL OR TRIM(live_chat_file_path) <> ''),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- has_live_chat is set only when a live_chat_file_path is stored: insert_media derives both
    -- from the same optional path, so a row flagged as having a live chat with no stored path is a
    -- corruption the write path can never produce. Enforce it here so an out-of-band writer or a
    -- malformed import cannot persist that state, rather than only counting it in the library
    -- diagnostics (see video_repository::get_media_repository_stats). One-directional on purpose:
    -- the flag being clear while a path is present is harmless (it just hides a stored replay), so
    -- only the flag-without-path direction is rejected.
    CHECK (has_live_chat = 0 OR live_chat_file_path IS NOT NULL),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    UNIQUE (channel_id, file_path)
)";

pub(super) const VIDEO_COMMENTS_TABLE_DDL: &str = "CREATE TABLE IF NOT EXISTS video_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    comment_id TEXT,
    parent_comment_id TEXT,
    author_name TEXT NOT NULL,
    author_handle TEXT,
    author_channel_id TEXT,
    author_thumbnail TEXT,
    -- Ceiling on a stored comment body, mirrored from media_comments::MAX_COMMENT_TEXT_CHARS (the
    -- app-side truncation ceiling). LENGTH counts characters on a TEXT value, matching that
    -- character cap. On a fresh database this CHECK is the primary guard. Databases whose table
    -- predates it get the equivalent trigger via migration v14 (see db_schema). Keep the literal in
    -- sync with the constant: a db_schema test pins it.
    text TEXT NOT NULL CHECK (LENGTH(text) <= 16000),
    -- The text a comment had when it was first stored, kept once a later fetch brings a different
    -- one (an edit, a moderation). NULL while the text never changed. Added by v17.
    original_text TEXT CHECK (original_text IS NULL OR LENGTH(original_text) <= 16000),
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
)";

pub(super) const APP_SETTINGS_TABLE_DDL: &str = "CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)";

/// The media of a channel on YouTube that the user chose to stop being offered for import (the
/// channel page's "Not in library" list). By YouTube video id, and gone with the channel. Created by
/// v19 rather than by the baseline, which every database passes before it, so a fresh one gets it
/// from the same migration an older one does.
pub(super) const IGNORED_CHANNEL_MEDIA_TABLE_DDL: &str =
    "CREATE TABLE IF NOT EXISTS ignored_channel_media (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    youtube_video_id TEXT NOT NULL CHECK (length(youtube_video_id) = 11),
    ignored_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (channel_id, youtube_video_id)
) WITHOUT ROWID";

pub(super) const TABLE_DDLS: &[&str] = &[
    CHANNELS_TABLE_DDL,
    VIDEOS_TABLE_DDL,
    VIDEO_COMMENTS_TABLE_DDL,
    APP_SETTINGS_TABLE_DDL,
];

// Tables created by older app versions that are no longer used. Live chat is stored as
// JSON files in the app data directory, never in the database, so this table was always
// empty. Dropped on startup to remove it from existing databases.
pub(super) const LEGACY_TABLE_DROPS: &[&str] = &["DROP TABLE IF EXISTS video_live_chat_messages"];

/// One index the current schema carries.
pub(super) struct IndexDdl {
    /// The table the index belongs to. The table-rebuild path recreates only the indexes of the
    /// tables it dropped, since dropping a table only drops that table's indexes.
    pub(super) table: &'static str,
    /// The schema version that first created the index. A migration builds only the indexes of
    /// its own version and below (`index_ddls_through`), so it never reaches an index on a column
    /// a later migration adds. Running the whole list from v8, v9 and v10 is what broke the
    /// upgrade of databases older than v11 once already, because the list had grown indexes on
    /// `title_normalized`.
    pub(super) since: i64,
    pub(super) ddl: &'static str,
}

/// The indexes a database stamped `version` carries.
pub(super) fn index_ddls_through(version: i64) -> impl Iterator<Item = &'static IndexDdl> {
    INDEX_DDLS
        .iter()
        .filter(move |index| index.since <= version)
}

// Every index of the current schema. A new one gets the version of the migration that adds it,
// and that migration builds it through `index_ddls_through`. An index that is dropped later moves
// to RETIRED_INDEXES below, so the test fixtures can still build a faithful older database.
pub(super) const INDEX_DDLS: &[IndexDdl] = &[
    IndexDdl {
        table: "videos",
        since: BASELINE_SCHEMA_VERSION,
        ddl: "CREATE INDEX IF NOT EXISTS idx_videos_channel_id ON videos(channel_id)",
    },
    // Serves the title-sorted page of a channel's media (the paginated library list ordering by
    // title_normalized within a channel), so that sort does not filesort the whole channel.
    IndexDdl {
        table: "videos",
        since: 11,
        ddl: "CREATE INDEX IF NOT EXISTS idx_videos_channel_title_normalized ON videos(channel_id, title_normalized)",
    },
    // One index per `list_media_page` sort category, each mirroring that category's ORDER BY
    // exactly (see video_repository::resolve_order_by). SQLite only walks an index in ORDER BY
    // order when the leading terms match term for term, so `duration` and `publication_date`
    // must index the same COALESCE/CASE *expressions* the clause sorts on. A plain index on
    // duration_seconds or published_at is never used by those queries. Measured with EXPLAIN
    // QUERY PLAN. Without these, every one of these sorts falls back to idx_videos_channel_id
    // and re-sorts the channel's whole matching set on each page.
    IndexDdl {
        table: "videos",
        since: 12,
        ddl: "CREATE INDEX IF NOT EXISTS idx_videos_channel_created_title_id ON videos(channel_id, created_at DESC, title_normalized DESC, id DESC)",
    },
    IndexDdl {
        table: "videos",
        since: 12,
        ddl: "CREATE INDEX IF NOT EXISTS idx_videos_channel_comments_count ON videos(channel_id, comments_count, title_normalized)",
    },
    IndexDdl {
        table: "videos",
        since: 12,
        ddl: "CREATE INDEX IF NOT EXISTS idx_videos_channel_duration ON videos(channel_id, COALESCE(duration_seconds, 0), title_normalized)",
    },
    IndexDdl {
        table: "videos",
        since: 12,
        ddl: "CREATE INDEX IF NOT EXISTS idx_videos_channel_published_ordered ON videos(channel_id, (CASE WHEN published_at IS NOT NULL AND TRIM(published_at) <> '' THEN 0 ELSE 1 END), (CASE WHEN published_at IS NOT NULL AND TRIM(published_at) <> '' THEN published_at END), title_normalized)",
    },
    // `publication_date` needs a second index because its two directions are not mirror images.
    // The `desc` one keeps the dated-first group key ASC and the title tie-break ASC while reversing only
    // the date. SQLite can walk an index forwards or backwards, but not partly each way, so the
    // all-ASC index above serves only the leading group key for desc and sorts the remaining
    // three terms, and desc is the grid's default view, i.e. the hottest query in the app.
    // The term directions here mirror that clause exactly.
    IndexDdl {
        table: "videos",
        since: 12,
        ddl: "CREATE INDEX IF NOT EXISTS idx_videos_channel_published_desc ON videos(channel_id, (CASE WHEN published_at IS NOT NULL AND TRIM(published_at) <> '' THEN 0 ELSE 1 END) ASC, (CASE WHEN published_at IS NOT NULL AND TRIM(published_at) <> '' THEN published_at END) DESC, title_normalized ASC)",
    },
    IndexDdl {
        table: "channels",
        since: BASELINE_SCHEMA_VERSION,
        ddl: "CREATE INDEX IF NOT EXISTS idx_channels_avatar_path ON channels(avatar_path)",
    },
    // The thumbnail reference count reads banners as well as avatars (library::cleanup).
    IndexDdl {
        table: "channels",
        since: 18,
        ddl: "CREATE INDEX IF NOT EXISTS idx_channels_banner_path ON channels(banner_path)",
    },
    IndexDdl {
        table: "videos",
        since: BASELINE_SCHEMA_VERSION,
        ddl: "CREATE INDEX IF NOT EXISTS idx_videos_thumbnail_path ON videos(thumbnail_path)",
    },
    // Serves the artifact reference-count lookups run on every media/channel delete
    // (WHERE file_path = ? / WHERE live_chat_file_path = ?). The table's (channel_id, file_path)
    // UNIQUE constraint already provides the auto-index that backs the insert_media upsert's
    // ON CONFLICT(channel_id, file_path), but that composite index cannot serve a bare
    // `file_path =` predicate without the leading `channel_id`, so a dedicated single-column
    // index is needed to keep deletes off a full table scan.
    IndexDdl {
        table: "videos",
        since: 9,
        ddl: "CREATE INDEX IF NOT EXISTS idx_videos_file_path ON videos(file_path)",
    },
    IndexDdl {
        table: "videos",
        since: 9,
        ddl: "CREATE INDEX IF NOT EXISTS idx_videos_live_chat_file_path ON videos(live_chat_file_path)",
    },
    IndexDdl {
        table: "videos",
        since: BASELINE_SCHEMA_VERSION,
        ddl: "CREATE INDEX IF NOT EXISTS idx_videos_channel_thumb ON videos(channel_id, thumbnail_path)",
    },
    // NOT dead, despite never appearing in a query plan, and the distinction matters because a
    // reader cleaning up on plan evidence alone would drop it. It is UNIQUE. It exists to enforce
    // "one row per (channel, youtube video id)", not to be chosen. It goes unused for lookups
    // because it is partial, and SQLite only uses a partial index when the query's WHERE proves the
    // index's. `youtube_video_id = ?` does not prove the `TRIM(...) <> ''`. So the duplicate
    // pre-check falls back to idx_videos_channel_id, and the constraint still holds.
    IndexDdl {
        table: "videos",
        since: BASELINE_SCHEMA_VERSION,
        ddl: "CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_channel_youtube_video_id_unique ON videos(channel_id, youtube_video_id) WHERE youtube_video_id IS NOT NULL AND TRIM(youtube_video_id) <> ''",
    },
    IndexDdl {
        table: "video_comments",
        since: BASELINE_SCHEMA_VERSION,
        ddl: "CREATE INDEX IF NOT EXISTS idx_video_comments_video_id ON video_comments(video_id)",
    },
];

/// An index an older schema created and a later migration dropped.
pub(super) struct RetiredIndex {
    pub(super) name: &'static str,
    /// The schema version that first created it, so a fixture of an older era does not get it.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) since: i64,
    /// The migration that drops it with `DROP INDEX IF EXISTS`.
    pub(super) retired_in: i64,
    /// The DDL older versions ran, kept for the test fixtures that rebuild a database of that era.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) ddl: &'static str,
}

// Every index below was dropped because no statement the backend issues chooses it, measured with
// EXPLAIN QUERY PLAN over the real statements on a schema with no ANALYZE, which is the planner
// production runs.
//
// v16 drops the two `video_comments` ones (measured 2026-08-16). The reply threads are rebuilt in
// the renderer from the flat list the `video_id` query returns, so nothing looks a comment up by
// its parent, and v10's dedup builds its own temporary index rather than walking the `comment_id`
// one. A single comment merge writes up to 100,000 rows into that table, so every merge paid for
// two indexes nobody read.
//
// v20 drops the eight on `videos` and `channels` (re-measured 2026-11-08 over 412 statements,
// every filter and sort combination of the media grid included, with no plan getting worse).
// `idx_channels_youtube_handle` duplicates the auto-index the UNIQUE `youtube_handle` column already
// has, and the handle lookups take that one once it is gone. `idx_videos_channel_created_id`
// served the unpaginated newest-first listing, since removed. The six single-column ones would each
// serve a lookup that does not exist, since every query reaching those columns is scoped by
// `channel_id` first, or index a boolean no query filters on selectively. Kept as long as the table
// they sit on, they cost every write, and a table rebuild would have built all of them over the
// whole library while the user waits at startup.
pub(super) const RETIRED_INDEXES: &[RetiredIndex] = &[
    RetiredIndex {
        name: "idx_video_comments_parent_comment_id",
        since: BASELINE_SCHEMA_VERSION,
        retired_in: 16,
        ddl: "CREATE INDEX IF NOT EXISTS idx_video_comments_parent_comment_id ON video_comments(parent_comment_id)",
    },
    RetiredIndex {
        name: "idx_video_comments_comment_id",
        since: BASELINE_SCHEMA_VERSION,
        retired_in: 16,
        ddl: "CREATE INDEX IF NOT EXISTS idx_video_comments_comment_id ON video_comments(comment_id)",
    },
    RetiredIndex {
        name: "idx_videos_channel_created_id",
        since: 8,
        retired_in: 20,
        ddl: "CREATE INDEX IF NOT EXISTS idx_videos_channel_created_id ON videos(channel_id, created_at DESC, id DESC)",
    },
    RetiredIndex {
        name: "idx_channels_youtube_handle",
        since: BASELINE_SCHEMA_VERSION,
        retired_in: 20,
        ddl: "CREATE INDEX IF NOT EXISTS idx_channels_youtube_handle ON channels(youtube_handle)",
    },
    RetiredIndex {
        name: "idx_videos_youtube_video_id",
        since: BASELINE_SCHEMA_VERSION,
        retired_in: 20,
        ddl: "CREATE INDEX IF NOT EXISTS idx_videos_youtube_video_id ON videos(youtube_video_id)",
    },
    RetiredIndex {
        name: "idx_videos_watched_at",
        since: BASELINE_SCHEMA_VERSION,
        retired_in: 20,
        ddl: "CREATE INDEX IF NOT EXISTS idx_videos_watched_at ON videos(watched_at)",
    },
    RetiredIndex {
        name: "idx_videos_published_at",
        since: BASELINE_SCHEMA_VERSION,
        retired_in: 20,
        ddl: "CREATE INDEX IF NOT EXISTS idx_videos_published_at ON videos(published_at)",
    },
    RetiredIndex {
        name: "idx_videos_has_comments",
        since: BASELINE_SCHEMA_VERSION,
        retired_in: 20,
        ddl: "CREATE INDEX IF NOT EXISTS idx_videos_has_comments ON videos(has_comments)",
    },
    RetiredIndex {
        name: "idx_videos_is_live",
        since: BASELINE_SCHEMA_VERSION,
        retired_in: 20,
        ddl: "CREATE INDEX IF NOT EXISTS idx_videos_is_live ON videos(is_live)",
    },
    RetiredIndex {
        name: "idx_videos_has_live_chat",
        since: BASELINE_SCHEMA_VERSION,
        retired_in: 20,
        ddl: "CREATE INDEX IF NOT EXISTS idx_videos_has_live_chat ON videos(has_live_chat)",
    },
];

// The partial UNIQUE index enforcing "no duplicate (video_id, comment_id)". Deliberately kept OUT
// of INDEX_DDLS. Unlike every other index there, building it can fail on real data. A database
// created before this invariant lived in the schema (v10) may already hold a duplicate the unique
// build rejects, so it must be created only by apply_migration_10 (which collapses duplicates
// first), and never by the baseline / index-only loops that run before v10. apply_baseline_schema's
// loop runs for every legacy database (user_version below the baseline), so keeping this index in
// INDEX_DDLS made the baseline try to build it against un-deduped rows. The build failed, the whole
// baseline transaction rolled back, and the database was left permanently unopenable, with the
// migration meant to dedupe it never reached. Partial so the many replies yt-dlp leaves without an
// id (comment_id NULL/blank) stay legitimately distinct rows, mirroring
// idx_videos_channel_youtube_video_id_unique (which is safe in INDEX_DDLS because it predates any
// data that could violate it. There is no later migration that first had to dedupe videos).
pub(super) const COMMENT_UNIQUE_INDEX_TABLE: &str = "video_comments";
pub(crate) const COMMENT_UNIQUE_INDEX_DDL: &str = "CREATE UNIQUE INDEX IF NOT EXISTS idx_video_comments_video_comment_unique ON video_comments(video_id, comment_id) WHERE comment_id IS NOT NULL AND TRIM(comment_id) <> ''";

// Every trigger, paired with the table it belongs to (same shape as INDEX_DDLS). These backport
// the videos live-chat CHECK to databases whose `videos` table predates it. A table created by an
// older app version already exists, so the CHECK in VIDEOS_TABLE_DDL never reaches it (CREATE TABLE
// IF NOT EXISTS is a no-op and SQLite has no ALTER TABLE ADD CONSTRAINT), and rebuilding the main
// table just to add a CHECK is not worth its risk. A BEFORE INSERT/UPDATE trigger enforces the same
// invariant with a plain CREATE TRIGGER on the existing table. On a fresh database the CHECK is the
// primary guard and these are a harmless redundant net. Dropping a table drops its triggers, so a
// future table rebuild recreates the rebuilt table's triggers from this list, exactly as it does
// its indexes.
pub(super) const TRIGGER_DDLS: &[(&str, &str)] = &[
    (
        "videos",
        "CREATE TRIGGER IF NOT EXISTS trg_videos_live_chat_requires_path_insert \
        BEFORE INSERT ON videos \
        WHEN NEW.has_live_chat <> 0 AND NEW.live_chat_file_path IS NULL \
        BEGIN \
            SELECT RAISE(ABORT, 'has_live_chat is set but live_chat_file_path is null'); \
        END",
    ),
    (
        "videos",
        "CREATE TRIGGER IF NOT EXISTS trg_videos_live_chat_requires_path_update \
        BEFORE UPDATE ON videos \
        WHEN NEW.has_live_chat <> 0 AND NEW.live_chat_file_path IS NULL \
        BEGIN \
            SELECT RAISE(ABORT, 'has_live_chat is set but live_chat_file_path is null'); \
        END",
    ),
    // title_normalized is the accent/case-folded copy of `title` that the library search matches
    // against and the title sort orders by. A NULL there is invisible rather than loud. `LIKE`
    // never matches it, so the media silently disappears from every title search while still
    // sitting in the library. insert_media and update_media_title both derive it from the same
    // title, so the write path cannot produce a NULL. These keep an out-of-band writer from
    // introducing one. The column itself stays nullable. It is added to pre-v11 databases by
    // ALTER TABLE, which cannot add a NOT NULL column without inventing a default for the rows
    // already there, and v11 is what backfills them.
    (
        "videos",
        "CREATE TRIGGER IF NOT EXISTS trg_videos_title_normalized_not_null_insert \
        BEFORE INSERT ON videos \
        WHEN NEW.title_normalized IS NULL \
        BEGIN \
            SELECT RAISE(ABORT, 'title_normalized is null'); \
        END",
    ),
    (
        "videos",
        "CREATE TRIGGER IF NOT EXISTS trg_videos_title_normalized_not_null_update \
        BEFORE UPDATE ON videos \
        WHEN NEW.title_normalized IS NULL \
        BEGIN \
            SELECT RAISE(ABORT, 'title_normalized is null'); \
        END",
    ),
    // Enforce the comment-body length ceiling on databases whose video_comments table predates the
    // CHECK (the CHECK in VIDEO_COMMENTS_TABLE_DDL only reaches fresh installs). Same 16000-char
    // ceiling as media_comments::MAX_COMMENT_TEXT_CHARS, installed by migration v14.
    (
        "video_comments",
        "CREATE TRIGGER IF NOT EXISTS trg_video_comments_text_length_insert \
        BEFORE INSERT ON video_comments \
        WHEN LENGTH(NEW.text) > 16000 \
        BEGIN \
            SELECT RAISE(ABORT, 'comment text exceeds the maximum length'); \
        END",
    ),
    (
        "video_comments",
        "CREATE TRIGGER IF NOT EXISTS trg_video_comments_text_length_update \
        BEFORE UPDATE ON video_comments \
        WHEN LENGTH(NEW.text) > 16000 \
        BEGIN \
            SELECT RAISE(ABORT, 'comment text exceeds the maximum length'); \
        END",
    ),
];

/// Additive columns for the channels table, added to a table that predates them by the migration
/// named beside each.
pub(super) const CHANNELS_ADDITIVE_COLUMNS: &[(&str, &str)] = &[
    // v18.
    (
        "banner_path",
        "TEXT CHECK (banner_path IS NULL OR TRIM(banner_path) <> '')",
    ),
];

/// Additive columns for the video_comments table, added to a table that predates them by the
/// migration named beside each.
pub(super) const VIDEO_COMMENTS_ADDITIVE_COLUMNS: &[(&str, &str)] = &[
    // v17.
    (
        "original_text",
        "TEXT CHECK (original_text IS NULL OR LENGTH(original_text) <= 16000)",
    ),
];

/// Additive columns for the videos table. Fresh databases already get these from the
/// base CREATE TABLE. The guarded ALTERs only add them to databases created by older
/// app versions that predate the columns.
pub(super) const VIDEOS_ADDITIVE_COLUMNS: &[(&str, &str)] = &[
    ("is_live", "INTEGER NOT NULL DEFAULT 0"),
    ("has_live_chat", "INTEGER NOT NULL DEFAULT 0"),
    (
        "live_chat_file_path",
        "TEXT CHECK (live_chat_file_path IS NULL OR TRIM(live_chat_file_path) <> '')",
    ),
    // Accent/case-folded copy of `title` for the server-side library search and title sort.
    // Nullable and backfilled by migration v11 (SQLite cannot accent-fold in SQL, so the
    // backfill is computed in Rust), populated on every insert/title-update thereafter.
    ("title_normalized", "TEXT"),
    // Added by v15. Defaults to 'unknown' for every existing row, which is the honest value.
    // Nothing recorded whether a fetch had run, so the app cannot claim one did. v15 promotes
    // the rows that do carry evidence.
    (
        "comments_state",
        "TEXT NOT NULL DEFAULT 'unknown' CHECK (comments_state IN ('unknown', 'none', 'available'))",
    ),
];
