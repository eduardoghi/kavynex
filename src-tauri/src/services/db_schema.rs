use sqlx::{Connection, SqliteConnection, SqlitePool};

use crate::services::database::db_error;
use crate::{AppError, AppErrorCode, AppResult};

/// Current schema version. Bump this and add a matching migration block in
/// `ensure_schema` whenever the schema changes.
pub(crate) const SCHEMA_VERSION: i64 = 13;

/// Version produced by the idempotent baseline reconcile (`apply_baseline_schema`).
/// It stays fixed even as `SCHEMA_VERSION` grows: every database created before
/// versioned migrations existed sits at `user_version <= 6`, so the baseline runs
/// exactly once to bring it here, and real migrations take over from 8 onward.
const BASELINE_SCHEMA_VERSION: i64 = 7;

const CHANNELS_TABLE_DDL: &str = "CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (TRIM(name) <> ''),
    youtube_handle TEXT NOT NULL UNIQUE CHECK (TRIM(youtube_handle) <> ''),
    avatar_path TEXT CHECK (avatar_path IS NULL OR TRIM(avatar_path) <> ''),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
)";

const VIDEOS_TABLE_DDL: &str = "CREATE TABLE IF NOT EXISTS videos (
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

const VIDEO_COMMENTS_TABLE_DDL: &str = "CREATE TABLE IF NOT EXISTS video_comments (
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

const APP_SETTINGS_TABLE_DDL: &str = "CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)";

const TABLE_DDLS: &[&str] = &[
    CHANNELS_TABLE_DDL,
    VIDEOS_TABLE_DDL,
    VIDEO_COMMENTS_TABLE_DDL,
    APP_SETTINGS_TABLE_DDL,
];

// Tables created by older app versions that are no longer used. Live chat is stored as
// JSON files in the app data directory, never in the database, so this table was always
// empty. Dropped on startup to remove it from existing databases.
const LEGACY_TABLE_DROPS: &[&str] = &["DROP TABLE IF EXISTS video_live_chat_messages"];

// Every index, paired with the table it belongs to. The baseline and versioned migrations
// recreate all of them (every table exists at that point); the table-rebuild path uses the
// pairing to recreate only the indexes of the tables it actually dropped, since dropping a
// table only drops that table's indexes.
const INDEX_DDLS: &[(&str, &str)] = &[
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
    // Moves the "no duplicate (video_id, comment_id)" invariant out of application code
    // (media_comments::dedupe_comments_by_id) and into the schema. Partial so the many replies
    // yt-dlp leaves without an id (comment_id NULL/blank) stay legitimately distinct rows,
    // mirroring idx_videos_channel_youtube_video_id_unique.
    ("video_comments", "CREATE UNIQUE INDEX IF NOT EXISTS idx_video_comments_video_comment_unique ON video_comments(video_id, comment_id) WHERE comment_id IS NOT NULL AND TRIM(comment_id) <> ''"),
];

// Every trigger, paired with the table it belongs to (same shape as INDEX_DDLS). These backport
// the videos live-chat CHECK to databases whose `videos` table predates it: a table created by an
// older app version already exists, so the CHECK in VIDEOS_TABLE_DDL never reaches it (CREATE TABLE
// IF NOT EXISTS is a no-op and SQLite has no ALTER TABLE ADD CONSTRAINT), and rebuilding the main
// table just to add a CHECK is not worth its risk. A BEFORE INSERT/UPDATE trigger enforces the same
// invariant with a plain CREATE TRIGGER on the existing table. On a fresh database the CHECK is the
// primary guard and these are a harmless redundant net. Dropping a table drops its triggers, so a
// future table rebuild recreates the rebuilt table's triggers from this list, exactly as it does
// its indexes.
const TRIGGER_DDLS: &[(&str, &str)] = &[
    ("videos", "CREATE TRIGGER IF NOT EXISTS trg_videos_live_chat_requires_path_insert \
        BEFORE INSERT ON videos \
        WHEN NEW.has_live_chat <> 0 AND NEW.live_chat_file_path IS NULL \
        BEGIN \
            SELECT RAISE(ABORT, 'has_live_chat is set but live_chat_file_path is null'); \
        END"),
    ("videos", "CREATE TRIGGER IF NOT EXISTS trg_videos_live_chat_requires_path_update \
        BEFORE UPDATE ON videos \
        WHEN NEW.has_live_chat <> 0 AND NEW.live_chat_file_path IS NULL \
        BEGIN \
            SELECT RAISE(ABORT, 'has_live_chat is set but live_chat_file_path is null'); \
        END"),
    // title_normalized is the accent/case-folded copy of `title` that the library search matches
    // against and the title sort orders by. A NULL there is invisible rather than loud: `LIKE`
    // never matches it, so the media silently disappears from every title search while still
    // sitting in the library. insert_media and update_media_title both derive it from the same
    // title, so the write path cannot produce a NULL - these keep an out-of-band writer from
    // introducing one. The column itself stays nullable: it is added to pre-v11 databases by
    // ALTER TABLE, which cannot add a NOT NULL column without inventing a default for the rows
    // already there, and v11 is what backfills them.
    ("videos", "CREATE TRIGGER IF NOT EXISTS trg_videos_title_normalized_not_null_insert \
        BEFORE INSERT ON videos \
        WHEN NEW.title_normalized IS NULL \
        BEGIN \
            SELECT RAISE(ABORT, 'title_normalized is null'); \
        END"),
    ("videos", "CREATE TRIGGER IF NOT EXISTS trg_videos_title_normalized_not_null_update \
        BEFORE UPDATE ON videos \
        WHEN NEW.title_normalized IS NULL \
        BEGIN \
            SELECT RAISE(ABORT, 'title_normalized is null'); \
        END"),
];

/// Additive columns for the videos table. Fresh databases already get these from the
/// base CREATE TABLE; the guarded ALTERs only add them to databases created by older
/// app versions that predate the columns.
const VIDEOS_ADDITIVE_COLUMNS: &[(&str, &str)] = &[
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

pub(crate) async fn table_has_column<'e, E>(
    executor: E,
    table: &'static str,
    column: &'static str,
) -> AppResult<bool>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    // `table` is interpolated into raw SQL (pragma_table_info cannot be parameterized). The
    // `&'static str` bound is what keeps that safe: a runtime-built String (e.g. anything derived
    // from user input) cannot be passed here without leaking it, so by construction only internal
    // schema constants ever reach this interpolation - the invariant is enforced by the type, not
    // by a comment.
    let rows: Vec<(String,)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT name FROM pragma_table_info('{table}')"
    )))
    .fetch_all(executor)
    .await
    .map_err(|error| db_error("failed to read table columns", error))?;

    Ok(rows.iter().any(|(name,)| name == column))
}

/// True when `table` has a UNIQUE index whose columns are exactly `columns`, in order - whether it
/// comes from a table-level UNIQUE constraint (an auto-index) or an explicit `CREATE UNIQUE INDEX`.
///
/// Used to validate an imported database: `insert_media`'s `ON CONFLICT(channel_id, file_path)`
/// upsert needs this unique index to exist, and a namesake database carrying the right columns but
/// no such index would be accepted and then fail every insert at runtime. The index name is never
/// interpolated - it flows from `pragma_index_list` into `pragma_index_info` through the join - so
/// a crafted index name in the untrusted import file cannot inject SQL. `table` is a `&'static str`
/// constant, safe to interpolate for the same reason as `table_has_column`.
pub(crate) async fn table_has_unique_index_on(
    pool: &SqlitePool,
    table: &'static str,
    columns: &[&str],
) -> AppResult<bool> {
    let rows: Vec<(String, i64, String)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT il.name, ii.seqno, ii.name \
         FROM pragma_index_list('{table}') AS il \
         JOIN pragma_index_info(il.name) AS ii \
         WHERE il.\"unique\" = 1"
    )))
    .fetch_all(pool)
    .await
    .map_err(|error| db_error("failed to read table indexes", error))?;

    let mut by_index: std::collections::BTreeMap<String, Vec<(i64, String)>> =
        std::collections::BTreeMap::new();
    for (index_name, seqno, column) in rows {
        by_index.entry(index_name).or_default().push((seqno, column));
    }

    for index_columns in by_index.values_mut() {
        index_columns.sort_by_key(|(seqno, _)| *seqno);

        if index_columns.len() == columns.len()
            && index_columns
                .iter()
                .zip(columns)
                .all(|((_, got), want)| got == want)
        {
            return Ok(true);
        }
    }

    Ok(false)
}

/// True when `table` declares a FOREIGN KEY on `column` that references `parent` with
/// `ON DELETE CASCADE`.
///
/// Used to validate an imported database: `PRAGMA foreign_keys` only enforces the foreign keys a
/// table's DDL actually declares - it never adds a missing one - so a namesake database whose
/// videos table lacks this cascade would be accepted and then silently orphan a channel's videos
/// and their comments when the channel is deleted. `table` is a `&'static str` constant (safe to
/// interpolate); `column` and `parent` are bound.
pub(crate) async fn table_has_cascade_foreign_key(
    pool: &SqlitePool,
    table: &'static str,
    column: &str,
    parent: &str,
) -> AppResult<bool> {
    let (count,): (i64,) = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*) FROM pragma_foreign_key_list('{table}') \
         WHERE \"table\" = ? AND \"from\" = ? AND \"on_delete\" = 'CASCADE'"
    )))
    .bind(parent)
    .bind(column)
    .fetch_one(pool)
    .await
    .map_err(|error| db_error("failed to read table foreign keys", error))?;

    Ok(count > 0)
}

