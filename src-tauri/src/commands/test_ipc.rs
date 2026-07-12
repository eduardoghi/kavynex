//! Shared helpers for driving `#[tauri::command]`s through a real IPC round trip under the
//! mock runtime. Used by the per-command `#[cfg(test)]` modules so the invoke boilerplate and
//! the in-memory database setup are written once. Each test module keeps its own `test_webview`
//! because `tauri::generate_handler!` needs the concrete list of commands under test.

use crate::services::database::Db;

/// Builds a [`Db`] over a fresh in-memory database with the schema applied, on Tauri's async
/// runtime so the pool's background tasks share the runtime [`invoke`] drives commands on.
pub fn memory_db() -> Db {
    tauri::async_runtime::block_on(async {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory database");
        crate::services::db_schema::ensure_schema(&pool)
            .await
            .expect("apply schema");
        Db::from_pool(pool)
    })
}

/// Sends one IPC invoke to a mock webview and returns the raw success/error response, so a test
/// can assert on the deserialized payload or the error `code`.
pub fn invoke(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
    body: serde_json::Value,
) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(any(windows, target_os = "android")) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}
