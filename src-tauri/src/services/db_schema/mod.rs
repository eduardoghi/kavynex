use sqlx::{SqliteConnection, SqlitePool};

use crate::services::database::db_error;
use crate::{AppError, AppErrorCode, AppResult};

/// Current schema version. Bump this and add a matching migration block in
/// `ensure_schema` whenever the schema changes.
pub(crate) const SCHEMA_VERSION: i64 = 15;

/// Version produced by the idempotent baseline reconcile (`apply_baseline_schema`).
/// It stays fixed even as `SCHEMA_VERSION` grows. Every database created before
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
    apply_migration_13, apply_migration_14, apply_migration_15, apply_migration_8,
    apply_migration_9,
};

// SQLite's table-rebuild procedure, for a change `ALTER TABLE ADD COLUMN` or a trigger cannot
// express. Unused so far and kept ready; see the module for why.
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
/// mutation gate made the cost of that visible. Nine identical `current_version < N` expressions
/// generate nine mutants with the same description, so they cannot be told apart by anything but a
/// line number. Three of them are equivalent (skipping v8, v9 or v11 changes nothing, because a
/// later migration re-runs the whole `INDEX_DDLS` list and v13 redoes v11's backfill), and with the
/// comparison inlined there was no way to exclude those three without also dropping the five that
/// catch a real skipped migration. Naming the rule once gives it one mutant, which can be reasoned
/// about (and excluded, if it turns out equivalent) on its own terms.
///
/// The `>` refusal above is deliberately not routed through this. It decides whether the database
/// is openable at all, which is a different question from which migrations are outstanding.
fn needs_migration(current: i64, target: i64) -> bool {
    current < target
}

/// Brings the database up to `SCHEMA_VERSION`, applying only the migrations the
/// on-disk `user_version` is missing. Idempotent and safe to run on every startup.
/// A database already at `SCHEMA_VERSION` is left untouched. Runs as part of the
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
        // Distinct code (not the generic db_error). The frontend must tell "this build is too
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

    // Baseline (versions 0..=6 -> 7). The idempotent reconcile that predates versioned
    // migrations. Every legacy and fresh database goes through this exactly once.
    if needs_migration(current_version, BASELINE_SCHEMA_VERSION) {
        apply_baseline_schema(pool).await?;
    }

    // v8. Adds idx_videos_channel_created_id. Additive, so it just runs the index DDLs.
    if needs_migration(current_version, 8) {
        apply_migration_8(pool).await?;
    }

    // v9. Adds idx_videos_file_path and idx_videos_live_chat_file_path. Additive, so it just
    // runs the index DDLs.
    if needs_migration(current_version, 9) {
        apply_migration_9(pool).await?;
    }

    // v10. Adds the partial unique index on (video_id, comment_id). A pre-v10 database could in
    // principle already hold a duplicate the index would reject, so this migration first collapses
    // any duplicate comment rows and only then builds the index (see apply_migration_10).
    if needs_migration(current_version, 10) {
        apply_migration_10(pool).await?;
    }

    // v11. Adds the `title_normalized` column (accent/case-folded title) plus its index, and
    // backfills the column for existing rows. Not index-only. The backfill is computed in Rust
    // because SQLite cannot accent-fold in SQL (see apply_migration_11).
    if needs_migration(current_version, 11) {
        apply_migration_11(pool).await?;
    }

    // v12. Adds the per-sort-category indexes for `list_media_page`.
    if needs_migration(current_version, 12) {
        apply_migration_12(pool).await?;
    }

    // v13. Enforces the videos live-chat invariant on databases whose table predates the CHECK.
    // Repairs any already-inconsistent row, then adds the enforcement triggers. Not index-only,
    // but still additive (no table rebuild). See apply_migration_13.
    if needs_migration(current_version, 13) {
        apply_migration_13(pool).await?;
    }

    // v14. Enforces the comment-body length ceiling on databases whose video_comments table predates
    // the CHECK. Truncates any already-over-length row, then adds the enforcement triggers. Additive
    // (no table rebuild), same shape as v13. See apply_migration_14.
    if needs_migration(current_version, 14) {
        apply_migration_14(pool).await?;
    }

    // v15. Adds `videos.comments_state`, which records what a comment fetch concluded rather than
    // only how many comments were stored. Additive, plus a one-off promotion of the rows that carry
    // evidence of a fetch. See apply_migration_15.
    if needs_migration(current_version, 15) {
        apply_migration_15(pool).await?;
    }

    // Each migration is guarded by version and transactional (it stamps the new
    // user_version inside its own transaction, so a crash leaves the database fully at the
    // old or the new version). An additive migration (a new column or index) runs the
    // guarded ALTER/CREATE like `apply_migration_8`. Enforcing a new invariant on an existing
    // table can often stay additive too. `apply_migration_13` backports the videos live-chat
    // CHECK with a trigger rather than a rebuild. A change that genuinely rewrites the table (a
    // column type, dropping a column, replacing a UNIQUE) cannot be expressed with
    // `ALTER TABLE ADD COLUMN` or a trigger, so it rebuilds the affected table with
    // `apply_table_rebuilds` (create new, copy, drop, rename, with foreign keys disabled and
    // verified) instead of being silently skipped by the additive baseline above.

    Ok(())
}
#[cfg(test)]
mod tests;