async fn ensure_videos_additive_columns(conn: &mut SqliteConnection) -> AppResult<()> {
    for (column, definition) in VIDEOS_ADDITIVE_COLUMNS {
        if !table_has_column(&mut *conn, "videos", column).await? {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "ALTER TABLE videos ADD COLUMN {column} {definition}"
            )))
            .execute(&mut *conn)
            .await
            .map_err(|error| db_error("failed to add videos column", error))?;
        }
    }

    Ok(())
}

async fn read_user_version(pool: &SqlitePool) -> AppResult<i64> {
    let (version,): (i64,) = sqlx::query_as("PRAGMA user_version")
        .fetch_one(pool)
        .await
        .map_err(|error| db_error("failed to read schema version", error))?;

    Ok(version)
}

async fn set_user_version(conn: &mut SqliteConnection, version: i64) -> AppResult<()> {
    // PRAGMA does not accept bound parameters; `version` is an internal integer
    // constant, never user input, so interpolation is safe. Setting user_version
    // participates in the surrounding transaction, so it commits or rolls back
    // atomically with the migration DDL.
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA user_version = {version}"
    )))
    .execute(&mut *conn)
    .await
    .map_err(|error| db_error("failed to set schema version", error))?;

    Ok(())
}

/// Brings the database up to `SCHEMA_VERSION`, applying only the migrations the
/// on-disk `user_version` is missing. Idempotent and safe to run on every startup:
/// a database already at `SCHEMA_VERSION` is left untouched. Runs as part of the
/// shared pool initialization, so it completes before any query executes.
///
/// `user_version` is authoritative. Each migration runs in its own transaction that
/// also stamps the new `user_version`, so a crash leaves the database fully at the
/// previous version or fully at the next one, never half-migrated. A database whose
/// `user_version` is higher than this build supports is refused rather than
/// downgraded, so an older build can never silently corrupt a newer schema.
pub async fn ensure_schema(pool: &SqlitePool) -> AppResult<()> {
    let current_version = read_user_version(pool).await?;

    if current_version > SCHEMA_VERSION {
        // Distinct code (not the generic db_error): the frontend must tell "this build is too
        // old to open a newer database" apart from real corruption, so it can advise updating
        // instead of offering a destructive restore-from-backup.
        return Err(AppError::from_code_with_details(
            AppErrorCode::DatabaseSchemaTooNew,
            "database was created by a newer version of the app",
            format!(
                "on-disk schema version {current_version} is newer than the supported version {SCHEMA_VERSION}; update Kavynex to open this library"
            ),
        ));
    }

    // Baseline (versions 0..=6 -> 7): the idempotent reconcile that predates versioned
    // migrations. Every legacy and fresh database goes through this exactly once.
    if current_version < BASELINE_SCHEMA_VERSION {
        apply_baseline_schema(pool).await?;
    }

    // v8: adds idx_videos_channel_created_id. Additive, so it just runs the index DDLs.
    if current_version < 8 {
        apply_migration_8(pool).await?;
    }

    // v9: adds idx_videos_file_path and idx_videos_live_chat_file_path. Additive, so it just
    // runs the index DDLs.
    if current_version < 9 {
        apply_migration_9(pool).await?;
    }

    // v10: adds the partial unique index on (video_id, comment_id). A pre-v10 database could in
    // principle already hold a duplicate the index would reject, so this migration first collapses
    // any duplicate comment rows and only then builds the index (see apply_migration_10).
    if current_version < 10 {
        apply_migration_10(pool).await?;
    }

    // v11: adds the `title_normalized` column (accent/case-folded title) plus its index, and
    // backfills the column for existing rows. Not index-only: the backfill is computed in Rust
    // because SQLite cannot accent-fold in SQL (see apply_migration_11).
    if current_version < 11 {
        apply_migration_11(pool).await?;
    }

    // v12: adds the per-sort-category indexes for `list_media_page`.
    if current_version < 12 {
        apply_migration_12(pool).await?;
    }

    // v13: enforces the videos live-chat invariant on databases whose table predates the CHECK.
    // Repairs any already-inconsistent row, then adds the enforcement triggers. Not index-only,
    // but still additive (no table rebuild) - see apply_migration_13.
    if current_version < 13 {
        apply_migration_13(pool).await?;
    }

    // Each migration is guarded by version and transactional (it stamps the new
    // user_version inside its own transaction, so a crash leaves the database fully at the
    // old or the new version). An additive migration (a new column or index) runs the
    // guarded ALTER/CREATE like `apply_migration_8`. Enforcing a new invariant on an existing
    // table can often stay additive too: `apply_migration_13` backports the videos live-chat
    // CHECK with a trigger rather than a rebuild. A change that genuinely rewrites the table -
    // a column type, dropping a column, replacing a UNIQUE - cannot be expressed with
    // `ALTER TABLE ADD COLUMN` or a trigger, so it rebuilds the affected table with
    // `apply_table_rebuilds` (create new, copy, drop, rename - with foreign keys disabled and
    // verified) instead of being silently skipped by the additive baseline above.

    Ok(())
}

/// Applies an additive, index-only migration: re-runs every index DDL (all guarded with
/// `IF NOT EXISTS`, so pre-existing indexes are untouched and only the ones this version adds
/// are created) and stamps `target_version`, both in the same transaction so a crash leaves
/// the database fully at the old or the new version.
async fn apply_index_only_migration(pool: &SqlitePool, target_version: i64) -> AppResult<()> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| db_error("failed to begin schema migration", error))?;

    for &(_, ddl) in INDEX_DDLS {
        sqlx::query(ddl)
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("failed to create index", error))?;
    }

    set_user_version(&mut tx, target_version).await?;

    tx.commit()
        .await
        .map_err(|error| db_error("failed to commit schema migration", error))?;

    Ok(())
}

/// v8: creates `idx_videos_channel_created_id`. Additive, so it reaches databases created
/// before v8 by re-running the guarded index DDLs.
async fn apply_migration_8(pool: &SqlitePool) -> AppResult<()> {
    apply_index_only_migration(pool, 8).await
}

/// v9: creates `idx_videos_file_path` and `idx_videos_live_chat_file_path`, which keep the
/// per-artifact reference-count lookups run on delete off a full table scan. Additive, so it
/// reaches databases created before v9 by re-running the guarded index DDLs.
async fn apply_migration_9(pool: &SqlitePool) -> AppResult<()> {
    apply_index_only_migration(pool, 9).await
}

/// v12: creates the four `list_media_page` sort indexes (`idx_videos_channel_created_title_id`,
/// `idx_videos_channel_comments_count`, `idx_videos_channel_duration`,
/// `idx_videos_channel_published_ordered`). Additive, so it reaches databases created before v12
/// by re-running the guarded index DDLs.
async fn apply_migration_12(pool: &SqlitePool) -> AppResult<()> {
    apply_index_only_migration(pool, 12).await
}

/// v13: brings the videos row invariants to databases whose `videos` table predates them - the
/// live-chat one (has_live_chat set implies a stored live_chat_file_path) and the
/// title_normalized one (never NULL).
///
/// Such a database's `videos` table already exists, so the CHECK in VIDEOS_TABLE_DDL never reached
/// it (CREATE TABLE IF NOT EXISTS is a no-op and SQLite cannot add a CHECK to an existing table
/// without rebuilding it). Rather than rebuild the largest table just to add a CHECK, this repairs
/// any row that already violates an invariant and installs BEFORE INSERT/UPDATE triggers that
/// reject future violations - a plain `CREATE TRIGGER` on the existing table, touching no row
/// content.
///
/// Neither repair destroys anything: the live-chat one only clears `has_live_chat` where no path is
/// stored (correcting a flag to match the absent file), and the title one only computes a value for
/// rows that have none. Both must run before the triggers, which fire only on new writes and would
/// otherwise leave a pre-existing bad row in place - and, worse for the title one, would then
/// reject every later edit of that row's title. The repairs, the trigger creation and the version
/// stamp share one transaction, so a crash leaves the database fully at v12 or fully at v13.
async fn apply_migration_13(pool: &SqlitePool) -> AppResult<()> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| db_error("failed to begin schema migration", error))?;

    // Correct any row that predates the invariant: the flag says a live chat exists but no path is
    // stored, so the truth is there is none. Clears only the flag, never a path or the row.
    sqlx::query(
        "UPDATE videos SET has_live_chat = 0 \
         WHERE has_live_chat <> 0 \
           AND (live_chat_file_path IS NULL OR TRIM(live_chat_file_path) = '')",
    )
    .execute(&mut *tx)
    .await
    .map_err(|error| db_error("failed to repair inconsistent live chat flags", error))?;

    // The backfill below reads title_normalized, so make sure the column is there rather than
    // assuming the v11 that adds it has run. In the normal order it has - but a database stamped
    // past v11 without the column (hand-edited, an import) would otherwise fail the whole migration
    // with "no such column" instead of being repaired. Idempotent, exactly as in v11.
    ensure_videos_additive_columns(&mut tx).await?;

    // v11 backfilled title_normalized, but only databases below v11 ever run it: a row that arrived
    // with a NULL afterwards (an imported database, an out-of-band writer) is never reached again
    // and stays invisible to every title search. Sweep those up once here, before the trigger below
    // starts refusing them.
    let repaired_titles = backfill_missing_title_normalized(&mut tx).await?;

    if repaired_titles > 0 {
        crate::services::logger::warn(
            "db_schema",
            format!(
                "v13: computed the missing normalized title of {repaired_titles} row(s); they were invisible to library search"
            ),
        );
    }

    for &(_, ddl) in TRIGGER_DDLS {
        sqlx::query(ddl)
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("failed to create trigger", error))?;
    }

    set_user_version(&mut tx, 13).await?;

    tx.commit()
        .await
        .map_err(|error| db_error("failed to commit schema migration", error))?;

    Ok(())
}

