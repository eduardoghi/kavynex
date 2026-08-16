//! The versioned schema migrations themselves: the baseline reconcile that every pre-versioning
//! database goes through once, and one `apply_migration_*` per version above it. Split out of
//! `mod.rs` so the dispatcher there (`ensure_schema`) reads as a list of version guards while the
//! SQL work each version performs lives here.
//!
//! Every function is transactional and stamps its own `user_version` inside that transaction, so a
//! crash leaves the database fully at the previous version or fully at the next one. Tests live in
//! the parent's `mod tests`, alongside the migration-matrix test that drives all of them.

use sqlx::{SqliteConnection, SqlitePool};

use super::ddl::*;
use super::{set_user_version, table_has_column, BASELINE_SCHEMA_VERSION};
use crate::services::database::db_error;
use crate::AppResult;

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

/// Applies an additive, index-only migration: re-runs every index DDL (all guarded with
/// `IF NOT EXISTS`, so pre-existing indexes are untouched and only the ones this version adds
/// are created) and stamps `target_version`, both in the same transaction so a crash leaves
/// the database fully at the old or the new version.
async fn apply_index_only_migration(pool: &SqlitePool, target_version: i64) -> AppResult<()> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| db_error("failed to begin schema migration", error))?;

    // INDEX_DDLS includes indexes on title_normalized (and the other additive columns), which v11
    // is what adds. A database stamped at v7/v8/v9 by a build that predated those columns reaches
    // this loop before v11 runs, so ensure any missing additive column exists first. Otherwise the
    // CREATE INDEX below fails with "no such column". Idempotent (guarded per column) and a no-op
    // once the columns are present (e.g. the v12 caller, which runs after v11).
    ensure_videos_additive_columns(&mut tx).await?;

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
pub(super) async fn apply_migration_8(pool: &SqlitePool) -> AppResult<()> {
    apply_index_only_migration(pool, 8).await
}

/// v9: creates `idx_videos_file_path` and `idx_videos_live_chat_file_path`, which keep the
/// per-artifact reference-count lookups run on delete off a full table scan. Additive, so it
/// reaches databases created before v9 by re-running the guarded index DDLs.
pub(super) async fn apply_migration_9(pool: &SqlitePool) -> AppResult<()> {
    apply_index_only_migration(pool, 9).await
}

/// v12: creates the four `list_media_page` sort indexes (`idx_videos_channel_created_title_id`,
/// `idx_videos_channel_comments_count`, `idx_videos_channel_duration`,
/// `idx_videos_channel_published_ordered`). Additive, so it reaches databases created before v12
/// by re-running the guarded index DDLs.
pub(super) async fn apply_migration_12(pool: &SqlitePool) -> AppResult<()> {
    apply_index_only_migration(pool, 12).await
}

/// v13: brings the videos row invariants to databases whose `videos` table predates them. The
/// live-chat one (has_live_chat set implies a stored live_chat_file_path) and the
/// title_normalized one (never NULL).
///
/// Such a database's `videos` table already exists, so the CHECK in VIDEOS_TABLE_DDL never reached
/// it (CREATE TABLE IF NOT EXISTS is a no-op and SQLite cannot add a CHECK to an existing table
/// without rebuilding it). Rather than rebuild the largest table just to add a CHECK, this repairs
/// any row that already violates an invariant and installs BEFORE INSERT/UPDATE triggers that
/// reject future violations. A plain `CREATE TRIGGER` on the existing table, touching no row
/// content.
///
/// Neither repair destroys anything: the live-chat one only clears `has_live_chat` where no path is
/// stored (correcting a flag to match the absent file), and the title one only computes a value for
/// rows that have none. Both must run before the triggers, which fire only on new writes and would
/// otherwise leave a pre-existing bad row in place, and, worse for the title one, would then
/// reject every later edit of that row's title. The repairs, the trigger creation and the version
/// stamp share one transaction, so a crash leaves the database fully at v12 or fully at v13.
pub(super) async fn apply_migration_13(pool: &SqlitePool) -> AppResult<()> {
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
    // assuming the v11 that adds it has run. In the normal order it has, but a database stamped
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

/// v14: brings the comment-body length ceiling to databases whose `video_comments` table predates
/// it. Such a table already exists, so the `CHECK` added to VIDEO_COMMENTS_TABLE_DDL never reached it
/// (CREATE TABLE IF NOT EXISTS is a no-op and SQLite cannot add a CHECK to an existing table without
/// rebuilding it). Rather than rebuild the comments table just to add a CHECK, this truncates any row
/// that already exceeds the ceiling and installs BEFORE INSERT/UPDATE triggers that reject future
/// ones (the same additive strategy as v13.
///
/// The truncation is non-destructive beyond the overflow itself: it keeps the first
/// `MAX_COMMENT_TEXT_CHARS` characters (`substr` uses character semantics on a TEXT value), the same
/// cap the app's own write path already applies (media_comments::truncate_to_chars), so a comment
/// stored by the app is never affected), only an out-of-band/oversized row is. It must run before the
/// triggers, which fire only on new writes and would otherwise leave a pre-existing over-length row
/// in place. The repair, the trigger creation and the version stamp share one transaction, so a crash
/// leaves the database fully at v13 or fully at v14. The TRIGGER_DDLS list is re-run in full (every
/// statement is `IF NOT EXISTS`), so the v13 triggers are untouched and only the two new comment ones
/// are created.
pub(super) async fn apply_migration_14(pool: &SqlitePool) -> AppResult<()> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| db_error("failed to begin schema migration", error))?;

    let repaired: u64 = sqlx::query(
        "UPDATE video_comments SET text = substr(text, 1, 16000) WHERE LENGTH(text) > 16000",
    )
    .execute(&mut *tx)
    .await
    .map_err(|error| db_error("failed to truncate over-length comment text", error))?
    .rows_affected();

    if repaired > 0 {
        crate::services::logger::warn(
            "db_schema",
            format!("v14: truncated {repaired} over-length comment(s) to the maximum length"),
        );
    }

    for &(_, ddl) in TRIGGER_DDLS {
        sqlx::query(ddl)
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("failed to create trigger", error))?;
    }

    set_user_version(&mut tx, 14).await?;

    tx.commit()
        .await
        .map_err(|error| db_error("failed to commit schema migration", error))?;

    Ok(())
}

