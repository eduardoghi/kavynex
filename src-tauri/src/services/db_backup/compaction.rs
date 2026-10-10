//! The user-triggered `VACUUM`. SQLite keeps the pages deleted rows leave behind and reuses them for
//! later writes, but never hands them back to the disk on its own. Deleting a channel with a large
//! comment history leaves the file at its old size, and Settings keeps reporting that size.

use serde::Serialize;
use sqlx::SqlitePool;

use super::{backup_error, BACKUP_IN_PROGRESS};
use crate::services::logger;
use crate::AppResult;

/// What a compaction gave back.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct DatabaseCompaction {
    /// How many bytes smaller the database is. Annotated `number` because ts-rs emits `bigint` for
    /// `u64` by default, and this crosses IPC as a plain JSON number.
    #[ts(type = "number")]
    pub freed_bytes: u64,
    /// [`freed_bytes`](Self::freed_bytes) rendered with the formatter Settings uses for the
    /// database size, so the two read in the same units.
    pub formatted_freed_size: String,
}

/// The database's size in pages, which is what `VACUUM` shrinks. Read through SQLite rather than off
/// the file, because in WAL mode the file only shrinks once the log is checkpointed.
async fn database_bytes(pool: &SqlitePool) -> AppResult<u64> {
    let (page_count, page_size): (i64, i64) =
        sqlx::query_as("SELECT page_count, page_size FROM pragma_page_count(), pragma_page_size()")
            .fetch_one(pool)
            .await
            .map_err(|error| backup_error("failed to read the database size", error))?;

    Ok(u64::try_from(page_count.saturating_mul(page_size)).unwrap_or(0))
}

/// Rewrites the database without its free pages and truncates the write-ahead log, so the file on
/// disk shrinks right away.
///
/// Holds the backup lock, so it never overlaps the daily snapshot. Both read the whole database,
/// and a `VACUUM` needs free space of up to twice the database's size while it runs (the rewritten
/// copy plus the log it goes through). A failure leaves the database as it was, because `VACUUM`
/// is a single transaction.
pub async fn compact_database(pool: &SqlitePool) -> AppResult<DatabaseCompaction> {
    let _guard = BACKUP_IN_PROGRESS.lock().await;

    let before = database_bytes(pool).await?;

    sqlx::query("VACUUM")
        .execute(pool)
        .await
        .map_err(|error| backup_error("failed to compact the database", error))?;

    // VACUUM writes the rewritten pages through the log, so the main file keeps its old size until
    // a checkpoint copies them back and truncates it. Best effort. The space is reclaimed either
    // way at the next checkpoint, which the app also runs at exit.
    if let Err(error) = crate::services::database::checkpoint_wal(pool).await {
        logger::warn(
            "db_compaction",
            format!(
                "the database was compacted but the write-ahead log was not folded in: {error}"
            ),
        );
    }

    let after = database_bytes(pool).await?;
    let freed_bytes = before.saturating_sub(after);

    logger::info(
        "db_compaction",
        format!("compacted the database from {before} to {after} bytes"),
    );

    Ok(DatabaseCompaction {
        freed_bytes,
        formatted_freed_size: crate::utils::format::format_bytes(freed_bytes),
    })
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

    use super::*;
    use crate::services::db_backup::test_support::temp_dir;

    #[tokio::test]
    async fn compaction_gives_back_the_pages_deleted_rows_left_and_keeps_the_rest() {
        let dir = temp_dir("compaction");
        let path = dir.join("kavynex.db");
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true)
                    .journal_mode(SqliteJournalMode::Wal),
            )
            .await
            .unwrap();

        sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        // About 4 MB of rows, then most of them deleted, the shape a channel delete leaves.
        sqlx::query(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) \
             INSERT INTO t (v) SELECT hex(zeroblob(1000)) FROM n",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("DELETE FROM t WHERE id > 10")
            .execute(&pool)
            .await
            .unwrap();
        crate::services::database::checkpoint_wal(&pool)
            .await
            .unwrap();
        let file_before = std::fs::metadata(&path).unwrap().len();

        let compaction = compact_database(&pool).await.unwrap();

        // Most of the 4 MB came back, and the file itself shrank without waiting for another
        // checkpoint.
        assert!(
            compaction.freed_bytes > 3_000_000,
            "freed only {} bytes",
            compaction.freed_bytes
        );
        assert!(!compaction.formatted_freed_size.is_empty());
        let file_after = std::fs::metadata(&path).unwrap().len();
        assert!(
            file_after + 3_000_000 < file_before,
            "the file went from {file_before} to {file_after} bytes"
        );

        let (rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM t")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rows, 10);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn compacting_a_database_with_nothing_to_give_back_frees_nothing() {
        let dir = temp_dir("compaction-noop");
        let path = dir.join("kavynex.db");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        compact_database(&pool).await.unwrap();

        let compaction = compact_database(&pool).await.unwrap();

        assert_eq!(compaction.freed_bytes, 0);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
