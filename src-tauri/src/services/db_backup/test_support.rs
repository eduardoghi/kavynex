//! Test helpers shared by this family's test modules.
//!
//! This exists because of a shape the family kept reproducing. `db_backup` was split into
//! `snapshot`, `restore`, `integrity`, `external` and `import`, and every one of those splits moved
//! the code while leaving its tests behind in `mod.rs`, not out of preference, but because the
//! tests shared the three helpers below and nothing else would have compiled. So `mod.rs` kept
//! growing as code left it, which is the opposite of what a split is for, and each new split had to
//! decide the question again and reach the same answer.
//!
//! With the helpers here, a test can live next to the function it exercises. `integrity.rs` is the
//! first to do so; the rest follow when their own submodule is next touched, rather than as one
//! large move of tests nobody is otherwise changing.
//!
//! `#[cfg(test)]` at the declaration and `pub(super)` here. This is scaffolding compiled only for
//! tests and reachable only from inside `db_backup`.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

/// A fresh, uniquely named directory under the system temp dir.
///
/// The suffix comes from [`crate::utils::naming::unique_temp_suffix`] rather than from a raw
/// timestamp. Pid plus nanoseconds alone collides when two tests land in the same clock tick, which
/// was a real intermittent failure on macOS that surfaced nowhere near its cause. `ci.yml`'s "Verify
/// temp paths are built from the shared unique suffix" step enforces it.
pub(super) fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "kavynex_dbbak_{label}_{}",
        crate::utils::naming::unique_temp_suffix()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A minimal SQLite database holding one table and one row. Enough for the tests that only need a
/// file the backup machinery will treat as a real database.
///
/// Deliberately not the app's schema. The tests that exercise import validation need the richer
/// `seed_kavynex_db` shape (every core table, the columns the validation names, the constraints the
/// app relies on), and that one stays with them because it is about what import checks rather than
/// about having a database at all.
pub(super) async fn seed_db(path: &Path) {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO t (v) VALUES ('hello')")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}

/// Sets a file's modified time, for the throttle tests that have to place a marker in the past
/// rather than wait for real time to pass.
pub(super) fn filetime_set(path: &Path, time: SystemTime) {
    let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_modified(time).unwrap();
}