/// v10: creates `idx_video_comments_video_comment_unique`, moving the "no duplicate
/// (video_id, comment_id)" invariant out of application code (media_comments::
/// dedupe_comments_by_id) and into the schema. Unlike the index-only migrations above it cannot
/// blindly run the DDLs: a database created before this index could in principle hold a duplicate
/// that would fail the unique build. So it first collapses any duplicate rows to the lowest id,
/// then runs the guarded index DDLs, both in one transaction so a crash leaves the database fully
/// at the old or the new version. The single write path (replace_media_comments) already dedups
/// per payload, so the cleanup is a safety net, not an expected case.
async fn apply_migration_10(pool: &SqlitePool) -> AppResult<()> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| db_error("failed to begin schema migration", error))?;

    // Back the duplicate-detection GROUP BY (below) with a temporary index covering
    // (video_id, comment_id, id) so the one-time cleanup answers MIN(id) per group from the index
    // instead of full-scanning and sorting video_comments - which, on a user with a large comment
    // history, would otherwise make this startup migration noticeably slow. The real partial unique
    // index cannot stand in for it here: it is created by the INDEX_DDLS loop only after the
    // duplicates it would reject are gone. The temp index is dropped again before the loop runs.
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_video_comments_dedup_tmp \
         ON video_comments (video_id, comment_id, id)",
    )
    .execute(&mut *tx)
    .await
    .map_err(|error| db_error("failed to create temporary dedup index", error))?;

    sqlx::query(
        r#"
        DELETE FROM video_comments
        WHERE comment_id IS NOT NULL
          AND TRIM(comment_id) <> ''
          AND id NOT IN (
              SELECT MIN(id) FROM video_comments
              WHERE comment_id IS NOT NULL AND TRIM(comment_id) <> ''
              GROUP BY video_id, comment_id
          )
        "#,
    )
    .execute(&mut *tx)
    .await
    .map_err(|error| db_error("failed to collapse duplicate comments", error))?;

    sqlx::query("DROP INDEX IF EXISTS idx_video_comments_dedup_tmp")
        .execute(&mut *tx)
        .await
        .map_err(|error| db_error("failed to drop temporary dedup index", error))?;

    for &(_, ddl) in INDEX_DDLS {
        sqlx::query(ddl)
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("failed to create index", error))?;
    }

    set_user_version(&mut tx, 10).await?;

    tx.commit()
        .await
        .map_err(|error| db_error("failed to commit schema migration", error))?;

    Ok(())
}

/// v11: adds the `title_normalized` column and its index, and backfills the column for every
/// existing row.
///
/// `title_normalized` is the accent/case-folded copy of `title` the paginated library list
/// searches and title-sorts against. SQLite has no accent folding of its own, so the backfill is
/// computed in Rust with the same `utils::text::normalize_search_text` used at insert/update time
/// (that shared normalization is what keeps a search term and a stored title comparable). The
/// column-add, the per-row backfill and the index creation all run in one transaction that stamps
/// `user_version = 11`, so a crash leaves the database fully at v10 or fully at v11.
/// Computes `title_normalized` for every row that is still missing one, and reports how many rows
/// it repaired.
///
/// Shared by v11, which introduces the column, and v13, which sweeps up any row that arrived with a
/// NULL after v11 had already run (an imported database, an out-of-band writer) and would otherwise
/// never be reached: `ensure_schema` only runs the migrations above the stored version, so a
/// database stamped at v11 or later is never backfilled again.
///
/// SQLite has no accent folding of its own, so the value is computed in Rust with the same
/// `utils::text::normalize_search_text` used at insert/update time - that shared normalization is
/// what keeps a search term and a stored title comparable. Instead of one UPDATE round trip per row
/// (slow on a large library), the computed (id, normalized) pairs are staged into a temp table with
/// chunked multi-row inserts and applied with a single set-based UPDATE, mirroring the
/// chunked-insert idiom in media_comments.rs.
async fn backfill_missing_title_normalized(conn: &mut SqliteConnection) -> AppResult<usize> {
    let rows: Vec<(i64, String)> =
        sqlx::query_as("SELECT id, title FROM videos WHERE title_normalized IS NULL")
            .fetch_all(&mut *conn)
            .await
            .map_err(|error| {
                db_error(
                    "failed to read titles for the title_normalized backfill",
                    error,
                )
            })?;

    if !rows.is_empty() {
        sqlx::query(
            "CREATE TEMP TABLE _title_normalized_backfill (id INTEGER PRIMARY KEY, normalized TEXT NOT NULL)",
        )
        .execute(&mut *conn)
        .await
        .map_err(|error| db_error("failed to create the title_normalized backfill table", error))?;

        // Two bound parameters per row (id, normalized), so a chunk of this many rows stays well
        // under SQLite's bound-variable limit while collapsing thousands of single-row UPDATEs
        // into a handful of multi-row inserts plus one set-based UPDATE.
        const BACKFILL_CHUNK_ROWS: usize = 400;

        for chunk in rows.chunks(BACKFILL_CHUNK_ROWS) {
            // The only interpolation is the number of `(?, ?)` placeholder groups; every value is
            // bound, never interpolated, so the constructed statement is safe to assert.
            let mut insert_sql =
                String::from("INSERT INTO _title_normalized_backfill (id, normalized) VALUES ");
            for index in 0..chunk.len() {
                if index > 0 {
                    insert_sql.push(',');
                }
                insert_sql.push_str("(?, ?)");
            }

            let mut query = sqlx::query(sqlx::AssertSqlSafe(insert_sql));
            for (id, title) in chunk {
                let normalized = crate::utils::text::normalize_search_text(title);
                query = query.bind(*id).bind(normalized);
            }

            query.execute(&mut *conn).await.map_err(|error| {
                db_error("failed to stage the title_normalized backfill", error)
            })?;
        }

        sqlx::query(
            "UPDATE videos \
             SET title_normalized = ( \
                 SELECT normalized FROM _title_normalized_backfill \
                 WHERE _title_normalized_backfill.id = videos.id \
             ) \
             WHERE id IN (SELECT id FROM _title_normalized_backfill)",
        )
        .execute(&mut *conn)
        .await
        .map_err(|error| db_error("failed to apply the title_normalized backfill", error))?;

        sqlx::query("DROP TABLE _title_normalized_backfill")
            .execute(&mut *conn)
            .await
            .map_err(|error| {
                db_error("failed to drop the title_normalized backfill table", error)
            })?;
    }

    Ok(rows.len())
}

/// v11: adds the `title_normalized` column and its index, and backfills the column for every
/// existing row.
///
/// `title_normalized` is the accent/case-folded copy of `title` the paginated library list searches
/// and title-sorts against. The column-add, the per-row backfill and the index creation all run in
/// one transaction that stamps `user_version = 11`, so a crash leaves the database fully at v10 or
/// fully at v11.
async fn apply_migration_11(pool: &SqlitePool) -> AppResult<()> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| db_error("failed to begin schema migration", error))?;

    // A database created before v11 (v7..=v10, where the baseline no longer runs) lacks the
    // column; the guarded additive-columns path adds it. Idempotent on a database that already
    // has it.
    ensure_videos_additive_columns(&mut tx).await?;

    // On a fresh database this repairs nothing; on an upgrade it normalizes each existing title
    // once.
    backfill_missing_title_normalized(&mut tx).await?;

    for &(_, ddl) in INDEX_DDLS {
        sqlx::query(ddl)
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("failed to create index", error))?;
    }

    set_user_version(&mut tx, 11).await?;

    tx.commit()
        .await
        .map_err(|error| db_error("failed to commit schema migration", error))?;

    Ok(())
}

/// Creates every table, additive column and index if missing, then stamps
/// `BASELINE_SCHEMA_VERSION`. Because it uses `IF NOT EXISTS`/guarded `ALTER`s it is a
/// no-op on an already-current database, but the whole thing runs in one transaction so
/// a partial failure rolls back cleanly instead of leaving a half-built schema.
async fn apply_baseline_schema(pool: &SqlitePool) -> AppResult<()> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| db_error("failed to begin schema migration", error))?;

    for ddl in LEGACY_TABLE_DROPS {
        sqlx::query(*ddl)
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("failed to drop legacy table", error))?;
    }

    for ddl in TABLE_DDLS {
        sqlx::query(*ddl)
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("failed to create table", error))?;
    }

    ensure_videos_additive_columns(&mut tx).await?;

    for &(_, ddl) in INDEX_DDLS {
        sqlx::query(ddl)
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("failed to create index", error))?;
    }

    set_user_version(&mut tx, BASELINE_SCHEMA_VERSION).await?;

    tx.commit()
        .await
        .map_err(|error| db_error("failed to commit schema migration", error))?;

    Ok(())
}

