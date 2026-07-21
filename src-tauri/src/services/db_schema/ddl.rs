//! The schema's DDL as data: the `CREATE TABLE`/index/trigger statements and the additive-column
//! list the migrations in the parent module apply. Pure constants with no logic, split out so the
//! migration code reads as migration steps rather than being buried under the SQL text. `pub(super)`
//! so the parent (and its tests, via `super::*`) reach them.

pub(super) const CHANNELS_TABLE_DDL: &str = "CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (TRIM(name) <> ''),
    youtube_handle TEXT NOT NULL UNIQUE CHECK (TRIM(youtube_handle) <> ''),
    avatar_path TEXT CHECK (avatar_path IS NULL OR TRIM(avatar_path) <> ''),
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
    text TEXT NOT NULL,
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

// Every index, paired with the table it belongs to. The baseline and versioned migrations
// recreate all of them (every table exists at that point); the table-rebuild path uses the
// pairing to recreate only the indexes of the tables it actually dropped, since dropping a
// table only drops that table's indexes.
pub(super) const INDEX_DDLS: &[(&str, &str)] = &[
    ("videos", "CREATE INDEX IF NOT EXISTS idx_videos_channel_id ON videos(channel_id)"),
    // Covers a channel's media newest-first (channel_id = ? ORDER BY created_at DESC, id DESC)
    // without a separate sort step. Its original caller (the unpaginated list_media_by_channel)
    // was removed; the paginated list_media_page sorts include title_normalized and are served by
    // the composite indexes below, not this one. Kept because dropping it entangles the v8
    // migration identity and its dedicated idempotency test - a standalone cleanup, not part of
    // removing that caller - and it still fits any future newest-first-only listing.
    ("videos", "CREATE INDEX IF NOT EXISTS idx_videos_channel_created_id ON videos(channel_id, created_at DESC, id DESC)"),
    // Serves the title-sorted page of a channel's media (the paginated library list ordering by
    // title_normalized within a channel), so that sort does not filesort the whole channel.
    ("videos", "CREATE INDEX IF NOT EXISTS idx_videos_channel_title_normalized ON videos(channel_id, title_normalized)"),
    // One index per `list_media_page` sort category, each mirroring that category's ORDER BY
    // exactly (see video_repository::resolve_order_by). SQLite only walks an index in ORDER BY
    // order when the leading terms match term for term, so `duration` and `publication_date`
    // must index the same COALESCE/CASE *expressions* the clause sorts on - a plain index on
    // duration_seconds or published_at is never used by those queries. Measured with EXPLAIN
    // QUERY PLAN: without these, every one of these sorts falls back to idx_videos_channel_id
    // and re-sorts the channel's whole matching set on each page.
    ("videos", "CREATE INDEX IF NOT EXISTS idx_videos_channel_created_title_id ON videos(channel_id, created_at DESC, title_normalized DESC, id DESC)"),
    ("videos", "CREATE INDEX IF NOT EXISTS idx_videos_channel_comments_count ON videos(channel_id, comments_count, title_normalized)"),
    ("videos", "CREATE INDEX IF NOT EXISTS idx_videos_channel_duration ON videos(channel_id, COALESCE(duration_seconds, 0), title_normalized)"),
    ("videos", "CREATE INDEX IF NOT EXISTS idx_videos_channel_published_ordered ON videos(channel_id, (CASE WHEN published_at IS NOT NULL AND TRIM(published_at) <> '' THEN 0 ELSE 1 END), (CASE WHEN published_at IS NOT NULL AND TRIM(published_at) <> '' THEN published_at END), title_normalized)"),
    // `publication_date` needs a second index because its two directions are not mirror images:
    // desc keeps the dated-first group key ASC and the title tie-break ASC while reversing only
    // the date. SQLite can walk an index forwards or backwards, but not partly each way, so the
    // all-ASC index above serves only the leading group key for desc and sorts the remaining
    // three terms - and desc is the grid's default view, i.e. the hottest query in the app.
    // The term directions here mirror that clause exactly.
    ("videos", "CREATE INDEX IF NOT EXISTS idx_videos_channel_published_desc ON videos(channel_id, (CASE WHEN published_at IS NOT NULL AND TRIM(published_at) <> '' THEN 0 ELSE 1 END) ASC, (CASE WHEN published_at IS NOT NULL AND TRIM(published_at) <> '' THEN published_at END) DESC, title_normalized ASC)"),
    ("channels", "CREATE INDEX IF NOT EXISTS idx_channels_youtube_handle ON channels(youtube_handle)"),
    ("channels", "CREATE INDEX IF NOT EXISTS idx_channels_avatar_path ON channels(avatar_path)"),
    ("videos", "CREATE INDEX IF NOT EXISTS idx_videos_thumbnail_path ON videos(thumbnail_path)"),
    // Serves the artifact reference-count lookups run on every media/channel delete
    // (WHERE file_path = ? / WHERE live_chat_file_path = ?). The table's (channel_id, file_path)
    // UNIQUE constraint already provides the auto-index that backs the insert_media upsert's
    // ON CONFLICT(channel_id, file_path), but that composite index cannot serve a bare
    // `file_path =` predicate without the leading `channel_id`, so a dedicated single-column
    // index is needed to keep deletes off a full table scan.
    ("videos", "CREATE INDEX IF NOT EXISTS idx_videos_file_path ON videos(file_path)"),
    ("videos", "CREATE INDEX IF NOT EXISTS idx_videos_live_chat_file_path ON videos(live_chat_file_path)"),
    ("videos", "CREATE INDEX IF NOT EXISTS idx_videos_channel_thumb ON videos(channel_id, thumbnail_path)"),
    ("videos", "CREATE INDEX IF NOT EXISTS idx_videos_youtube_video_id ON videos(youtube_video_id)"),
    ("videos", "CREATE INDEX IF NOT EXISTS idx_videos_watched_at ON videos(watched_at)"),
    ("videos", "CREATE INDEX IF NOT EXISTS idx_videos_published_at ON videos(published_at)"),
    ("videos", "CREATE INDEX IF NOT EXISTS idx_videos_has_comments ON videos(has_comments)"),
    ("videos", "CREATE INDEX IF NOT EXISTS idx_videos_is_live ON videos(is_live)"),
    ("videos", "CREATE INDEX IF NOT EXISTS idx_videos_has_live_chat ON videos(has_live_chat)"),
    ("videos", "CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_channel_youtube_video_id_unique ON videos(channel_id, youtube_video_id) WHERE youtube_video_id IS NOT NULL AND TRIM(youtube_video_id) <> ''"),
    ("video_comments", "CREATE INDEX IF NOT EXISTS idx_video_comments_video_id ON video_comments(video_id)"),
    ("video_comments", "CREATE INDEX IF NOT EXISTS idx_video_comments_parent_comment_id ON video_comments(parent_comment_id)"),
    ("video_comments", "CREATE INDEX IF NOT EXISTS idx_video_comments_comment_id ON video_comments(comment_id)"),
];

