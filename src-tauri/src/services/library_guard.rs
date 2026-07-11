//! Cross-checks a `library_path` received over IPC against the library directory
//! persisted in the application settings.
//!
//! Commands that create or delete files inside the library receive the library path from
//! the frontend for convenience, but that value must never be trusted on its own: a
//! compromised frontend could otherwise point a destructive command (delete a media
//! file, remove a migrated directory tree) at an arbitrary location on disk. Every
//! mutating command re-derives the expected directory from the persisted settings and
//! rejects any request that does not point at it, mirroring the check done by
//! `register_library_asset_scope`.

use std::path::PathBuf;

use tauri::AppHandle;

use crate::services::database::{get_app_settings_from_pool, shared_pool};
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

/// Resolves the configured library directory from the persisted settings. Media,
/// thumbnails and live chat files all live under it, so commands never take the base
/// directory from the caller - a compromised frontend cannot redirect reads/writes to an
/// arbitrary location.
pub async fn configured_library_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let pool = shared_pool(app).await?;
    let settings = get_app_settings_from_pool(pool).await?;

    let library_path = settings
        .library_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::from_code(
                AppErrorCode::InvalidLibraryPath,
                "no library folder is configured",
            )
        })?;

    Ok(PathBuf::from(library_path))
}

/// Returns true when both strings point at the same location on disk. Each side is
/// canonicalized so casing, trailing separators and the Windows `\\?\` extended-length
/// prefix do not cause a false mismatch; when a path cannot be canonicalized (e.g. it
/// does not exist), a trimmed string comparison is used as a fallback. Empty inputs
/// never match.
pub fn paths_refer_to_same_location(requested: &str, configured: &str) -> bool {
    let requested = requested.trim();
    let configured = configured.trim();

    if requested.is_empty() || configured.is_empty() {
        return false;
    }

    match (
        std::fs::canonicalize(requested),
        std::fs::canonicalize(configured),
    ) {
        (Ok(canonical_requested), Ok(canonical_configured)) => {
            canonical_requested == canonical_configured
        }
        _ => requested == configured,
    }
}

/// Ensures `requested` matches the library directory persisted in the app settings.
///
/// The frontend always persists the library path before invoking any command that
/// mutates the library (settings are written before the library path state that drives
/// those commands changes), so a legitimate request always matches. Library migration
/// relies on the same invariant from the other side: the settings still hold the old
/// path while the migration runs, and the new path is only persisted after the
/// migration succeeds.
pub async fn ensure_configured_library_path(app: &AppHandle, requested: &str) -> AppResult<()> {
    let trimmed = requested.trim();

    if trimmed.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryPath,
            "library path is empty",
        ));
    }

    let pool = shared_pool(app).await?;
    let configured_library_path = get_app_settings_from_pool(pool)
        .await?
        .library_path
        .unwrap_or_default();

    if !paths_refer_to_same_location(trimmed, &configured_library_path) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryPath,
            "requested path does not match the configured library directory",
        ));
    }

    Ok(())
}

/// Verifies that `library_path` matches the configured library directory, then runs `f` on a
/// blocking thread with the verified path handed back to it.
///
/// This exists so a command that mutates the library through a caller-provided path cannot
/// run its filesystem work without the guard passing first: coupling the check with execution
/// here makes the check impossible to forget by construction, which is exactly the omission
/// that would turn a "delete a file inside the library" command into an arbitrary-file
/// primitive. `f` receives the same (verified) path so it does not need to capture a second
/// copy of it.
pub async fn verify_library_path_then_blocking<F, T>(
    app: &AppHandle,
    library_path: String,
    f: F,
) -> AppResult<T>
where
    F: FnOnce(String) -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    ensure_configured_library_path(app, &library_path).await?;
    run_blocking(move || f(library_path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_dir(suffix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        std::env::temp_dir().join(format!(
            "kavynex-library-guard-test-{}-{}-{}",
            std::process::id(),
            nanos,
            suffix
        ))
    }

    #[test]
    fn same_location_matches_identical_existing_directory() {
        let dir = unique_test_dir("same");
        fs::create_dir_all(&dir).unwrap();

        let as_string = dir.to_string_lossy().to_string();
        assert!(paths_refer_to_same_location(&as_string, &as_string));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn same_location_rejects_different_directories() {
        let library = unique_test_dir("library");
        let outside = unique_test_dir("outside");
        fs::create_dir_all(&library).unwrap();
        fs::create_dir_all(&outside).unwrap();

        assert!(!paths_refer_to_same_location(
            &outside.to_string_lossy(),
            &library.to_string_lossy()
        ));

        let _ = fs::remove_dir_all(&library);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn same_location_rejects_sibling_with_prefixed_name() {
        // Guards against a naive string `starts_with` style comparison: "library-evil"
        // must never be treated as the same location as "library".
        let base = unique_test_dir("prefix");
        let library = base.join("library");
        let sibling = base.join("library-evil");
        fs::create_dir_all(&library).unwrap();
        fs::create_dir_all(&sibling).unwrap();

        assert!(!paths_refer_to_same_location(
            &sibling.to_string_lossy(),
            &library.to_string_lossy()
        ));

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn same_location_rejects_empty_inputs() {
        assert!(!paths_refer_to_same_location("", "/library"));
        assert!(!paths_refer_to_same_location("/library", "   "));
        assert!(!paths_refer_to_same_location("", ""));
    }

    #[test]
    fn same_location_falls_back_to_string_equality_for_missing_paths() {
        let missing = unique_test_dir("missing");
        let missing_str = missing.to_string_lossy().to_string();

        // Neither path exists, so canonicalize fails on both sides and the comparison
        // falls back to a trimmed string match.
        assert!(paths_refer_to_same_location(&missing_str, &missing_str));
        assert!(!paths_refer_to_same_location(
            &missing_str,
            "/some/other/missing"
        ));
    }
}
