use crate::{AppError, AppErrorCode, AppResult};

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