/// Describes one table to rebuild. `new_ddl` is the full `CREATE TABLE <staging_table> (...)`
/// with the desired shape; `carried_columns` is the comma-separated list of columns present
/// in both the old and the new schema (a column the new schema adds is omitted so it takes
/// its default). All fields are internal schema constants, never user input.
///
/// Unused until the first non-additive migration ships; kept ready (and tested) so that
/// migration is a data change, not new untested plumbing.
#[allow(dead_code)]
pub(crate) struct TableRebuild {
    pub table: &'static str,
    pub staging_table: &'static str,
    pub new_ddl: &'static str,
    pub carried_columns: &'static str,
}

/// Rebuilds a single table to change what `ALTER TABLE ADD COLUMN` cannot express - a
/// CHECK, a UNIQUE, a column type, or a dropped column - following SQLite's documented
/// table-rebuild procedure: create the new shape under a staging name, copy the carried
/// columns across, drop the old table and rename the staging one into place.
///
/// The caller must run this inside a transaction on a connection with foreign keys disabled
/// (see [`apply_table_rebuilds`]): with enforcement on, `DROP TABLE` performs an implicit
/// delete of the table's rows, which would fire `ON DELETE CASCADE` on child tables and
/// wipe them out.
#[allow(dead_code)]
async fn rebuild_table(conn: &mut SqliteConnection, spec: &TableRebuild) -> AppResult<()> {
    sqlx::query(sqlx::AssertSqlSafe(spec.new_ddl))
        .execute(&mut *conn)
        .await
        .map_err(|error| db_error("failed to create the rebuilt table", error))?;

    // Identifiers and the column list are internal constants; DDL cannot bind parameters.
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO {} ({}) SELECT {} FROM {}",
        spec.staging_table, spec.carried_columns, spec.carried_columns, spec.table
    )))
    .execute(&mut *conn)
    .await
    .map_err(|error| db_error("failed to copy rows into the rebuilt table", error))?;

    sqlx::query(sqlx::AssertSqlSafe(format!("DROP TABLE {}", spec.table)))
        .execute(&mut *conn)
        .await
        .map_err(|error| db_error("failed to drop the old table during rebuild", error))?;

    sqlx::query(sqlx::AssertSqlSafe(format!(
        "ALTER TABLE {} RENAME TO {}",
        spec.staging_table, spec.table
    )))
    .execute(&mut *conn)
    .await
    .map_err(|error| db_error("failed to rename the rebuilt table into place", error))?;

    Ok(())
}

/// Applies one or more table rebuilds atomically and stamps `target_version`.
///
/// Foreign keys are disabled for the duration - required because a rebuild drops and
/// recreates tables that `ON DELETE CASCADE` children reference - then
/// `PRAGMA foreign_key_check` verifies the rebuilt schema introduced no dangling references
/// before the transaction commits. `PRAGMA foreign_keys` is a no-op inside a transaction,
/// so it is toggled on a dedicated pooled connection around the transaction, and enforcement
/// is always restored before that connection returns to the pool. The rebuilt tables' indexes
/// are recreated from `INDEX_DDLS` (all guarded with `IF NOT EXISTS`); other tables' indexes
/// are left in place since their tables were never dropped.
/// Owns the pooled connection a table rebuild runs on so that foreign-key enforcement can never
/// leak back into the pool in the OFF state. The rebuild runs with `PRAGMA foreign_keys = OFF`;
/// on the normal path enforcement is restored and `restored` is set, so `Drop` hands the
/// connection back to the pool as usual. If the restore fails - or the rebuild panics and unwinds
/// before the restore runs - `restored` stays false and `Drop` detaches (discards) the connection
/// instead, so the next consumer gets a fresh connection with foreign keys ON (from the pool's
/// connect options) rather than a reused one with enforcement silently off. `detach()` is
/// synchronous, so it is safe to call from `Drop` even though re-running the PRAGMA would not be.
#[allow(dead_code)]
struct RebuildConnection {
    conn: Option<sqlx::pool::PoolConnection<sqlx::Sqlite>>,
    restored: bool,
}

impl RebuildConnection {
    // Returns the guarded connection. Errors (rather than panics) if it was already taken - by
    // construction the connection is present until `Drop`, but returning a result keeps a future
    // caller's real upgrade path from aborting the process should that invariant ever break.
    fn conn(&mut self) -> AppResult<&mut SqliteConnection> {
        self.conn.as_deref_mut().ok_or_else(|| {
            db_error(
                "the schema rebuild connection was unavailable",
                "internal invariant broken: RebuildConnection::conn called after release",
            )
        })
    }
}

impl Drop for RebuildConnection {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            if self.restored {
                // Enforcement restored: hand the connection back to the pool normally.
                drop(conn);
            } else {
                // The restore never ran (a panic unwound through the rebuild) or failed: discard
                // the connection so a foreign_keys = OFF one is never reused.
                conn.detach();
            }
        }
    }
}

#[allow(dead_code)]
pub(crate) async fn apply_table_rebuilds(
    pool: &SqlitePool,
    rebuilds: &[TableRebuild],
    target_version: i64,
) -> AppResult<()> {
    let conn = pool
        .acquire()
        .await
        .map_err(|error| db_error("failed to acquire a connection for schema migration", error))?;
    // Guard the connection from here on: any early return, error, or panic below must not return
    // a foreign_keys = OFF connection to the pool (see RebuildConnection).
    let mut guard = RebuildConnection {
        conn: Some(conn),
        restored: false,
    };

    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(guard.conn()?)
        .await
        .map_err(|error| db_error("failed to disable foreign keys for migration", error))?;

    let outcome =
        apply_table_rebuilds_in_transaction(guard.conn()?, rebuilds, target_version).await;

    // Restore enforcement before the connection can return to the pool, regardless of the
    // rebuild outcome. On success this lets the guard hand the connection back normally; if the
    // restore itself fails (or the rebuild above panicked), the guard detaches it instead.
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(guard.conn()?)
        .await
        .map_err(|error| db_error("failed to re-enable foreign keys after migration", error))?;

    guard.restored = true;
    outcome
}

