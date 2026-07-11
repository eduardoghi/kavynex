use tauri::AppHandle;

use crate::services::database::{
    get_app_settings_from_pool, set_app_settings_in_pool, shared_pool, StoredAppSettings,
};
use crate::services::library_paths::resolve_existing_library_dir;
use crate::utils::task::run_blocking;
use crate::AppResult;

#[tauri::command]
pub async fn get_app_settings(app: AppHandle) -> AppResult<StoredAppSettings> {
    let pool = shared_pool(&app).await?;
    get_app_settings_from_pool(pool).await
}

/// Rejects a non-empty `library_path` that is not an existing directory (or is a filesystem
/// root). The whole security model re-derives the library directory from this stored value and
/// trusts it (see `services::library_guard`); enforcing it at the write boundary stops a
/// compromised frontend from persisting an arbitrary base path that a later delete/move command
/// would then operate inside. An empty value is the valid "not configured yet" state and the
/// legitimate flow always persists a path already created by `ensure_directory_exists`.
fn validate_settings_library_path(library_path: &str) -> AppResult<()> {
    if library_path.trim().is_empty() {
        return Ok(());
    }

    resolve_existing_library_dir(library_path).map(|_| ())
}

#[tauri::command]
pub async fn set_app_settings(
    app: AppHandle,
    import_mode: String,
    library_path: String,
    load_remote_images: bool,
) -> AppResult<()> {
    let trimmed_library_path = library_path.trim().to_string();

    // Validate the library path off the async runtime: resolve_existing_library_dir touches the
    // filesystem (exists / is_dir / canonicalize).
    let path_for_validation = trimmed_library_path.clone();
    run_blocking(move || validate_settings_library_path(&path_for_validation)).await?;

    let pool = shared_pool(&app).await?;
    set_app_settings_in_pool(
        pool,
        import_mode.trim(),
        &trimmed_library_path,
        load_remote_images,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppErrorCode;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_dir(suffix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        std::env::temp_dir().join(format!(
            "kavynex-settings-cmd-test-{}-{}-{}",
            std::process::id(),
            nanos,
            suffix
        ))
    }

    #[test]
    fn validate_settings_library_path_accepts_empty_as_not_configured() {
        validate_settings_library_path("").unwrap();
        validate_settings_library_path("   ").unwrap();
    }

    #[test]
    fn validate_settings_library_path_accepts_an_existing_directory() {
        let dir = unique_test_dir("existing");
        fs::create_dir_all(&dir).unwrap();

        validate_settings_library_path(&dir.to_string_lossy()).unwrap();

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_settings_library_path_rejects_a_missing_directory() {
        let missing = unique_test_dir("missing");
        let error = validate_settings_library_path(&missing.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidLibraryPath.as_str());
    }

    #[test]
    fn validate_settings_library_path_rejects_a_file() {
        let dir = unique_test_dir("file");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("not-a-dir.txt");
        fs::write(&file, b"x").unwrap();

        let error = validate_settings_library_path(&file.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidLibraryPath.as_str());

        let _ = fs::remove_dir_all(&dir);
    }
}
