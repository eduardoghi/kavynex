//! Read-only schema introspection over `pragma_*` virtual tables: whether a table has a given
//! column, a UNIQUE index on an exact column list, or an `ON DELETE CASCADE` foreign key. Used both
//! by the migrations here and by the database-import validation (`db_backup::import`) to tell a real
//! kavynex database from a look-alike. Every `table` argument is a `&'static str` so the pragma name
//! it is interpolated into can only ever be an internal schema constant, never runtime input.
//!
//! Tests live in the parent module's `mod tests`.

use sqlx::SqlitePool;

use crate::services::database::db_error;
use crate::AppResult;

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
        by_index
            .entry(index_name)
            .or_default()
            .push((seqno, column));
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
