//! SQLite's table-rebuild procedure, for the schema changes `ALTER TABLE ADD COLUMN` and a trigger
//! cannot express: a new or changed `CHECK`, a new `UNIQUE`, a changed column type, a dropped
//! column. Split out of `mod.rs` because it is the one migration mechanism with machinery of its
//! own (a pooled connection whose foreign-key state must never leak back), and because it is
//! deliberately unused as of `SCHEMA_VERSION 14` - kept ready and tested so the first real rebuild
//! is a data change rather than new untested plumbing.
//!
//! Tests live in the parent's `mod tests`.

use sqlx::{Connection, SqliteConnection, SqlitePool};

use super::ddl::*;
use super::set_user_version;
use crate::services::database::db_error;
use crate::AppResult;

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
pub(super) struct RebuildConnection {
    pub(super) conn: Option<sqlx::pool::PoolConnection<sqlx::Sqlite>>,
    pub(super) restored: bool,
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

    // The comment unique index lives outside INDEX_DDLS (see COMMENT_UNIQUE_INDEX_DDL), so recreate
    // it explicitly when its table was rebuilt. Safe unconditionally here: a rebuild only runs well
    // after v10, so no duplicate the index forbids can remain.
    if rebuilt_tables.contains(COMMENT_UNIQUE_INDEX_TABLE) {
        sqlx::query(COMMENT_UNIQUE_INDEX_DDL)
            .execute(&mut *tx)
            .await
            .map_err(|error| {
                db_error(
                    "failed to recreate the comment unique index after rebuild",
                    error,
                )
            })?;
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
