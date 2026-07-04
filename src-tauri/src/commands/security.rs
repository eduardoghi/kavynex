use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::services::database::{get_app_settings_from_pool, shared_pool};
use crate::utils::format::is_allowed_thumbnail_extension;
use crate::utils::path::extension_from_path;
use crate::{AppError, AppErrorCode, AppResult};

fn allow_directory_in_asset_scope(app: &AppHandle, dir: &Path) -> AppResult<()> {
    app.asset_protocol_scope()
        .allow_directory(dir, true)
        .map_err(|error| {
            AppError::from_code(
                AppErrorCode::AssetScopeRegisterFailed,
                format!("failed to allow directory in asset scope: {error}"),
            )
        })
}

/// Returns true when both strings point at the same location on disk. Each side is
/// canonicalized so casing, trailing separators and the Windows `\\?\` extended-length
/// prefix do not cause a false mismatch; when a path cannot be canonicalized (e.g. it
/// does not exist), a trimmed string comparison is used as a fallback. Empty inputs
/// never match.
fn paths_refer_to_same_location(requested: &str, configured: &str) -> bool {
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

/// Authorizes the asset protocol to read files inside the user's library directory.
///
/// The requested path is never trusted on its own: it must match the library path
/// persisted in the application settings. This prevents a compromised frontend from
/// widening the asset scope to an arbitrary directory which, combined with
/// `convertFileSrc`, would become an arbitrary local-file read primitive rendered inside
/// the webview. Only the directory the user actually configured as their library can be
/// authorized here.
///
/// The asset protocol scope is in-memory and does not persist across restarts, so this
/// is called on startup (after settings load) and whenever the library path changes.
/// Both the path as stored (already canonical) and, when different, the freshly
/// canonicalized form are authorized so the extended-length (`\\?\`) and stripped
/// variants used by the frontend both match.
#[tauri::command]
pub async fn register_library_asset_scope(app: AppHandle, library_path: String) -> AppResult<()> {
    let trimmed = library_path.trim().to_string();

    if trimmed.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryPath,
            "library path is empty",
        ));
    }

    // Re-derive the expected library directory from the persisted settings and reject any
    // request that does not point at it. The DB write always precedes this call in the
    // frontend (settings are persisted before the library path state that triggers the
    // registration changes), so a legitimate request always matches.
    let pool = shared_pool(&app).await?;
    let configured_library_path = get_app_settings_from_pool(pool)
        .await?
        .library_path
        .unwrap_or_default();

    if !paths_refer_to_same_location(&trimmed, &configured_library_path) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryPath,
            "requested path does not match the configured library directory",
        ));
    }

    let path = Path::new(&trimmed);
    allow_directory_in_asset_scope(&app, path)?;

    if let Ok(canonical) = std::fs::canonicalize(path) {
        if canonical != path {
            let _ = allow_directory_in_asset_scope(&app, &canonical);
        }
    }

    Ok(())
}

/// Authorizes the asset protocol to read a single user-selected image file.
///
/// Used for the manual thumbnail preview: the user picks an image from an arbitrary
/// location and it is previewed via `convertFileSrc` before being imported into the
/// library. To keep this from becoming a general arbitrary-file read primitive, only an
/// existing regular file whose extension is an allowed thumbnail image type can be
/// authorized, and only that exact file is granted (never its directory).
#[tauri::command]
pub async fn allow_asset_file(app: AppHandle, path: String) -> AppResult<()> {
    let trimmed = path.trim().to_string();

    if trimmed.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidTargetPath,
            "path is empty",
        ));
    }

    let candidate = Path::new(&trimmed);

    if !candidate.is_file() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidThumbnailFile,
            "path is not an existing file",
        ));
    }

    if !is_allowed_thumbnail_extension(&extension_from_path(candidate)) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidThumbnailFile,
            "only image files can be authorized for preview",
        ));
    }

    app.asset_protocol_scope()
        .allow_file(&trimmed)
        .map_err(|error| {
            AppError::from_code(
                AppErrorCode::AssetScopeRegisterFailed,
                format!("failed to allow file in asset scope: {error}"),
            )
        })?;

    if let Ok(canonical) = std::fs::canonicalize(&trimmed) {
        let _ = app.asset_protocol_scope().allow_file(&canonical);
    }

    Ok(())
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
            "kavynex-security-test-{}-{}-{}",
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