#[allow(dead_code)]
async fn apply_table_rebuilds_in_transaction(
    conn: &mut SqliteConnection,
    rebuilds: &[TableRebuild],
    target_version: i64,
) -> AppResult<()> {
    let mut tx = conn
        .begin()
        .await
        .map_err(|error| db_error("failed to begin schema migration transaction", error))?;

    for spec in rebuilds {
        rebuild_table(&mut tx, spec).await?;
    }

    // Dropping a table drops only its own indexes, so recreate the indexes of the rebuilt
    // tables and leave every other table's indexes untouched. Recreating the whole catalog
    // here would touch tables this rebuild never dropped - harmless in a full schema, but it
    // also assumes every table exists, which a targeted rebuild must not require.
    let rebuilt_tables: std::collections::HashSet<&str> =
        rebuilds.iter().map(|spec| spec.table).collect();
    for &(table, ddl) in INDEX_DDLS {
        if !rebuilt_tables.contains(table) {
            continue;
        }
        sqlx::query(ddl)
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("failed to recreate index after rebuild", error))?;
    }

    // Dropping a table also drops its triggers, so recreate the rebuilt tables' triggers the same
    // way. A rebuilt `videos` would otherwise lose the live-chat enforcement triggers.
    for &(table, ddl) in TRIGGER_DDLS {
        if !rebuilt_tables.contains(table) {
            continue;
        }
        sqlx::query(ddl)
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("failed to recreate trigger after rebuild", error))?;
    }

    // A rebuild must never leave a child row pointing at a now-missing parent.
    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut *tx)
        .await
        .map_err(|error| db_error("failed to run foreign key check after rebuild", error))?;

    if !violations.is_empty() {
        return Err(db_error(
            "table rebuild left dangling foreign-key references",
            format!(
                "{} violation(s) reported by foreign_key_check",
                violations.len()
            ),
        ));
    }

    set_user_version(&mut tx, target_version).await?;

    tx.commit()
        .await
        .map_err(|error| db_error("failed to commit schema migration", error))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
    use std::path::{Path, PathBuf};

    async fn memory_pool() -> SqlitePool {
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create sqlite memory pool")
    }

    #[tokio::test]
    async fn ensure_schema_creates_all_tables() {
        let pool = memory_pool().await;
        ensure_schema(&pool).await.unwrap();

        for table in ["channels", "videos", "video_comments", "app_settings"] {
            let (count,): (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .bind(table)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(count, 1, "expected table {table} to exist");
        }
    }

    #[tokio::test]
    async fn videos_check_rejects_a_live_chat_flag_without_a_path() {
        let pool = memory_pool().await;
        ensure_schema(&pool).await.unwrap();

        // A parent channel for the rows below (sqlx enables foreign_keys by default), so the
        // rejected insert fails on the live-chat CHECK rather than on the channel foreign key.
        sqlx::query("INSERT INTO channels (id, name, youtube_handle) VALUES (1, 'C', '@c')")
            .execute(&pool)
            .await
            .unwrap();

        // Flag set with no stored path: the state insert_media can never produce and the library
        // diagnostics used to only count is now refused by the schema itself.
        let rejected = sqlx::query(
            "INSERT INTO videos (channel_id, title, title_normalized, file_path, media_type, has_live_chat, live_chat_file_path) \
             VALUES (1, 'T', 't', 'video/a.mp4', 'video', 1, NULL)",
        )
        .execute(&pool)
        .await;
        assert!(
            rejected.is_err(),
            "has_live_chat = 1 with no live_chat_file_path must be rejected"
        );

        // Flag set with a path, flag clear with no path, and flag clear with a path are all
        // allowed - only the flag-without-path combination is the corruption being fenced off.
        for (file_path, has_flag, path) in [
            ("video/b.mp4", "1", "'live_chat/b.json.gz'"),
            ("video/c.mp4", "0", "NULL"),
            ("video/d.mp4", "0", "'live_chat/d.json.gz'"),
        ] {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "INSERT INTO videos (channel_id, title, title_normalized, file_path, media_type, has_live_chat, live_chat_file_path) \
                 VALUES (1, 'T', 't', '{file_path}', 'video', {has_flag}, {path})"
            )))
            .execute(&pool)
            .await
            .unwrap_or_else(|error| panic!("{file_path} should be accepted: {error}"));
        }
    }

    #[tokio::test]
    async fn introspection_helpers_see_the_videos_constraints() {
        // Backs the import-validation helpers against the real schema: the (channel_id, file_path)
        // unique key comes from a table-level UNIQUE constraint (an auto-index, not a named
        // CREATE UNIQUE INDEX), so this also pins that the auto-index form is detected.
        let pool = memory_pool().await;
        ensure_schema(&pool).await.unwrap();

        assert!(
            table_has_unique_index_on(&pool, "videos", &["channel_id", "file_path"])
                .await
                .unwrap(),
            "the (channel_id, file_path) unique key should be detected"
        );
        assert!(
            !table_has_unique_index_on(&pool, "videos", &["file_path", "channel_id"])
                .await
                .unwrap(),
            "column order matters: the reversed pair is a different key"
        );
        assert!(
            !table_has_unique_index_on(&pool, "videos", &["thumbnail_path"])
                .await
                .unwrap(),
            "a non-unique index must not be counted"
        );
        assert!(
            table_has_cascade_foreign_key(&pool, "videos", "channel_id", "channels")
                .await
                .unwrap(),
            "the videos -> channels ON DELETE CASCADE should be detected"
        );
        assert!(
            !table_has_cascade_foreign_key(&pool, "videos", "channel_id", "app_settings")
                .await
                .unwrap(),
            "a cascade to a different parent must not match"
        );
    }

    #[tokio::test]
    async fn migration_13_repairs_and_fences_both_row_invariants_on_a_pre_check_database() {
        let pool = memory_pool().await;

        // A videos table as an older app version left it: the live-chat columns are present but
        // there is no CHECK and no trigger. Stamped at v12 so ensure_schema runs only migration_13
        // over this hand-built table (baseline and 8..12 are skipped for current_version >= their
        // targets), which is exactly the pre-CHECK database this migration must reach.
        sqlx::query("CREATE TABLE channels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, youtube_handle TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE videos ( \
                id INTEGER PRIMARY KEY AUTOINCREMENT, \
                channel_id INTEGER, \
                title TEXT, \
                file_path TEXT, \
                media_type TEXT, \
                has_live_chat INTEGER NOT NULL DEFAULT 0, \
                live_chat_file_path TEXT, \
                FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE, \
                UNIQUE (channel_id, file_path) \
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO channels (id, name, youtube_handle) VALUES (1, 'C', '@c')")
            .execute(&pool)
            .await
            .unwrap();
        // A pre-existing violation the CHECK-less table held (flag set, no path), plus a
        // consistent row that must stay untouched.
        sqlx::query(
            "INSERT INTO videos (id, channel_id, title, file_path, media_type, has_live_chat, live_chat_file_path) \
             VALUES (1, 1, 'bad', 'video/bad.mp4', 'video', 1, NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO videos (id, channel_id, title, file_path, media_type, has_live_chat, live_chat_file_path) \
             VALUES (2, 1, 'ok', 'video/ok.mp4', 'video', 1, 'live_chat/ok.json.gz')",
        )
        .execute(&pool)
        .await
        .unwrap();
        // An accented title, so the backfill below is pinned to the real normalizer rather than to
        // anything a plain lower() would also satisfy.
        sqlx::query(
            "INSERT INTO videos (id, channel_id, title, file_path, media_type, has_live_chat, live_chat_file_path) \
             VALUES (3, 1, 'Ação  Válida', 'video/accent.mp4', 'video', 0, NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("PRAGMA user_version = 12")
            .execute(&pool)
            .await
            .unwrap();

        ensure_schema(&pool).await.unwrap();
        assert_eq!(read_user_version(&pool).await.unwrap(), SCHEMA_VERSION);

        // The pre-existing violation was repaired (flag cleared, path still NULL, row intact);
        // the consistent row keeps its flag.
        let (bad_flag, bad_path): (i64, Option<String>) =
            sqlx::query_as("SELECT has_live_chat, live_chat_file_path FROM videos WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(bad_flag, 0);
        assert_eq!(bad_path, None);

        let (ok_flag,): (i64,) = sqlx::query_as("SELECT has_live_chat FROM videos WHERE id = 2")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(ok_flag, 1);

        // The other half of this migration: the table above predates `title_normalized`, so the
        // column is added and every existing row is backfilled with the same normalizer the search
        // term goes through. This is not covered by v11's backfill - only a database below v11 ever
        // runs v11, and this one is stamped at v12 - and a NULL here fails silently, leaving the
        // media in the library while invisible to every title search.
        let normalized: Vec<(i64, Option<String>)> =
            sqlx::query_as("SELECT id, title_normalized FROM videos ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            normalized,
            vec![
                (1, Some("bad".to_string())),
                (2, Some("ok".to_string())),
                (3, Some("acao valida".to_string())),
            ],
            "migration 13 must backfill title_normalized for every pre-existing row"
        );

        // The trigger now rejects a fresh violating insert and a violating update, while a
        // consistent insert still succeeds.
        let rejected_insert = sqlx::query(
            "INSERT INTO videos (channel_id, title, title_normalized, file_path, media_type, has_live_chat, live_chat_file_path) \
             VALUES (1, 't', 't', 'video/new.mp4', 'video', 1, NULL)",
        )
        .execute(&pool)
        .await;
        assert!(
            rejected_insert.is_err(),
            "the trigger must reject has_live_chat = 1 with no path on insert"
        );

        let rejected_update = sqlx::query("UPDATE videos SET has_live_chat = 1 WHERE id = 1")
            .execute(&pool)
            .await;
        assert!(
            rejected_update.is_err(),
            "the trigger must reject flipping has_live_chat on with no path"
        );

        sqlx::query(
            "INSERT INTO videos (channel_id, title, title_normalized, file_path, media_type, has_live_chat, live_chat_file_path) \
             VALUES (1, 't2', 't2', 'video/new2.mp4', 'video', 0, NULL)",
        )
        .execute(&pool)
        .await
        .expect("a consistent insert must still succeed");

        // The second invariant this migration fences, for the same reason: repairing the existing
        // rows is worthless if the next write can put a NULL straight back.
        let rejected_null_insert = sqlx::query(
            "INSERT INTO videos (channel_id, title, title_normalized, file_path, media_type) \
             VALUES (1, 't3', NULL, 'video/new3.mp4', 'video')",
        )
        .execute(&pool)
        .await;
        assert!(
            rejected_null_insert.is_err(),
            "the trigger must reject a NULL title_normalized on insert"
        );

        let rejected_null_update =
            sqlx::query("UPDATE videos SET title_normalized = NULL WHERE id = 2")
                .execute(&pool)
                .await;
        assert!(
            rejected_null_update.is_err(),
            "the trigger must reject clearing title_normalized on update"
        );
    }

    #[tokio::test]
    async fn ensure_schema_drops_legacy_live_chat_messages_table() {
        let pool = memory_pool().await;

        sqlx::query(
            "CREATE TABLE video_live_chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                video_id INTEGER NOT NULL,
                message_text TEXT NOT NULL
            );",
        )
        .execute(&pool)
        .await
        .unwrap();

        ensure_schema(&pool).await.unwrap();

        let (count,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'video_live_chat_messages'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 0, "legacy live chat table should have been dropped");
    }

    // ---- Real old-database migration fixture ----
    //
    // The test above builds a synthetic legacy table in memory. This pair goes further: it
    // migrates a committed, opaque `.sqlite` file produced from the exact schema and data a
    // real v1.0.0 / v1.1.0 install has on disk (both shipped `user_version = 5`, with the
    // now-legacy `video_live_chat_messages` table). Because the migration test never restates
    // that schema, it genuinely covers "open a real old user's database and migrate it" - the
    // path whose blast radius is silent data loss on upgrade - instead of a hand-built
    // approximation the test could get wrong in the same way the migration does.

    const V1_FIXTURE_RELATIVE: &str = "tests/fixtures/kavynex_v1_user_version_5.sqlite";

    fn manifest_relative_path(relative: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
    }

    fn unique_temp_db(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        std::env::temp_dir().join(format!(
            "kavynex-migration-{tag}-{}-{}.sqlite",
            std::process::id(),
            nanos
        ))
    }

    async fn open_file_pool(path: &Path, create: bool) -> SqlitePool {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(create)
            // A plain rollback journal keeps the fixture a single self-contained file (no -wal
            // sidecar) so it can be committed and loaded as one blob.
            .journal_mode(SqliteJournalMode::Delete)
            .foreign_keys(true);

        SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("open sqlite file pool")
    }

    async fn object_exists(pool: &SqlitePool, kind: &str, name: &str) -> bool {
        let (count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM sqlite_master WHERE type = ? AND name = ?")
                .bind(kind)
                .bind(name)
                .fetch_one(pool)
                .await
                .unwrap();
        count > 0
    }

    /// Regenerates the committed v1 fixture. Ignored so it never runs in CI or overwrites the
    /// fixture during a normal test run; regenerate deliberately with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib regenerate_v1_migration_fixture -- --ignored
    ///
    /// The DDL and indexes below are copied verbatim from v1.0.0's `src/lib/schema.ts` (the
    /// sql-plugin schema real v1.0.0 / v1.1.0 users have on disk), stamped `user_version = 5`
    /// and seeded with representative rows, including two `video_live_chat_messages` rows that
    /// the current baseline must drop.
    #[tokio::test]
    #[ignore = "manual fixture generator; run explicitly with --ignored"]
    async fn regenerate_v1_migration_fixture() {
        let path = manifest_relative_path(V1_FIXTURE_RELATIVE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let _ = std::fs::remove_file(&path);

        let pool = open_file_pool(&path, true).await;

        for ddl in [
            "CREATE TABLE channels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL CHECK (TRIM(name) <> ''),
                youtube_handle TEXT NOT NULL UNIQUE CHECK (TRIM(youtube_handle) <> ''),
                avatar_path TEXT CHECK (avatar_path IS NULL OR TRIM(avatar_path) <> ''),
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );",
            "CREATE TABLE videos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id INTEGER NOT NULL,
                title TEXT NOT NULL CHECK (TRIM(title) <> ''),
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
                FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
                UNIQUE (channel_id, file_path)
            );",
            "CREATE TABLE video_comments (
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
            );",
            "CREATE TABLE video_live_chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                video_id INTEGER NOT NULL,
                message_id TEXT,
                message_offset_ms INTEGER NOT NULL DEFAULT 0,
                author_name TEXT NOT NULL,
                author_thumbnail TEXT,
                author_badges TEXT,
                message_text TEXT NOT NULL,
                timestamp_text TEXT,
                amount_text TEXT,
                header_primary_text TEXT,
                header_secondary_text TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
            );",
            "CREATE TABLE app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );",
            "CREATE INDEX idx_videos_channel_id ON videos(channel_id);",
            "CREATE INDEX idx_channels_youtube_handle ON channels(youtube_handle);",
            "CREATE INDEX idx_channels_avatar_path ON channels(avatar_path);",
            "CREATE INDEX idx_videos_thumbnail_path ON videos(thumbnail_path);",
            "CREATE INDEX idx_videos_channel_thumb ON videos(channel_id, thumbnail_path);",
            "CREATE INDEX idx_videos_youtube_video_id ON videos(youtube_video_id);",
            "CREATE INDEX idx_videos_watched_at ON videos(watched_at);",
            "CREATE INDEX idx_videos_published_at ON videos(published_at);",
            "CREATE INDEX idx_videos_has_comments ON videos(has_comments);",
            "CREATE INDEX idx_videos_is_live ON videos(is_live);",
            "CREATE INDEX idx_videos_has_live_chat ON videos(has_live_chat);",
            "CREATE UNIQUE INDEX idx_videos_channel_youtube_video_id_unique
                ON videos(channel_id, youtube_video_id)
                WHERE youtube_video_id IS NOT NULL AND TRIM(youtube_video_id) <> '';",
            "CREATE INDEX idx_video_comments_video_id ON video_comments(video_id);",
            "CREATE INDEX idx_video_comments_parent_comment_id ON video_comments(parent_comment_id);",
            "CREATE INDEX idx_video_comments_comment_id ON video_comments(comment_id);",
            "CREATE INDEX idx_video_live_chat_messages_video_id ON video_live_chat_messages(video_id);",
            "CREATE INDEX idx_video_live_chat_messages_video_time ON video_live_chat_messages(video_id, message_offset_ms);",
            // Two channels, one with an avatar.
            "INSERT INTO channels (id, name, youtube_handle, avatar_path, created_at) VALUES
                (1, 'Kept Channel', '@keptchannel', 'thumbnails/avatar_1.jpg', '2026-01-01 00:00:00'),
                (2, 'Second Channel', '@second', NULL, '2026-01-02 00:00:00');",
            // A watched video with comments, an audio, and a live video with a live chat replay.
            "INSERT INTO videos
                (id, channel_id, title, file_path, thumbnail_path, media_type, youtube_video_id,
                 watched_at, published_at, duration_seconds, progress_seconds, has_comments,
                 comments_count, is_live, has_live_chat, live_chat_file_path, created_at)
             VALUES
                (1, 1, 'Watched Video', 'video/watched.mp4', 'thumbnails/w.jpg', 'video', 'vid_watched',
                 '2026-02-01 10:00:00', '2026-01-10', 600, 0, 1, 2, 0, 0, NULL, '2026-02-01 09:00:00'),
                (2, 1, 'An Audio', 'audio/song.m4a', NULL, 'audio', NULL,
                 NULL, NULL, 180, 42, 0, 0, 0, 0, NULL, '2026-02-02 09:00:00'),
                (3, 2, 'Live Stream', 'video/live.mp4', NULL, 'video', 'vid_live',
                 NULL, '2026-01-20', 3600, 0, 0, 0, 1, 1, 'live_chat/vid_live.live_chat.json.gz', '2026-02-03 09:00:00');",
            "INSERT INTO video_comments
                (id, video_id, comment_id, parent_comment_id, author_name, text, like_count,
                 reply_count, is_pinned, created_at)
             VALUES
                (1, 1, 'c1', NULL, 'Alice', 'Top comment', 10, 1, 1, '2026-02-01 09:30:00'),
                (2, 1, 'c2', 'c1', 'Bob', 'A reply', 2, 0, 0, '2026-02-01 09:31:00'),
                (3, 1, 'c3', NULL, 'Carol', 'Another top comment', 0, 0, 0, '2026-02-01 09:32:00');",
            // Legacy live chat rows: the current baseline drops this whole table.
            "INSERT INTO video_live_chat_messages
                (id, video_id, message_id, message_offset_ms, author_name, message_text, created_at)
             VALUES
                (1, 3, 'm1', 1000, 'Viewer One', 'hello', '2026-02-03 09:00:01'),
                (2, 3, 'm2', 2000, 'Viewer Two', 'nice stream', '2026-02-03 09:00:02');",
            "INSERT INTO app_settings (key, value, created_at, updated_at) VALUES
                ('import_mode', 'copy', '2026-01-01 00:00:00', '2026-01-01 00:00:00'),
                ('library_path', '/library', '2026-01-01 00:00:00', '2026-01-01 00:00:00'),
                ('load_remote_images', 'true', '2026-01-01 00:00:00', '2026-01-01 00:00:00');",
            // Compact the file so the committed fixture stays small.
            "VACUUM;",
            "PRAGMA user_version = 5;",
        ] {
            sqlx::query(sqlx::AssertSqlSafe(ddl))
                .execute(&pool)
                .await
                .unwrap_or_else(|error| panic!("fixture statement failed: {error}\n{ddl}"));
        }

        pool.close().await;
    }

    #[tokio::test]
    async fn migrates_a_real_v1_database_to_the_current_schema() {
        let source = manifest_relative_path(V1_FIXTURE_RELATIVE);
        assert!(
            source.exists(),
            "missing fixture {}; regenerate it with the ignored regenerate_v1_migration_fixture test",
            source.display()
        );

        // Work on a copy so the committed fixture is never mutated by the migration.
        let working = unique_temp_db("v1");
        std::fs::copy(&source, &working).unwrap();

        let pool = open_file_pool(&working, false).await;

        // Precondition: this really is an old (v5) database with the legacy table and its data.
        assert_eq!(read_user_version(&pool).await.unwrap(), 5);
        assert!(object_exists(&pool, "table", "video_live_chat_messages").await);

        // Run the real migration entry point used at pool init.
        ensure_schema(&pool).await.unwrap();

        // It reaches the current schema version.
        assert_eq!(read_user_version(&pool).await.unwrap(), SCHEMA_VERSION);

        // The legacy table (and its rows) are gone.
        assert!(!object_exists(&pool, "table", "video_live_chat_messages").await);

        // All user data survived the migration intact.
        let (channels,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM channels")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(channels, 2);

        let (videos,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM videos")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(videos, 3);

        let (comments,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM video_comments")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(comments, 3);

        // Spot-check specific values, including the live chat path and watched state.
        let (title, watched): (String, Option<String>) =
            sqlx::query_as("SELECT title, watched_at FROM videos WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(title, "Watched Video");
        assert_eq!(watched.as_deref(), Some("2026-02-01 10:00:00"));

        let (has_live_chat, live_chat_path): (i64, Option<String>) =
            sqlx::query_as("SELECT has_live_chat, live_chat_file_path FROM videos WHERE id = 3")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(has_live_chat, 1);
        assert_eq!(
            live_chat_path.as_deref(),
            Some("live_chat/vid_live.live_chat.json.gz")
        );

        let (progress,): (i64,) =
            sqlx::query_as("SELECT progress_seconds FROM videos WHERE id = 2")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(progress, 42);

        // The indexes the later migrations add exist.
        for index in [
            "idx_videos_channel_created_id",           // v8
            "idx_videos_file_path",                    // v9
            "idx_videos_live_chat_file_path",          // v9
            "idx_video_comments_video_comment_unique", // v10
        ] {
            assert!(
                object_exists(&pool, "index", index).await,
                "migration must create {index}"
            );
        }

        // The migrated database is structurally sound.
        let (integrity,): (String,) = sqlx::query_as("PRAGMA integrity_check")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(integrity, "ok");

        let fk_violations: Vec<(String, i64, String, i64)> =
            sqlx::query_as("PRAGMA foreign_key_check")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert!(
            fk_violations.is_empty(),
            "foreign key violations after migration: {fk_violations:?}"
        );

        pool.close().await;
        let _ = std::fs::remove_file(&working);
    }

    #[tokio::test]
    async fn ensure_schema_is_idempotent() {
        let pool = memory_pool().await;
        ensure_schema(&pool).await.unwrap();
        ensure_schema(&pool).await.unwrap();

        let (version,): (i64,) = sqlx::query_as("PRAGMA user_version")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[tokio::test]
    async fn ensure_schema_adds_missing_videos_columns_to_legacy_db() {
        let pool = memory_pool().await;

        // Simulate an old database created before the live-chat columns existed. All
        // other columns (thumbnail_path, etc.) predate those migrations, so they are
        // present here just like in a real legacy database.
        sqlx::query(
            "CREATE TABLE videos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id INTEGER NOT NULL,
                title TEXT NOT NULL,
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
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE (channel_id, file_path)
            );",
        )
        .execute(&pool)
        .await
        .unwrap();

        ensure_schema(&pool).await.unwrap();

        assert!(table_has_column(&pool, "videos", "is_live").await.unwrap());
        assert!(table_has_column(&pool, "videos", "has_live_chat")
            .await
            .unwrap());
        assert!(table_has_column(&pool, "videos", "live_chat_file_path")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn migration_11_backfills_title_normalized_for_existing_rows() {
        let pool = memory_pool().await;

        // A pre-v11 videos table (no title_normalized column), same shape as a legacy database.
        sqlx::query(
            "CREATE TABLE videos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id INTEGER NOT NULL,
                title TEXT NOT NULL,
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
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE (channel_id, file_path)
            );",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Titles spanning accents, non-latin scripts and plain ASCII, so the backfill is checked
        // against the app's own normalization rather than a hand-computed constant.
        let titles = ["Café com Pão", "ÖLÇÜ test", "PLAIN ascii", "日本語タイトル"];
        for (index, title) in titles.iter().enumerate() {
            sqlx::query(
                "INSERT INTO videos (id, channel_id, title, file_path, media_type)
                 VALUES (?, 1, ?, ?, 'video')",
            )
            .bind(index as i64 + 1)
            .bind(*title)
            .bind(format!("video/{index}.mp4"))
            .execute(&pool)
            .await
            .unwrap();
        }

        ensure_schema(&pool).await.unwrap();

        for (index, title) in titles.iter().enumerate() {
            let (stored,): (Option<String>,) =
                sqlx::query_as("SELECT title_normalized FROM videos WHERE id = ?")
                    .bind(index as i64 + 1)
                    .fetch_one(&pool)
                    .await
                    .unwrap();

            assert_eq!(
                stored.as_deref(),
                Some(crate::utils::text::normalize_search_text(title).as_str()),
                "title_normalized backfill mismatch for '{title}'"
            );
        }
    }

    #[tokio::test]
    async fn legacy_upgrade_and_fresh_create_agree_on_additive_column_definitions() {
        // Guards the baseline/additive divergence footgun. `VIDEOS_ADDITIVE_COLUMNS` (the
        // `ALTER TABLE ADD COLUMN` definitions an upgraded legacy database receives) and
        // `VIDEOS_TABLE_DDL` (the `CREATE TABLE` definitions a fresh database receives) are
        // maintained separately. If they ever drift, an upgraded database and a freshly
        // created one would sit at the same user_version with a differently-typed column - the
        // exact silent divergence the versioned-migration comment in `ensure_schema` warns
        // against. This asserts both paths produce byte-identical definitions for every
        // additive column (type, NOT NULL, default), so a mismatch fails CI instead of only
        // surfacing on a user's machine.
        async fn videos_column_defs(
            pool: &SqlitePool,
        ) -> std::collections::HashMap<String, (String, i64, Option<String>)> {
            let rows: Vec<(String, String, i64, Option<String>)> = sqlx::query_as(
                "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('videos')",
            )
            .fetch_all(pool)
            .await
            .unwrap();

            rows.into_iter()
                .map(|(name, col_type, notnull, dflt)| (name, (col_type, notnull, dflt)))
                .collect()
        }

        let fresh = memory_pool().await;
        ensure_schema(&fresh).await.unwrap();

        // A pre-additive-columns legacy `videos` table (same shape as the migration test above).
        let legacy = memory_pool().await;
        sqlx::query(
            "CREATE TABLE videos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id INTEGER NOT NULL,
                title TEXT NOT NULL,
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
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE (channel_id, file_path)
            );",
        )
        .execute(&legacy)
        .await
        .unwrap();
        ensure_schema(&legacy).await.unwrap();

        let fresh_defs = videos_column_defs(&fresh).await;
        let legacy_defs = videos_column_defs(&legacy).await;

        for (column, _definition) in VIDEOS_ADDITIVE_COLUMNS {
            let fresh_def = fresh_defs
                .get(*column)
                .unwrap_or_else(|| panic!("a freshly created videos table is missing '{column}'"));
            let legacy_def = legacy_defs
                .get(*column)
                .unwrap_or_else(|| panic!("an upgraded videos table is missing '{column}'"));

            assert_eq!(
                fresh_def, legacy_def,
                "additive column '{column}' differs between a fresh create (VIDEOS_TABLE_DDL) and a legacy upgrade (VIDEOS_ADDITIVE_COLUMNS); route non-additive schema changes through a table rebuild",
            );
        }
    }

    #[tokio::test]
    async fn ensure_schema_upgrades_database_stamped_by_older_version() {
        let pool = memory_pool().await;

        // Simulate a database left by an older build: a stale user_version marker and
        // no tables yet. The baseline must run because user_version < BASELINE.
        sqlx::query("PRAGMA user_version = 6")
            .execute(&pool)
            .await
            .unwrap();

        ensure_schema(&pool).await.unwrap();

        let (version,): (i64,) = sqlx::query_as("PRAGMA user_version")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        // The baseline reconcile ran, so the schema is fully present.
        for table in ["channels", "videos", "video_comments", "app_settings"] {
            let (count,): (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .bind(table)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(count, 1, "expected table {table} to exist");
        }
    }

    #[tokio::test]
    async fn ensure_schema_refuses_database_from_newer_version() {
        let pool = memory_pool().await;

        sqlx::query(sqlx::AssertSqlSafe(format!(
            "PRAGMA user_version = {}",
            SCHEMA_VERSION + 1
        )))
        .execute(&pool)
        .await
        .unwrap();

        let error = ensure_schema(&pool).await.unwrap_err();
        assert!(
            error.to_string().contains("newer version"),
            "unexpected error: {error}"
        );

        // The newer marker must be left untouched, never downgraded.
        let (version,): (i64,) = sqlx::query_as("PRAGMA user_version")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION + 1);
    }

    #[tokio::test]
    async fn migration_8_adds_the_channel_created_index_to_a_pre_v8_database() {
        let pool = memory_pool().await;
        ensure_schema(&pool).await.unwrap();

        // A fresh database already has the index from the baseline.
        let fresh: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'index' AND name = 'idx_videos_channel_created_id'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(fresh.0, 1);

        // Simulate a database left by v7: drop the v8 index and roll the marker back.
        sqlx::query("DROP INDEX idx_videos_channel_created_id")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA user_version = 7")
            .execute(&pool)
            .await
            .unwrap();

        ensure_schema(&pool).await.unwrap();

        let (index_count,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'index' AND name = 'idx_videos_channel_created_id'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            index_count, 1,
            "migration 8 must add the index to a pre-v8 database"
        );

        let (version,): (i64,) = sqlx::query_as("PRAGMA user_version")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[tokio::test]
    async fn migration_9_adds_the_delete_path_indexes_to_a_pre_v9_database() {
        let pool = memory_pool().await;
        ensure_schema(&pool).await.unwrap();

        // A fresh database already has both indexes from the baseline.
        for index in ["idx_videos_file_path", "idx_videos_live_chat_file_path"] {
            let (count,): (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?",
            )
            .bind(index)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(count, 1, "fresh database should already have {index}");
        }

        // Simulate a database left by v8: drop the v9 indexes and roll the marker back.
        sqlx::query("DROP INDEX idx_videos_file_path")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DROP INDEX idx_videos_live_chat_file_path")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA user_version = 8")
            .execute(&pool)
            .await
            .unwrap();

        ensure_schema(&pool).await.unwrap();

        for index in ["idx_videos_file_path", "idx_videos_live_chat_file_path"] {
            let (count,): (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?",
            )
            .bind(index)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(
                count, 1,
                "migration 9 must add {index} to a pre-v9 database"
            );
        }

        let (version,): (i64,) = sqlx::query_as("PRAGMA user_version")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[tokio::test]
    async fn migration_10_adds_the_comment_unique_index_to_a_pre_v10_database() {
        let pool = memory_pool().await;
        ensure_schema(&pool).await.unwrap();

        // A fresh database already has the index from the baseline.
        let (fresh,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'index' AND name = 'idx_video_comments_video_comment_unique'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(fresh, 1);

        // Simulate a database left by v9: drop the v10 index and roll the marker back.
        sqlx::query("DROP INDEX idx_video_comments_video_comment_unique")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA user_version = 9")
            .execute(&pool)
            .await
            .unwrap();

        ensure_schema(&pool).await.unwrap();

        let (count,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'index' AND name = 'idx_video_comments_video_comment_unique'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            count, 1,
            "migration 10 must add the unique index to a pre-v10 database"
        );

        let (version,): (i64,) = sqlx::query_as("PRAGMA user_version")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[tokio::test]
    async fn migration_10_collapses_pre_existing_duplicate_comments_before_indexing() {
        let pool = memory_pool().await;
        ensure_schema(&pool).await.unwrap();

        // Roll back to v9 and drop the unique index so a duplicate the current schema forbids can
        // be seeded, reproducing a database written before the invariant lived in the schema.
        sqlx::query("DROP INDEX idx_video_comments_video_comment_unique")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA user_version = 9")
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query("INSERT INTO channels (id, name, youtube_handle) VALUES (1, 'Chan', '@chan')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO videos (id, channel_id, title, title_normalized, file_path, media_type)
             VALUES (1, 1, 'V', 'v', 'video/v.mp4', 'video')",
        )
        .execute(&pool)
        .await
        .unwrap();
        // Two rows sharing (video_id, comment_id) - exactly what the new index forbids.
        sqlx::query(
            "INSERT INTO video_comments (id, video_id, comment_id, author_name, text)
             VALUES (1, 1, 'c1', 'A', 'first'), (2, 1, 'c1', 'A', 'dup')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // The migration must collapse the duplicate and then build the unique index.
        ensure_schema(&pool).await.unwrap();

        let (count,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM video_comments WHERE video_id = 1 AND comment_id = 'c1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 1, "the duplicate must be collapsed to a single row");

        let (kept_text,): (String,) = sqlx::query_as(
            "SELECT text FROM video_comments WHERE video_id = 1 AND comment_id = 'c1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(kept_text, "first", "the lowest-id row must be the one kept");

        // The unique index now rejects a fresh duplicate.
        let dup = sqlx::query(
            "INSERT INTO video_comments (id, video_id, comment_id, author_name, text)
             VALUES (3, 1, 'c1', 'A', 'again')",
        )
        .execute(&pool)
        .await;
        assert!(
            dup.is_err(),
            "the unique index must reject a duplicate (video_id, comment_id)"
        );
    }

    #[tokio::test]
    async fn apply_table_rebuilds_restores_foreign_keys_after_a_failed_rebuild() {
        let pool = memory_pool_with_foreign_keys().await;

        sqlx::query("CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        // A row the new CHECK will reject, so the copy step (and the whole rebuild) fails.
        sqlx::query("INSERT INTO widget (id, name) VALUES (1, '   ')")
            .execute(&pool)
            .await
            .unwrap();

        let rebuild = TableRebuild {
            table: "widget",
            staging_table: "widget_rebuilt",
            new_ddl: "CREATE TABLE widget_rebuilt (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL CHECK (TRIM(name) <> '')
            )",
            carried_columns: "id, name",
        };

        assert!(
            apply_table_rebuilds(&pool, std::slice::from_ref(&rebuild), 8)
                .await
                .is_err()
        );

        // Even though the rebuild failed, foreign-key enforcement must be back on for the next
        // pool consumer - never left in the OFF state the rebuild toggled it into.
        let (foreign_keys,): (i64,) = sqlx::query_as("PRAGMA foreign_keys")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            foreign_keys, 1,
            "foreign keys must be re-enabled even when the rebuild fails"
        );
    }

    async fn memory_pool_with_foreign_keys() -> SqlitePool {
        let options = "sqlite::memory:"
            .parse::<sqlx::sqlite::SqliteConnectOptions>()
            .expect("parse sqlite memory url")
            .foreign_keys(true);

        SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("create sqlite memory pool with foreign keys")
    }

    #[tokio::test]
    async fn apply_table_rebuilds_applies_a_new_check_and_preserves_rows() {
        let pool = memory_pool().await;

        // A table created by an older schema that lacks a CHECK the new schema wants.
        sqlx::query("CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO widget (id, name) VALUES (1, 'kept')")
            .execute(&pool)
            .await
            .unwrap();

        let rebuild = TableRebuild {
            table: "widget",
            staging_table: "widget_rebuilt",
            new_ddl: "CREATE TABLE widget_rebuilt (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL CHECK (TRIM(name) <> '')
            )",
            carried_columns: "id, name",
        };

        apply_table_rebuilds(&pool, std::slice::from_ref(&rebuild), 8)
            .await
            .unwrap();

        // Existing rows survived the rebuild.
        let (name,): (String,) = sqlx::query_as("SELECT name FROM widget WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(name, "kept");

        // The new CHECK is now enforced, which the additive path could never have added.
        let blank = sqlx::query("INSERT INTO widget (id, name) VALUES (2, '   ')")
            .execute(&pool)
            .await;
        assert!(
            blank.is_err(),
            "the rebuilt CHECK should reject a blank name"
        );

        let (version,): (i64,) = sqlx::query_as("PRAGMA user_version")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(version, 8);
    }

    #[tokio::test]
    async fn apply_table_rebuilds_keeps_foreign_key_children_when_rebuilding_a_parent() {
        let pool = memory_pool_with_foreign_keys().await;
        ensure_schema(&pool).await.unwrap();

        // A channel with a video and a comment, wired by ON DELETE CASCADE foreign keys.
        // With enforcement on, a naive DROP TABLE channels would cascade these away.
        sqlx::query("INSERT INTO channels (id, name, youtube_handle) VALUES (1, 'Chan', '@chan')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO videos (id, channel_id, title, title_normalized, file_path, media_type)
             VALUES (1, 1, 'V', 'v', 'video/v.mp4', 'video')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO video_comments (id, video_id, author_name, text)
             VALUES (1, 1, 'Author', 'hi')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Rebuild the parent table (adding a new column), which drops and recreates it.
        let rebuild = TableRebuild {
            table: "channels",
            staging_table: "channels_rebuilt",
            new_ddl: "CREATE TABLE channels_rebuilt (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL CHECK (TRIM(name) <> ''),
                youtube_handle TEXT NOT NULL UNIQUE CHECK (TRIM(youtube_handle) <> ''),
                avatar_path TEXT CHECK (avatar_path IS NULL OR TRIM(avatar_path) <> ''),
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                note TEXT CHECK (note IS NULL OR TRIM(note) <> '')
            )",
            carried_columns: "id, name, youtube_handle, avatar_path, created_at",
        };

        apply_table_rebuilds(&pool, std::slice::from_ref(&rebuild), 8)
            .await
            .unwrap();

        // The channel survived and gained the new column...
        let (name,): (String,) = sqlx::query_as("SELECT name FROM channels WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(name, "Chan");

        // ...and dropping/recreating the parent did NOT cascade-delete its children,
        // because foreign keys were disabled for the rebuild.
        let (videos,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM videos")
            .fetch_one(&pool)
            .await
            .unwrap();
        let (comments,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM video_comments")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            videos, 1,
            "rebuilding the parent must not delete child videos"
        );
        assert_eq!(
            comments, 1,
            "rebuilding the parent must not delete comments"
        );

        // Enforcement is back on after the migration...
        let (foreign_keys,): (i64,) = sqlx::query_as("PRAGMA foreign_keys")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            foreign_keys, 1,
            "foreign keys must be re-enabled after rebuild"
        );

        let (version,): (i64,) = sqlx::query_as("PRAGMA user_version")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(version, 8);
    }

    #[tokio::test]
    async fn apply_table_rebuilds_rejects_data_that_violates_the_new_constraint() {
        let pool = memory_pool().await;

        sqlx::query("CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        // A pre-existing row that the new CHECK would reject.
        sqlx::query("INSERT INTO widget (id, name) VALUES (1, '   ')")
            .execute(&pool)
            .await
            .unwrap();

        let rebuild = TableRebuild {
            table: "widget",
            staging_table: "widget_rebuilt",
            new_ddl: "CREATE TABLE widget_rebuilt (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL CHECK (TRIM(name) <> '')
            )",
            carried_columns: "id, name",
        };

        // The copy step fails the CHECK, so the whole migration rolls back: the original
        // table is untouched and the version is not bumped.
        assert!(
            apply_table_rebuilds(&pool, std::slice::from_ref(&rebuild), 8)
                .await
                .is_err()
        );

        let (name,): (String,) = sqlx::query_as("SELECT name FROM widget WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(name, "   ");

        let (version,): (i64,) = sqlx::query_as("PRAGMA user_version")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(version, 0);
    }
}