// The partial UNIQUE index enforcing "no duplicate (video_id, comment_id)". Deliberately kept OUT
// of INDEX_DDLS: unlike every other index there, building it can fail on real data. A database
// created before this invariant lived in the schema (v10) may already hold a duplicate the unique
// build rejects, so it must be created only by apply_migration_10 - which collapses duplicates
// first - and never by the baseline / index-only loops that run before v10. apply_baseline_schema's
// loop runs for every legacy database (user_version below the baseline), so keeping this index in
// INDEX_DDLS made the baseline try to build it against un-deduped rows: the build failed, the whole
// baseline transaction rolled back, and the database was left permanently unopenable, with the
// migration meant to dedupe it never reached. Partial so the many replies yt-dlp leaves without an
// id (comment_id NULL/blank) stay legitimately distinct rows, mirroring
// idx_videos_channel_youtube_video_id_unique (which is safe in INDEX_DDLS because it predates any
// data that could violate it - there is no later migration that first had to dedupe videos).
pub(super) const COMMENT_UNIQUE_INDEX_TABLE: &str = "video_comments";
pub(super) const COMMENT_UNIQUE_INDEX_DDL: &str = "CREATE UNIQUE INDEX IF NOT EXISTS idx_video_comments_video_comment_unique ON video_comments(video_id, comment_id) WHERE comment_id IS NOT NULL AND TRIM(comment_id) <> ''";

// Every trigger, paired with the table it belongs to (same shape as INDEX_DDLS). These backport
// the videos live-chat CHECK to databases whose `videos` table predates it: a table created by an
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
    // against and the title sort orders by. A NULL there is invisible rather than loud: `LIKE`
    // never matches it, so the media silently disappears from every title search while still
    // sitting in the library. insert_media and update_media_title both derive it from the same
    // title, so the write path cannot produce a NULL - these keep an out-of-band writer from
    // introducing one. The column itself stays nullable: it is added to pre-v11 databases by
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
];

/// Additive columns for the videos table. Fresh databases already get these from the
/// base CREATE TABLE; the guarded ALTERs only add them to databases created by older
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
    // backfill is computed in Rust); populated on every insert/title-update thereafter.
    ("title_normalized", "TEXT"),
];
