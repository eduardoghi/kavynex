use sqlx::{SqliteConnection, SqlitePool};

use crate::services::database::db_error;
use crate::AppResult;

/// Current schema version. Bump this and add a matching migration block in
/// `ensure_schema` whenever the schema changes.
pub(crate) const SCHEMA_VERSION: i64 = 7;

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

const INDEX_DDLS: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS idx_videos_channel_id ON videos(channel_id)",
    "CREATE INDEX IF NOT EXISTS idx_channels_youtube_handle ON channels(youtube_handle)",
    "CREATE INDEX IF NOT EXISTS idx_channels_avatar_path ON channels(avatar_path)",
    "CREATE INDEX IF NOT EXISTS idx_videos_thumbnail_path ON videos(thumbnail_path)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_channel_file_path_unique ON videos(channel_id, file_path)",
    "CREATE INDEX IF NOT EXISTS idx_videos_channel_thumb ON videos(channel_id, thumbnail_path)",
    "CREATE INDEX IF NOT EXISTS idx_videos_youtube_video_id ON videos(youtube_video_id)",
    "CREATE INDEX IF NOT EXISTS idx_videos_watched_at ON videos(watched_at)",
    "CREATE INDEX IF NOT EXISTS idx_videos_published_at ON videos(published_at)",
    "CREATE INDEX IF NOT EXISTS idx_videos_has_comments ON videos(has_comments)",
    "CREATE INDEX IF NOT EXISTS idx_videos_is_live ON videos(is_live)",
    "CREATE INDEX IF NOT EXISTS idx_videos_has_live_chat ON videos(has_live_chat)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_channel_youtube_video_id_unique ON videos(channel_id, youtube_video_id) WHERE youtube_video_id IS NOT NULL AND TRIM(youtube_video_id) <> ''",
    "CREATE INDEX IF NOT EXISTS idx_video_comments_video_id ON video_comments(video_id)",
    "CREATE INDEX IF NOT EXISTS idx_video_comments_parent_comment_id ON video_comments(parent_comment_id)",
    "CREATE INDEX IF NOT EXISTS idx_video_comments_comment_id ON video_comments(comment_id)",
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
];

async fn table_has_column<'e, E>(executor: E, table: &str, column: &str) -> AppResult<bool>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    // table is an internal constant, not user input, so interpolation is safe here.
    let rows: Vec<(String,)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT name FROM pragma_table_info('{table}')"
    )))
    .fetch_all(executor)
    .await
    .map_err(|error| db_error("failed to read table columns", error))?;

    Ok(rows.iter().any(|(name,)| name == column))
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
        return Err(db_error(
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

    // Future non-additive migrations follow the same shape, each guarded by version
    // and each transactional, e.g.:
    //
    //     if current_version < 8 {
    //         apply_migration_8(pool).await?;
    //     }
    //
    // A migration that changes a CHECK/UNIQUE/type rebuilds the table (create new,
    // copy, drop, rename) inside its transaction, which is how constraint changes
    // reach existing databases instead of being silently skipped.

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

    for ddl in INDEX_DDLS {
        sqlx::query(*ddl)
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

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

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
}
