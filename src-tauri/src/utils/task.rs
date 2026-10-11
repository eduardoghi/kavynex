use crate::{AppError, AppErrorCode, AppResult};

/// Runs a blocking closure on the dedicated blocking thread pool and awaits it, mapping a join
/// failure to a catalogued error. Convention. Any function whose body does synchronous filesystem
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

/// How long the readers of a child's output may keep draining once the child itself has exited.
///
/// The child is gone, but a grandchild it started (Deno, FFmpeg) can inherit its pipes and hold them
/// open, and a reader waiting on such a pipe never sees the end. Without a bound the run kept its
/// slot in the semaphore and its registry entry until the app restarted.
pub const PIPE_DRAIN_AFTER_EXIT: std::time::Duration = std::time::Duration::from_secs(10);

/// Awaits `handle` for at most `limit`, aborting it when the time runs out. `None` means it did not
/// finish, a join error is `Some(Err(..))`.
pub async fn join_within<T>(
    mut handle: tauri::async_runtime::JoinHandle<T>,
    limit: std::time::Duration,
) -> Option<Result<T, tauri::Error>> {
    match tokio::time::timeout(limit, &mut handle).await {
        Ok(joined) => Some(joined),
        Err(_) => {
            handle.abort();
            None
        }
    }
}

#[cfg(test)]
mod join_tests {
    use super::*;

    #[tokio::test]
    async fn a_reader_that_never_finishes_is_let_go_after_the_limit() {
        let stuck = tauri::async_runtime::spawn(std::future::pending::<()>());

        assert!(join_within(stuck, std::time::Duration::from_millis(20))
            .await
            .is_none());
    }

    #[tokio::test]
    async fn a_reader_that_finishes_in_time_hands_back_what_it_read() {
        let done = tauri::async_runtime::spawn(async { 7 });

        assert_eq!(
            join_within(done, std::time::Duration::from_secs(5))
                .await
                .map(|joined| joined.unwrap()),
            Some(7)
        );
    }
}
