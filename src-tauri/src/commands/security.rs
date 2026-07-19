use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::services::library_guard::ensure_configured_library_path;
use crate::services::logger;
use crate::utils::format::is_allowed_thumbnail_extension;
use crate::utils::path::extension_from_path;
use crate::utils::task::run_blocking;
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

/// Grants `primary` in the asset-protocol scope via `grant`, then best-effort also grants its
/// canonical (`\\?\`) form when that differs, logging a warning if the second grant fails rather
/// than dropping it silently. Shared by the directory and file registration paths, which differ
/// only in the grant closure; `subject` names the target in the warning ("library path" / "asset
/// file"). The primary grant's failure is propagated; only the canonical retry is best-effort.
fn grant_path_with_canonical<F>(primary: &Path, subject: &str, grant: F) -> AppResult<()>
where
    F: Fn(&Path) -> AppResult<()>,
{
    grant(primary)?;

    if let Ok(canonical) = std::fs::canonicalize(primary) {
        if canonical != primary {
            if let Err(error) = grant(&canonical) {
                logger::warn(
                    "asset_scope",
                    format!("failed to authorize canonical {subject} in asset scope: {error}"),
                );
            }
        }
    }

    Ok(())
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

    // Re-derive the expected library directory from the persisted settings and reject any
    // request that does not point at it. The DB write always precedes this call in the
    // frontend (settings are persisted before the library path state that triggers the
    // registration changes), so a legitimate request always matches.
    ensure_configured_library_path(&app, &trimmed).await?;

    // canonicalize() and the asset scope registration are blocking filesystem/IPC calls;
    // run them off the async runtime's worker threads, consistent with other commands
    // (e.g. commands/library.rs, commands/thumbnail.rs).
    run_blocking(move || {
        grant_path_with_canonical(Path::new(&trimmed), "library path", |dir| {
            allow_directory_in_asset_scope(&app, dir)
        })
    })
    .await
}

/// Authorizes the asset protocol to read a single user-selected image file.
///
/// Used for the manual thumbnail preview: the user picks an image from an arbitrary
/// location and it is previewed via `convertFileSrc` before being imported into the
/// library. To keep this from becoming a general arbitrary-file read primitive, only an
/// existing regular file whose extension is an allowed thumbnail image type can be
/// authorized, and only that exact file is granted (never its directory).
/// Validates that `path` is something that may be authorized for the manual-thumbnail
/// preview: an existing regular file with an allowed image extension. Extracted from the
/// command (which additionally needs the Tauri runtime to register the asset scope) so this
/// security check can be unit-tested without a runtime - the `AppHandle` command itself cannot
/// run under the mock runtime used in tests.
fn validate_asset_file_for_preview(path: &str) -> AppResult<()> {
    if path.trim().is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidTargetPath,
            "path is empty",
        ));
    }

    let candidate = Path::new(path);

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

    Ok(())
}

#[tauri::command]
pub async fn allow_asset_file(app: AppHandle, path: String) -> AppResult<()> {
    let trimmed = path.trim().to_string();

    // is_file()/canonicalize() and the asset scope registration are blocking filesystem/IPC
    // calls; run them off the async runtime's worker threads, consistent with other commands
    // (e.g. commands/library.rs, commands/thumbnail.rs).
    run_blocking(move || {
        validate_asset_file_for_preview(&trimmed)?;

        grant_path_with_canonical(Path::new(&trimmed), "asset file", |file| {
            app.asset_protocol_scope()
                .allow_file(file)
                .map_err(|error| {
                    AppError::from_code(
                        AppErrorCode::AssetScopeRegisterFailed,
                        format!("failed to allow file in asset scope: {error}"),
                    )
                })
        })
    })
    .await
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
            "kavynex-security-cmd-test-{}-{}-{}",
            std::process::id(),
            nanos,
            suffix
        ))
    }

    // The asset-scope registration itself needs the Tauri runtime, which does not run under
    // the mock runtime; these cover the gate that decides what allow_asset_file will ever
    // authorize. The library-path guard behind register_library_asset_scope is covered by
    // services::library_guard's paths_refer_to_same_location tests.

    #[test]
    fn validate_asset_file_rejects_an_empty_path() {
        let error = validate_asset_file_for_preview("   ").unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidTargetPath.as_str());
    }

    #[test]
    fn validate_asset_file_rejects_a_missing_file() {
        let missing = unique_test_dir("missing").join("nope.png");
        let error = validate_asset_file_for_preview(&missing.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidThumbnailFile.as_str());
    }

    #[test]
    fn validate_asset_file_rejects_an_existing_non_image_file() {
        let dir = unique_test_dir("nonimage");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("notes.txt");
        fs::write(&file, b"x").unwrap();

        let error = validate_asset_file_for_preview(&file.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidThumbnailFile.as_str());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_asset_file_rejects_a_directory_with_an_image_name() {
        // A directory named like an image must not be authorized - only regular files are.
        let dir = unique_test_dir("dir");
        let fake = dir.join("thumb.png");
        fs::create_dir_all(&fake).unwrap();

        let error = validate_asset_file_for_preview(&fake.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidThumbnailFile.as_str());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_asset_file_accepts_an_existing_image() {
        let dir = unique_test_dir("image");
        fs::create_dir_all(&dir).unwrap();

        for name in ["thumb.png", "photo.JPG", "art.webp"] {
            let file = dir.join(name);
            fs::write(&file, b"\x89PNG\r\n").unwrap();
            validate_asset_file_for_preview(&file.to_string_lossy())
                .unwrap_or_else(|error| panic!("{name} should be accepted: {error}"));
        }

        let _ = fs::remove_dir_all(&dir);
    }
}
