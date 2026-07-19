//! Resolves the app's temporary working directories under the platform cache directory.
//!
//! Every function here is generic over the Tauri runtime rather than tied to the concrete
//! `AppHandle` (i.e. `AppHandle<Wry>`). Callers are unaffected - `Wry` satisfies the bound - but it
//! is what lets the tests below drive these against the mock runtime, since all they need from the
//! handle is `path()`. Without it the module is only reachable through a real Tauri app and ends up
//! with no tests at all.

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};

use crate::constants::{TEMP_DIR_THUMBS, TEMP_DIR_YT_DLP, TEMP_DIR_YT_DLP_THUMB};
use crate::{AppError, AppErrorCode, AppResult};

fn ensure_temp_subdir<R: Runtime>(
    app: &AppHandle<R>,
    dir_name: &str,
    create_error_code: AppErrorCode,
) -> AppResult<PathBuf> {
    let cache_dir = app.path().app_cache_dir().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CacheDirectoryResolveFailed,
            format!("failed to resolve cache directory: {e}"),
        )
    })?;

    fs::create_dir_all(&cache_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CacheDirectoryCreateFailed,
            format!("failed to create cache directory: {e}"),
        )
    })?;

    let dir = cache_dir.join(dir_name);

    fs::create_dir_all(&dir).map_err(|e| {
        AppError::from_code(
            create_error_code,
            format!("failed to create temporary directory: {e}"),
        )
    })?;

    Ok(dir)
}

pub fn thumbs_temp_dir<R: Runtime>(app: &AppHandle<R>) -> AppResult<PathBuf> {
    ensure_temp_subdir(
        app,
        TEMP_DIR_THUMBS,
        AppErrorCode::CreateTempThumbsDirFailed,
    )
}

pub fn yt_dlp_temp_dir<R: Runtime>(app: &AppHandle<R>) -> AppResult<PathBuf> {
    ensure_temp_subdir(app, TEMP_DIR_YT_DLP, AppErrorCode::CreateTempRootDirFailed)
}

pub fn yt_dlp_thumb_temp_dir<R: Runtime>(app: &AppHandle<R>) -> AppResult<PathBuf> {
    ensure_temp_subdir(
        app,
        TEMP_DIR_YT_DLP_THUMB,
        AppErrorCode::CreateTempThumbRootFailed,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    /// A mock app is enough here: these functions only need `app.path()` and the filesystem, not a
    /// command round trip. The cache directory it resolves is the real per-OS one, so each test
    /// asserts on the returned path and the directory it created rather than wiping anything -
    /// removing the tree would delete a real cache shared with the running app.
    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        mock_builder().build(mock_context(noop_assets())).unwrap()
    }

    #[test]
    fn each_temp_dir_is_created_under_the_cache_dir_with_its_own_name() {
        let app = mock_app();
        let handle = app.handle();
        let cache_dir = handle.path().app_cache_dir().unwrap();

        type Resolve = fn(&AppHandle<tauri::test::MockRuntime>) -> AppResult<PathBuf>;

        for (resolve, expected_name) in [
            (thumbs_temp_dir as Resolve, TEMP_DIR_THUMBS),
            (yt_dlp_temp_dir as Resolve, TEMP_DIR_YT_DLP),
            (yt_dlp_thumb_temp_dir as Resolve, TEMP_DIR_YT_DLP_THUMB),
        ] {
            let dir = resolve(handle).expect("the temp directory should resolve");

            assert_eq!(dir, cache_dir.join(expected_name));
            assert!(dir.is_dir(), "{expected_name} should exist after resolving");
        }
    }

    #[test]
    fn the_three_temp_dirs_never_collide() {
        // They hold different things with different lifetimes (a thumbnail preview, a download in
        // flight, a fetched thumbnail), and the startup sweep walks each one, so two of them
        // resolving to the same directory would have one sweep another's live files.
        let app = mock_app();
        let handle = app.handle();

        let dirs = [
            thumbs_temp_dir(handle).unwrap(),
            yt_dlp_temp_dir(handle).unwrap(),
            yt_dlp_thumb_temp_dir(handle).unwrap(),
        ];

        let unique: std::collections::HashSet<&PathBuf> = dirs.iter().collect();
        assert_eq!(
            unique.len(),
            dirs.len(),
            "temp directories must be distinct"
        );
    }

    #[test]
    fn resolving_an_existing_temp_dir_again_succeeds() {
        // `create_dir_all` is what makes this idempotent, and every caller resolves the directory
        // fresh on each use rather than caching it, so the second call is the normal case.
        let app = mock_app();
        let handle = app.handle();

        let first = yt_dlp_temp_dir(handle).unwrap();
        let second = yt_dlp_temp_dir(handle).unwrap();

        assert_eq!(first, second);
        assert!(second.is_dir());
    }
}
