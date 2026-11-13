//! Test helpers shared across the crate, so a test module does not carry its own copy of the same
//! setup. Compiled only for tests (`#[cfg(test)]` at the declaration in `lib.rs`).
//!
//! A family with helpers of its own keeps them beside it (`services/db_backup/test_support.rs`,
//! `commands/test_ipc.rs`). What is here is what tests all over the crate need.

use std::path::PathBuf;

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

/// A path under the system temp directory that nothing else uses, named after `label` so a
/// leftover says which test made it. Not created, since some tests need the path to be missing.
///
/// The suffix comes from [`crate::utils::naming::unique_temp_suffix`], which `ci.yml`'s "Verify temp
/// paths are built from the shared unique suffix" step requires, since pid and time alone collide.
pub fn unique_temp_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "kavynex-test-{label}-{}",
        crate::utils::naming::unique_temp_suffix()
    ))
}

/// `path` spelled through this machine's own administrative share (`C:\x` as `\\localhost\C$\x`),
/// which names the same file and does not canonicalize to the same string. `None` where the share
/// cannot be reached (not an administrator, or the Server service is off), so a test built on it
/// has to skip there.
///
/// It is the one way to have a real second spelling of a path in a test. A symlink and a junction
/// are resolved by `canonicalize`, so they never reach the code that exists for the alias.
#[cfg(windows)]
pub fn admin_share_spelling(path: &std::path::Path) -> Option<PathBuf> {
    let text = path.to_str()?;
    let text = text.strip_prefix(r"\\?\").unwrap_or(text);
    let mut characters = text.chars();
    let drive = characters.next().filter(char::is_ascii_alphabetic)?;
    let rest = characters.as_str().strip_prefix(':')?;
    let through_share = PathBuf::from(format!(r"\\localhost\{drive}${rest}"));

    if through_share.exists() {
        Some(through_share)
    } else {
        None
    }
}
