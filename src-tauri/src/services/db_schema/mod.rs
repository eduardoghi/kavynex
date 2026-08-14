use sqlx::{SqliteConnection, SqlitePool};

use crate::services::database::db_error;
use crate::{AppError, AppErrorCode, AppResult};

/// Current schema version. Bump this and add a matching migration block in
/// `ensure_schema` whenever the schema changes.
pub(crate) const SCHEMA_VERSION: i64 = 14;

/// Version produced by the idempotent baseline reconcile (`apply_baseline_schema`).
/// It stays fixed even as `SCHEMA_VERSION` grows: every database created before
/// versioned migrations existed sits at `user_version <= 6`, so the baseline runs
/// exactly once to bring it here, and real migrations take over from 8 onward.
const BASELINE_SCHEMA_VERSION: i64 = 7;

// The schema DDL (table/index/trigger statements, additive-column list) is data, kept in the
// `ddl` submodule so the migrations read as steps rather than SQL text. Glob-imported because
// the migrations reference many of these constants by name, and the tests below assert against
// several of them.
mod ddl;
#[allow(unused_imports)]
use ddl::*;

// Read-only schema introspection (pragma_* lookups) lives in the `introspection` submodule;
// re-exported so the import validation in `db_backup::import` and the migrations here both reach
// it, and the parent's tests via `super::*`.
mod introspection;
pub(crate) use introspection::{
    table_has_cascade_foreign_key, table_has_column, table_has_unique_index_on,
};

// The migrations themselves. `ensure_schema` below is only the version dispatcher; each
// `apply_migration_*` and the baseline reconcile live in `migrations`, which keeps this module
// readable as "which versions run when" rather than as several hundred lines of SQL.
mod migrations;
use migrations::{
    apply_baseline_schema, apply_migration_10, apply_migration_11, apply_migration_12,
    apply_migration_13, apply_migration_14, apply_migration_8, apply_migration_9,
};

// SQLite's table-rebuild procedure, for a change `ALTER TABLE ADD COLUMN` or a trigger cannot
// express. Unused as of SCHEMA_VERSION 14 and kept ready; see the module for why.
mod rebuild;
#[cfg(test)]
use rebuild::RebuildConnection;
#[allow(unused_imports)]
pub(crate) use rebuild::{apply_table_rebuilds, TableRebuild};

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

