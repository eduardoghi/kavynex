//! Test helpers shared across the crate, so a test module does not carry its own copy of the same
//! setup. Compiled only for tests (`#[cfg(test)]` at the declaration in `lib.rs`).
//!
//! A family with helpers of its own keeps them beside it (`services/db_backup/test_support.rs`,
//! `commands/test_ipc.rs`). What is here is what tests all over the crate need.

use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};

/// A fresh in-memory database with no schema, for the tests of the schema itself.
pub async fn empty_memory_pool() -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("open an in-memory database")
}

/// A fresh in-memory database with the app's real schema applied (`db_schema::ensure_schema`), so a
/// test runs against the same tables, constraints and triggers the app does. Foreign keys are on,
/// as sqlx turns them on for every connection.
pub async fn memory_pool() -> SqlitePool {
    let pool = empty_memory_pool().await;

    crate::services::db_schema::ensure_schema(&pool)
        .await
        .expect("apply the schema");

    pool
}
