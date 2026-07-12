use crate::{AppError, AppErrorCode, AppResult};

/// Runs a blocking closure on the dedicated blocking thread pool and awaits it, mapping a join
/// failure to a catalogued error. Convention: any function whose body does synchronous filesystem
/// or other blocking work (typically named with a `_sync` suffix) must be invoked through this
/// from an async context, so a Tokio worker thread is never stalled on slow I/O.
pub async fn run_blocking<F, T>(f: F) -> AppResult<T>
where
    F: FnOnce() -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| {
        AppError::from_code(
            AppErrorCode::BlockingTaskJoinFailed,
            format!("blocking task join failed: {e}"),
        )
    })?
}