/// Whether a database stamped `current` still needs the migration that stamps `target`.
///
/// The rule is one comparison, and it was written out at each of the eight guards below until the
/// mutation gate made the cost of that visible: nine identical `current_version < N` expressions
/// generate nine mutants with the same description, so they cannot be told apart by anything but a
/// line number. Three of them are equivalent (skipping v8, v9 or v11 changes nothing, because a
/// later migration re-runs the whole `INDEX_DDLS` list and v13 redoes v11's backfill), and with the
/// comparison inlined there was no way to exclude those three without also dropping the five that
/// catch a real skipped migration. Naming the rule once gives it one mutant, which can be reasoned
/// about (and excluded, if it turns out equivalent) on its own terms.
///
/// The `>` refusal above is deliberately not routed through this: it decides whether the database
/// is openable at all, which is a different question from which migrations are outstanding.
fn needs_migration(current: i64, target: i64) -> bool {
    current < target
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
    if needs_migration(current_version, BASELINE_SCHEMA_VERSION) {
        apply_baseline_schema(pool).await?;
    }

    // v8: adds idx_videos_channel_created_id. Additive, so it just runs the index DDLs.
    if needs_migration(current_version, 8) {
        apply_migration_8(pool).await?;
    }

    // v9: adds idx_videos_file_path and idx_videos_live_chat_file_path. Additive, so it just
    // runs the index DDLs.
    if needs_migration(current_version, 9) {
        apply_migration_9(pool).await?;
    }

    // v10: adds the partial unique index on (video_id, comment_id). A pre-v10 database could in
    // principle already hold a duplicate the index would reject, so this migration first collapses
    // any duplicate comment rows and only then builds the index (see apply_migration_10).
    if needs_migration(current_version, 10) {
        apply_migration_10(pool).await?;
    }

    // v11: adds the `title_normalized` column (accent/case-folded title) plus its index, and
    // backfills the column for existing rows. Not index-only: the backfill is computed in Rust
    // because SQLite cannot accent-fold in SQL (see apply_migration_11).
    if needs_migration(current_version, 11) {
        apply_migration_11(pool).await?;
    }

    // v12: adds the per-sort-category indexes for `list_media_page`.
    if needs_migration(current_version, 12) {
        apply_migration_12(pool).await?;
    }

    // v13: enforces the videos live-chat invariant on databases whose table predates the CHECK.
    // Repairs any already-inconsistent row, then adds the enforcement triggers. Not index-only,
    // but still additive (no table rebuild). See apply_migration_13.
    if needs_migration(current_version, 13) {
        apply_migration_13(pool).await?;
    }

    // v14: enforces the comment-body length ceiling on databases whose video_comments table predates
    // the CHECK. Truncates any already-over-length row, then adds the enforcement triggers. Additive
    // (no table rebuild), same shape as v13. See apply_migration_14.
    if needs_migration(current_version, 14) {
        apply_migration_14(pool).await?;
    }

    // Each migration is guarded by version and transactional (it stamps the new
    // user_version inside its own transaction, so a crash leaves the database fully at the
    // old or the new version). An additive migration (a new column or index) runs the
    // guarded ALTER/CREATE like `apply_migration_8`. Enforcing a new invariant on an existing
    // table can often stay additive too: `apply_migration_13` backports the videos live-chat
    // CHECK with a trigger rather than a rebuild. A change that genuinely rewrites the table (a
    // column type, dropping a column, replacing a UNIQUE) cannot be expressed with
    // `ALTER TABLE ADD COLUMN` or a trigger, so it rebuilds the affected table with
    // `apply_table_rebuilds` (create new, copy, drop, rename, with foreign keys disabled and
    // verified) instead of being silently skipped by the additive baseline above.

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
        // allowed, only the flag-without-path combination is the corruption being fenced off.
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

    #[test]
    fn video_comments_text_check_literal_matches_the_app_cap() {
        // The DDL and the migration both hardcode the ceiling (a CHECK/trigger literal cannot
        // interpolate a Rust constant), so pin them against the app-side truncation cap here: if one
        // moves without the other, the schema and the write path would silently disagree.
        let cap = crate::services::media_comments::MAX_COMMENT_TEXT_CHARS;
        assert_eq!(cap, 16_000);
        assert!(
            VIDEO_COMMENTS_TABLE_DDL.contains(&format!("LENGTH(text) <= {cap}")),
            "the video_comments DDL must enforce the same ceiling as MAX_COMMENT_TEXT_CHARS"
        );
    }

    #[tokio::test]
    async fn video_comments_check_rejects_over_length_text() {
        let pool = memory_pool().await;
        ensure_schema(&pool).await.unwrap();

        let cap = crate::services::media_comments::MAX_COMMENT_TEXT_CHARS;

        // Parent channel + video for the FK; the rejected insert must fail on the length CHECK, not
        // on a missing parent.
        sqlx::query("INSERT INTO channels (id, name, youtube_handle) VALUES (1, 'C', '@c')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO videos (id, channel_id, title, title_normalized, file_path, media_type) \
             VALUES (1, 1, 'T', 't', 'video/a.mp4', 'video')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Exactly at the cap is accepted.
        sqlx::query("INSERT INTO video_comments (video_id, author_name, text) VALUES (1, 'A', ?)")
            .bind("a".repeat(cap))
            .execute(&pool)
            .await
            .expect("a comment at the ceiling should be accepted");

        // One over the cap is rejected by the CHECK.
        let rejected = sqlx::query(
            "INSERT INTO video_comments (video_id, author_name, text) VALUES (1, 'A', ?)",
        )
        .bind("a".repeat(cap + 1))
        .execute(&pool)
        .await;
        assert!(
            rejected.is_err(),
            "a comment longer than the ceiling must be rejected"
        );
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
        // there is no CHECK and no trigger. Stamped at v12 so ensure_schema runs migration_13 (and
        // then the additive migration_14) over this hand-built table (baseline and 8..12 are skipped
        // for current_version >= their targets), which is exactly the pre-CHECK database migration_13
        // must reach.
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
        // A real database always carries video_comments too; include it so the additive v14 migration
        // (which installs the comment-length triggers on this table) has a table to attach them to.
        sqlx::query(
            "CREATE TABLE video_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, video_id INTEGER NOT NULL, author_name TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE)",
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
        // term goes through. This is not covered by v11's backfill (only a database below v11 ever
        // runs v11, and this one is stamped at v12), and a NULL here fails silently, leaving the
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

    /// Creates the four core tables in the shape a build that stamped `version` would have left on
    /// disk, seeds one channel/media/comment row, and stamps that `user_version`.
    ///
    /// Two historical eras are what make this worth seeding by hand rather than reusing the current
    /// DDL. `title_normalized` only entered `VIDEOS_ADDITIVE_COLUMNS` with v11, so a database
    /// stamped 7..=10 by the build of its day carries every other additive column and not that one.
    /// exactly the shape whose `CREATE INDEX ... ON videos(title_normalized)` used to fail. Below
    /// the baseline (0..=6) none of the additive columns are there either, since the baseline is
    /// what adds them. Column types are kept loose on purpose: this models what an older build
    /// actually wrote, not what the current DDL declares.
    async fn seed_database_at_version(pool: &SqlitePool, version: i64) {
        let has_additive_columns = version >= BASELINE_SCHEMA_VERSION;
        let has_title_normalized = version >= 11;

        sqlx::query(
            "CREATE TABLE channels ( \
                id INTEGER PRIMARY KEY AUTOINCREMENT, \
                name TEXT NOT NULL, \
                youtube_handle TEXT NOT NULL, \
                avatar_path TEXT, \
                created_at TEXT NOT NULL DEFAULT (datetime('now')) \
            )",
        )
        .execute(pool)
        .await
        .unwrap();

        let mut videos_columns = String::from(
            "id INTEGER PRIMARY KEY AUTOINCREMENT, \
             channel_id INTEGER NOT NULL, \
             title TEXT NOT NULL, \
             file_path TEXT NOT NULL, \
             thumbnail_path TEXT, \
             media_type TEXT NOT NULL, \
             youtube_video_id TEXT, \
             watched_at TEXT, \
             published_at TEXT, \
             duration_seconds INTEGER, \
             progress_seconds INTEGER NOT NULL DEFAULT 0, \
             has_comments INTEGER NOT NULL DEFAULT 0, \
             comments_count INTEGER NOT NULL DEFAULT 0, \
             created_at TEXT NOT NULL DEFAULT (datetime('now'))",
        );

        if has_additive_columns {
            videos_columns.push_str(
                ", is_live INTEGER NOT NULL DEFAULT 0, \
                 has_live_chat INTEGER NOT NULL DEFAULT 0, \
                 live_chat_file_path TEXT",
            );
        }

        if has_title_normalized {
            videos_columns.push_str(", title_normalized TEXT");
        }

        sqlx::query(sqlx::AssertSqlSafe(format!(
            "CREATE TABLE videos ({videos_columns}, \
             FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE, \
             UNIQUE (channel_id, file_path))"
        )))
        .execute(pool)
        .await
        .unwrap();

        sqlx::query(
            "CREATE TABLE video_comments ( \
                id INTEGER PRIMARY KEY AUTOINCREMENT, \
                video_id INTEGER NOT NULL, \
                comment_id TEXT, \
                parent_comment_id TEXT, \
                author_name TEXT NOT NULL DEFAULT '', \
                text TEXT NOT NULL DEFAULT '', \
                like_count INTEGER NOT NULL DEFAULT 0, \
                reply_count INTEGER NOT NULL DEFAULT 0, \
                created_at TEXT NOT NULL DEFAULT (datetime('now')), \
                FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE \
            )",
        )
        .execute(pool)
        .await
        .unwrap();

        sqlx::query(
            "CREATE TABLE app_settings ( \
                key TEXT PRIMARY KEY, \
                value TEXT NOT NULL, \
                created_at TEXT NOT NULL DEFAULT (datetime('now')), \
                updated_at TEXT NOT NULL DEFAULT (datetime('now')) \
            )",
        )
        .execute(pool)
        .await
        .unwrap();

        sqlx::query("INSERT INTO channels (id, name, youtube_handle) VALUES (1, 'C', '@c')")
            .execute(pool)
            .await
            .unwrap();

        // An accented title, so the assertion below is pinned to the real normalizer rather than to
        // anything a plain lower() would also satisfy.
        if has_title_normalized {
            // A database stamped v11 or later claims to have been backfilled, so it must carry the
            // value. A NULL there is the one state stage_database_import refuses outright.
            sqlx::query(
                "INSERT INTO videos (id, channel_id, title, title_normalized, file_path, media_type) \
                 VALUES (1, 1, 'Ação  Válida', 'acao valida', 'video/a.mp4', 'video')",
            )
            .execute(pool)
            .await
            .unwrap();
        } else {
            sqlx::query(
                "INSERT INTO videos (id, channel_id, title, file_path, media_type) \
                 VALUES (1, 1, 'Ação  Válida', 'video/a.mp4', 'video')",
            )
            .execute(pool)
            .await
            .unwrap();
        }

        sqlx::query(
            "INSERT INTO video_comments (id, video_id, comment_id, author_name, text) \
             VALUES (1, 1, 'c1', 'A', 'hello')",
        )
        .execute(pool)
        .await
        .unwrap();

        // The indexes a real database of this era carries. Seeding none at all (which this used to
        // do) makes the fixture a shape no build ever produced, and hides a skipped index migration
        // behind a database that never had the index either. A database below the baseline is the
        // one case that legitimately has none: `apply_baseline_schema` is what first creates them.
        if version >= BASELINE_SCHEMA_VERSION {
            for &(_, ddl) in INDEX_DDLS {
                if index_introduced_in(ddl_object_name(ddl)) <= version {
                    sqlx::query(sqlx::AssertSqlSafe(ddl))
                        .execute(pool)
                        .await
                        .unwrap_or_else(|error| {
                            panic!("failed to seed {ddl} at v{version}: {error}")
                        });
                }
            }
        }

        // Same for the triggers, whose era is read off the table each one guards rather than its
        // name: v13 backported the two `videos` row invariants, v14 the `video_comments` body-length
        // ceiling. A database below v13 has none, which is exactly what those migrations are for.
        for &(table, ddl) in TRIGGER_DDLS {
            if trigger_introduced_in(table) <= version {
                sqlx::query(sqlx::AssertSqlSafe(ddl))
                    .execute(pool)
                    .await
                    .unwrap_or_else(|error| {
                        panic!("failed to seed a trigger at v{version}: {error}")
                    });
            }
        }

        sqlx::query(sqlx::AssertSqlSafe(format!(
            "PRAGMA user_version = {version}"
        )))
        .execute(pool)
        .await
        .unwrap();
    }

    /// The schema version that first created the triggers on each table: v13 backported the two
    /// `videos` row invariants, v14 the `video_comments` body-length ceiling.
    fn trigger_introduced_in(table: &str) -> i64 {
        match table {
            "video_comments" => 14,
            _ => 13,
        }
    }

    /// The object name out of a `CREATE ... IF NOT EXISTS <name> ON <table>(...)` literal.
    fn ddl_object_name(ddl: &str) -> &str {
        ddl.split(" IF NOT EXISTS ")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .unwrap_or_else(|| panic!("could not read an object name out of: {ddl}"))
    }

    /// The schema version that first created each index. Anything not named here predates versioned
    /// migrations, so `apply_baseline_schema` creates it and every database from v7 up has it.
    ///
    /// This exists because `INDEX_DDLS` is the *current* list with no history in it: the baseline and
    /// the index-only migrations all re-run the whole list, so the code cannot say which index
    /// belonged to which era. Without that, `seed_database_at_version` cannot produce a faithful v8
    /// database (one that really is missing v9's indexes), and the migration test below could not
    /// tell a migration that ran from one that was skipped. Kept in step with `docs/DATABASE.md`,
    /// which records what each migration added.
    fn index_introduced_in(name: &str) -> i64 {
        match name {
            "idx_videos_channel_created_id" => 8,
            "idx_videos_file_path" | "idx_videos_live_chat_file_path" => 9,
            "idx_videos_channel_title_normalized" => 11,
            "idx_videos_channel_created_title_id"
            | "idx_videos_channel_comments_count"
            | "idx_videos_channel_duration"
            | "idx_videos_channel_published_ordered"
            | "idx_videos_channel_published_desc" => 12,
            _ => BASELINE_SCHEMA_VERSION,
        }
    }

    #[test]
    fn needs_migration_is_outstanding_only_below_the_target() {
        // A database below the target still owes that migration; one already at it does not, which
        // is what keeps ensure_schema a no-op on an up-to-date database. The at-the-target case is
        // the boundary the whole rule turns on: re-running is harmless (every migration is
        // idempotent) but it is still work nobody asked for, on every startup.
        assert!(needs_migration(7, 8));
        assert!(!needs_migration(8, 8));
        assert!(!needs_migration(9, 8));

        // A database below the baseline owes every migration, and one at head owes none.
        assert!(needs_migration(0, BASELINE_SCHEMA_VERSION));
        assert!(needs_migration(0, SCHEMA_VERSION));
        assert!(!needs_migration(SCHEMA_VERSION, SCHEMA_VERSION));
    }

    #[tokio::test]
    async fn every_historical_version_migrates_to_the_current_schema() {
        // The gap this closes: the individual migration tests below each start from one chosen
        // version (v5 via the real fixture, v6, v9, v12), so the versions nobody picked were never
        // exercised as a *starting point* at all. That is precisely how the v8..v10 failure shipped.
        // those migrations run the whole INDEX_DDLS list, which indexes a column v11 is what adds,
        // and no test ever started at 7, 8 or 10. Rather than add one test per version as each bug is
        // found, drive every version the app has ever stamped through the full chain.
        //
        // Deliberately covers 0..=SCHEMA_VERSION inclusive: the top of the range asserts that a
        // database already at head is left alone, which is the idempotence the startup path relies on.
        for from_version in 0..=SCHEMA_VERSION {
            let pool = memory_pool().await;
            seed_database_at_version(&pool, from_version).await;

            ensure_schema(&pool).await.unwrap_or_else(|error| {
                panic!("a database stamped v{from_version} failed to reach head: {error}")
            });

            assert_eq!(
                read_user_version(&pool).await.unwrap(),
                SCHEMA_VERSION,
                "v{from_version} did not end up at the current schema version"
            );

            // Reaching head is not the same as arriving complete, and the version stamp cannot tell
            // the two apart: each migration stamps its own version, so one that is skipped entirely
            // still ends at SCHEMA_VERSION because the later ones carry the number past it. The data
            // assertions below cannot tell either. They read rows, not the objects that make those
            // rows queryable. So assert the schema itself.
            //
            // This is the v8..v10 failure seen from the other side, and it is what the seed above
            // had to become faithful for: a v11 database really is missing the five sort indexes v12
            // adds, so if migration 12 is skipped, nothing else puts them there.
            for &(_, ddl) in INDEX_DDLS {
                let name = ddl_object_name(ddl);
                assert!(
                    object_exists(&pool, "index", name).await,
                    "a database stamped v{from_version} reached head without {name}"
                );
            }

            for &(_, ddl) in TRIGGER_DDLS {
                let name = ddl_object_name(ddl);
                assert!(
                    object_exists(&pool, "trigger", name).await,
                    "a database stamped v{from_version} reached head without {name}"
                );
            }

            // The row survived and carries the normalized title every later query depends on. A
            // NULL here is the silent failure mode: LIKE never matches it, so the media stays in
            // the library while being invisible to every title search.
            let (title, normalized): (String, Option<String>) =
                sqlx::query_as("SELECT title, title_normalized FROM videos WHERE id = 1")
                    .fetch_one(&pool)
                    .await
                    .unwrap_or_else(|error| {
                        panic!("v{from_version} lost the seeded media row: {error}")
                    });
            assert_eq!(title, "Ação  Válida", "v{from_version} altered the title");
            assert_eq!(
                normalized.as_deref(),
                Some("acao valida"),
                "v{from_version} left title_normalized unusable for search"
            );

            // The comment row survived the v10 dedup and the v14 truncation untouched.
            let (comment_text,): (String,) =
                sqlx::query_as("SELECT text FROM video_comments WHERE id = 1")
                    .fetch_one(&pool)
                    .await
                    .unwrap_or_else(|error| {
                        panic!("v{from_version} lost the seeded comment row: {error}")
                    });
            assert_eq!(comment_text, "hello");

            // Re-running against the now-current database must be a no-op, since ensure_schema runs
            // on every startup.
            ensure_schema(&pool).await.unwrap_or_else(|error| {
                panic!("re-running ensure_schema after v{from_version} failed: {error}")
            });
            assert_eq!(read_user_version(&pool).await.unwrap(), SCHEMA_VERSION);
        }
    }

    #[tokio::test]
    async fn migrates_a_v9_database_that_predates_title_normalized() {
        // Reproduces the real upgrade failure a database stamped at v9 by a build that predated the
        // v11 `title_normalized` column hits: ensure_schema skips the baseline (9 >= 7) and the
        // v8/v9 migrations, so the column is never added before apply_migration_10 runs the full
        // INDEX_DDLS, which includes indexes ON title_normalized. Without the additive-column guard
        // in that loop the CREATE INDEX fails with "no such column: title_normalized" and the
        // database can no longer be opened. The tables carry every column the migration's indexes
        // reference (minus title_normalized), matching what a v9 build actually left on disk.
        let pool = memory_pool().await;

        sqlx::query(
            "CREATE TABLE channels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, youtube_handle TEXT, avatar_path TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE videos ( \
                id INTEGER PRIMARY KEY AUTOINCREMENT, \
                channel_id INTEGER NOT NULL, \
                title TEXT NOT NULL, \
                file_path TEXT NOT NULL, \
                thumbnail_path TEXT, \
                media_type TEXT NOT NULL, \
                youtube_video_id TEXT, \
                watched_at TEXT, \
                published_at TEXT, \
                duration_seconds INTEGER, \
                progress_seconds INTEGER NOT NULL DEFAULT 0, \
                has_comments INTEGER NOT NULL DEFAULT 0, \
                comments_count INTEGER NOT NULL DEFAULT 0, \
                is_live INTEGER NOT NULL DEFAULT 0, \
                has_live_chat INTEGER NOT NULL DEFAULT 0, \
                live_chat_file_path TEXT, \
                created_at TEXT NOT NULL DEFAULT (datetime('now')), \
                FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE, \
                UNIQUE (channel_id, file_path) \
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        // Includes the `text` column a real video_comments table has always carried, so the v14
        // migration (which truncates over-length comment bodies and installs the length triggers)
        // reaches a realistic table rather than a stub missing the column it operates on.
        sqlx::query(
            "CREATE TABLE video_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, video_id INTEGER NOT NULL, comment_id TEXT, parent_comment_id TEXT, author_name TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO channels (id, name, youtube_handle) VALUES (1, 'C', '@c')")
            .execute(&pool)
            .await
            .unwrap();
        // An accented title, so the backfill is pinned to the real normalizer rather than to
        // anything a plain lower() would also satisfy.
        sqlx::query(
            "INSERT INTO videos (id, channel_id, title, file_path, media_type) \
             VALUES (1, 1, 'Ação  Válida', 'video/a.mp4', 'video')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("PRAGMA user_version = 9")
            .execute(&pool)
            .await
            .unwrap();

        // The upgrade that used to fail at "no such column: title_normalized".
        ensure_schema(&pool).await.unwrap();
        assert_eq!(read_user_version(&pool).await.unwrap(), SCHEMA_VERSION);

        // The column now exists and the pre-existing row was backfilled with the real normalizer.
        let (normalized,): (Option<String>,) =
            sqlx::query_as("SELECT title_normalized FROM videos WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(normalized.as_deref(), Some("acao valida"));
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
    // that schema, it genuinely covers "open a real old user's database and migrate it" (the
    // path whose blast radius is silent data loss on upgrade), instead of a hand-built
    // approximation the test could get wrong in the same way the migration does.

    const V1_FIXTURE_RELATIVE: &str = "tests/fixtures/kavynex_v1_user_version_5.sqlite";

    fn manifest_relative_path(relative: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
    }

    fn unique_temp_db(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-migration-{tag}-{}.sqlite",
            crate::utils::naming::unique_temp_suffix()
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
        // created one would sit at the same user_version with a differently-typed column. The
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

        // A fresh database already has the index once migration 10 has run (it is no longer built
        // by the baseline. See COMMENT_UNIQUE_INDEX_DDL).
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
        // Two rows sharing (video_id, comment_id), exactly what the new index forbids.
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
    async fn ensure_schema_recovers_a_legacy_database_with_duplicate_comments() {
        // Regression for the baseline path (the CRITICAL that migration_10_collapses_... does not
        // cover: that test seeds the duplicate at user_version 9, so only apply_migration_10 runs).
        // A pre-versioned database (user_version below the baseline) that already holds a duplicate
        // (video_id, comment_id) pair must still open. When the unique index lived in the shared
        // INDEX_DDLS array, apply_baseline_schema (which runs for every such database), tried to
        // build it against the un-deduped rows, failed, rolled the whole baseline back (leaving
        // user_version at 0), and the database could never be opened again, with apply_migration_10's
        // dedupe never reached.
        let pool = memory_pool().await;

        // A legacy schema as an old app version would leave it: the four core tables, no unique
        // index on video_comments yet, and no versioned marker (user_version stays 0).
        sqlx::query(
            "CREATE TABLE channels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                youtube_handle TEXT NOT NULL,
                avatar_path TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
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
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE video_comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                video_id INTEGER NOT NULL,
                comment_id TEXT,
                parent_comment_id TEXT,
                author_name TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("INSERT INTO channels (id, name, youtube_handle) VALUES (1, 'Chan', '@chan')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO videos (id, channel_id, title, file_path, media_type)
             VALUES (1, 1, 'V', 'video/v.mp4', 'video')",
        )
        .execute(&pool)
        .await
        .unwrap();
        // Two rows sharing (video_id, comment_id): exactly what a pre-v10 database could hold.
        sqlx::query(
            "INSERT INTO video_comments (id, video_id, comment_id, author_name, text)
             VALUES (1, 1, 'c1', 'A', 'first'), (2, 1, 'c1', 'A', 'dup')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // A pre-versioned database is below the baseline; this is what forces the baseline path.
        sqlx::query("PRAGMA user_version = 0")
            .execute(&pool)
            .await
            .unwrap();

        // Must succeed (collapse the duplicate, then build the index) rather than fail the baseline
        // index build and roll back.
        ensure_schema(&pool).await.unwrap();

        let (version,): (i64,) = sqlx::query_as("PRAGMA user_version")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        // The duplicate was collapsed to the lowest id, and the invariant now holds.
        let (comments,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM video_comments WHERE video_id = 1 AND comment_id = 'c1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(comments, 1, "the duplicate comment must be collapsed");

        assert!(
            object_exists(&pool, "index", "idx_video_comments_video_comment_unique").await,
            "the comment unique index must exist after the migration"
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
        // pool consumer, never left in the OFF state the rebuild toggled it into.
        let (foreign_keys,): (i64,) = sqlx::query_as("PRAGMA foreign_keys")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            foreign_keys, 1,
            "foreign keys must be re-enabled even when the rebuild fails"
        );
    }

    #[tokio::test]
    async fn an_unrestored_rebuild_connection_is_discarded_instead_of_returned_to_the_pool() {
        // The last line of defense behind the rebuild: apply_table_rebuilds normally restores
        // `PRAGMA foreign_keys = ON` itself, and the test above pins that. This covers what happens
        // when that restore never ran (the PRAGMA itself failed, or a panic unwound through the
        // rebuild), which leaves `restored` false. The connection then still has enforcement OFF,
        // and handing it back to the pool would silently give the next consumer a connection on
        // which every ON DELETE CASCADE is inert. RebuildConnection's Drop detaches it instead.
        //
        // Asserted through the pool rather than by inspecting the guard: with max_connections(1) a
        // detached connection forces the pool to open a fresh one, which picks up foreign_keys from
        // the connect options, so the observable difference between detaching and not is exactly
        // the PRAGMA the next consumer sees.
        let pool = memory_pool_with_foreign_keys().await;

        let mut conn = pool.acquire().await.unwrap();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&mut *conn)
            .await
            .unwrap();

        drop(RebuildConnection {
            conn: Some(conn),
            restored: false,
        });

        let (foreign_keys,): (i64,) = sqlx::query_as("PRAGMA foreign_keys")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            foreign_keys, 1,
            "a connection whose enforcement was never restored must not come back from the pool"
        );
    }

    #[tokio::test]
    async fn a_restored_rebuild_connection_goes_back_to_the_pool() {
        // The other half of the guard: on the normal path the restore has run, so the connection is
        // reusable and detaching it would throw away a live connection on every rebuild. Pinning
        // both directions is what makes the Drop impl's condition meaningful rather than "always
        // detach", which would also satisfy the test above.
        let pool = memory_pool_with_foreign_keys().await;

        let mut conn = pool.acquire().await.unwrap();
        // A table created on this connection is only visible through the *same* in-memory
        // connection, so finding it afterwards proves the pool handed the very same one back.
        // Created on the held connection, not through the pool: max_connections is 1, so a pool
        // query here would wait on the connection this test is holding.
        sqlx::query("CREATE TABLE returned_marker (id INTEGER PRIMARY KEY)")
            .execute(&mut *conn)
            .await
            .unwrap();

        drop(RebuildConnection {
            conn: Some(conn),
            restored: true,
        });

        let (count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM sqlite_master WHERE name = 'returned_marker'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            count, 1,
            "a restored connection must be reused, not discarded"
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
    async fn rebuilding_videos_puts_its_triggers_and_indexes_back() {
        // The rebuild path is kept ready but unused, so nothing has ever run it against a real
        // table, and `videos` is the only one carrying triggers. Dropping a table drops its
        // triggers with it, so a rebuild that forgot to recreate them would hand back a table that
        // still looks right and silently accepts the rows the triggers exist to reject. That is the
        // failure this pins, because the first real rebuild should be a data change rather than the
        // first outing for this plumbing.
        let pool = memory_pool().await;
        ensure_schema(&pool).await.unwrap();

        sqlx::query("INSERT INTO channels (id, name, youtube_handle) VALUES (1, 'C', '@c')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO videos (id, channel_id, title, title_normalized, file_path, media_type) \
             VALUES (1, 1, 'kept', 'kept', 'video/kept.mp4', 'video')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // The same shape the schema already declares, under a staging name: this rebuild changes
        // nothing about the table, so anything that differs afterwards was lost by the rebuild
        // itself rather than by the new definition.
        let new_ddl = VIDEOS_TABLE_DDL.replace(
            "CREATE TABLE IF NOT EXISTS videos (",
            "CREATE TABLE videos_rebuilt (",
        );
        let rebuild = TableRebuild {
            table: "videos",
            staging_table: "videos_rebuilt",
            new_ddl: Box::leak(new_ddl.into_boxed_str()),
            carried_columns: "id, channel_id, title, title_normalized, file_path, thumbnail_path, \
                              media_type, youtube_video_id, watched_at, published_at, \
                              duration_seconds, progress_seconds, has_comments, comments_count, \
                              is_live, has_live_chat, live_chat_file_path, created_at",
        };

        apply_table_rebuilds(&pool, std::slice::from_ref(&rebuild), SCHEMA_VERSION)
            .await
            .unwrap();

        let (title,): (String,) = sqlx::query_as("SELECT title FROM videos WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(title, "kept");

        // Both triggers have to be enforcing again, not merely present.
        let live_chat_violation = sqlx::query(
            "INSERT INTO videos (channel_id, title, title_normalized, file_path, media_type, has_live_chat, live_chat_file_path) \
             VALUES (1, 't', 't', 'video/a.mp4', 'video', 1, NULL)",
        )
        .execute(&pool)
        .await;
        assert!(
            live_chat_violation.is_err(),
            "the live chat trigger must survive a rebuild of videos"
        );

        let title_violation = sqlx::query(
            "INSERT INTO videos (channel_id, title, title_normalized, file_path, media_type) \
             VALUES (1, 't', NULL, 'video/b.mp4', 'video')",
        )
        .execute(&pool)
        .await;
        assert!(
            title_violation.is_err(),
            "the title_normalized trigger must survive a rebuild of videos"
        );

        // Indexes are recreated the same way and from the same catalog, so a rebuild that lost
        // them would leave the grid's hottest query unserved while still returning correct rows.
        let (index_count,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND tbl_name = 'videos' \
             AND name LIKE 'idx_%'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let expected_indexes = INDEX_DDLS
            .iter()
            .filter(|(table, _)| *table == "videos")
            .count() as i64;
        assert_eq!(index_count, expected_indexes);
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
