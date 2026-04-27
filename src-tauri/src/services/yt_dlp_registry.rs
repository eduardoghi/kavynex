use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use tokio::sync::Mutex;

use crate::{AppError, AppErrorCode, AppResult};

fn active_downloads() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static ACTIVE_DOWNLOADS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    ACTIVE_DOWNLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn register_download_run(run_id: &str) -> AppResult<Arc<AtomicBool>> {
    let mut guard = active_downloads().lock().await;

    if guard.contains_key(run_id) {
        return Err(AppError::from_code(
            AppErrorCode::YtDlpRunAlreadyActive,
            "run_id is already active",
        ));
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    guard.insert(run_id.to_string(), Arc::clone(&cancel_flag));

    Ok(cancel_flag)
}

pub async fn unregister_download_run(run_id: &str) {
    let mut guard = active_downloads().lock().await;
    guard.remove(run_id);
}

pub async fn cancel_media_download_async(run_id: &str) -> AppResult<()> {
    let normalized_run_id = run_id.trim();

    if normalized_run_id.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidRunId,
            "run_id is empty",
        ));
    }

    let guard = active_downloads().lock().await;

    let cancel_flag = guard.get(normalized_run_id).ok_or_else(|| {
        AppError::from_code(
            AppErrorCode::InvalidRunId,
            format!("run_id '{}' is not active", normalized_run_id),
        )
    })?;

    cancel_flag.store(true, Ordering::SeqCst);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn register_download_run_creates_cancel_flag() {
        let run_id = "test-run-1";

        let flag = register_download_run(run_id).await.unwrap();

        assert!(!flag.load(Ordering::SeqCst));

        unregister_download_run(run_id).await;
    }

    #[tokio::test]
    async fn register_download_run_rejects_duplicate_run_id() {
        let run_id = "test-run-2";

        let _ = register_download_run(run_id).await.unwrap();
        let duplicate = register_download_run(run_id).await;

        assert!(duplicate.is_err());

        unregister_download_run(run_id).await;
    }

    #[tokio::test]
    async fn cancel_media_download_async_marks_existing_flag() {
        let run_id = "test-run-3";

        let flag = register_download_run(run_id).await.unwrap();
        cancel_media_download_async(run_id).await.unwrap();

        assert!(flag.load(Ordering::SeqCst));

        unregister_download_run(run_id).await;
    }

    #[tokio::test]
    async fn cancel_media_download_async_rejects_unknown_run_id() {
        let result = cancel_media_download_async("unknown-run").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn cancel_media_download_async_rejects_empty_run_id() {
        let result = cancel_media_download_async("   ").await;
        assert!(result.is_err());
    }
}