/// v15: adds `videos.comments_state` and promotes the rows that already carry evidence of a
/// comment fetch.
///
/// The column records what a fetch *concluded*, which `has_comments`/`comments_count` cannot say:
/// both are derived from the number of rows stored, so 0 means "nothing was ever fetched" and "a
/// fetch ran and found nothing to store" alike. The first is not a final answer and the second is,
/// and the player offered its Fetch button on both, so a user could re-run an operation that could
/// never return anything.
///
/// The backfill is deliberately one-directional. A row with stored comments is promoted to
/// `available`, because the count is proof a fetch ran and returned something. A row with none is
/// left at `unknown`, which is the honest value: nothing before this column recorded whether a
/// fetch had been attempted, so the app cannot claim one was. Those rows settle themselves the
/// first time the user refreshes them.
///
/// The column-add, the promotion and the version stamp share one transaction, so a crash leaves
/// the database fully at v14 or fully at v15.
pub(super) async fn apply_migration_15(pool: &SqlitePool) -> AppResult<()> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| db_error("failed to begin schema migration", error))?;

    // Adds `comments_state` when the table predates it. Idempotent, as everywhere this is used.
    ensure_videos_additive_columns(&mut tx).await?;

    // The promotion reads `comments_count`, which is part of the base table DDL rather than of the
    // additive list, so `ensure_videos_additive_columns` above does not create it. A `videos` table
    // old enough to predate that column therefore reaches here without it, and the UPDATE would
    // fail the whole migration with "no such column" instead of adding the new one. Ask first.
    //
    // Skipping the promotion on such a database is not a loss: with no stored count there is no
    // evidence a fetch ever ran, so every row keeping the `unknown` default is the honest outcome,
    // which is the same answer the backfill reaches for a row with no comments anyway. The same
    // shape of guard v13 applies before it reads `title_normalized`.
    if table_has_column(&mut *tx, "videos", "comments_count").await? {
        sqlx::query(
            "UPDATE videos SET comments_state = 'available'              WHERE comments_state = 'unknown' AND comments_count > 0",
        )
        .execute(&mut *tx)
        .await
        .map_err(|error| db_error("failed to promote rows with stored comments", error))?;
    }

    set_user_version(&mut tx, 15).await?;

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
pub(super) async fn apply_migration_10(pool: &SqlitePool) -> AppResult<()> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| db_error("failed to begin schema migration", error))?;

    // Back the duplicate-detection GROUP BY (below) with a temporary index covering
    // (video_id, comment_id, id) so the one-time cleanup answers MIN(id) per group from the index
    // instead of full-scanning and sorting video_comments, which, on a user with a large comment
    // history, would otherwise make this startup migration noticeably slow. The real partial unique
    // index cannot stand in for it here: it is created below (COMMENT_UNIQUE_INDEX_DDL) only after
    // the duplicates it would reject are gone. It lives outside INDEX_DDLS precisely so the baseline
    // loop, which runs before this migration, never attempts it against un-deduped data. The temp
    // index is dropped again before the real index is built.
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

    // Same reason as apply_index_only_migration: INDEX_DDLS indexes title_normalized, a column v11
    // adds. A database reaching v10 without it (stamped 7..10 by a pre-v11 build) would fail the
    // CREATE INDEX below, so add any missing additive column before building the indexes.
    ensure_videos_additive_columns(&mut tx).await?;

    for &(_, ddl) in INDEX_DDLS {
        sqlx::query(ddl)
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("failed to create index", error))?;
    }

    // Now that duplicates are collapsed, build the real partial unique index. It is created here,
    // not by the INDEX_DDLS loop above and not by the baseline, so it is only ever built against
    // already-deduped data (see COMMENT_UNIQUE_INDEX_DDL for why that ordering is load-bearing).
    sqlx::query(COMMENT_UNIQUE_INDEX_DDL)
        .execute(&mut *tx)
        .await
        .map_err(|error| db_error("failed to create the comment unique index", error))?;

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
/// `utils::text::normalize_search_text` used at insert/update time. That shared normalization is
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
pub(super) async fn apply_migration_11(pool: &SqlitePool) -> AppResult<()> {
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
pub(super) async fn apply_baseline_schema(pool: &SqlitePool) -> AppResult<()> {
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
