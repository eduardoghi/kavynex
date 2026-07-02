use std::path::Path;

use tauri::{AppHandle, Manager};

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

/// Authorizes the asset protocol to read files inside the user's library directory.
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

    let path = Path::new(&trimmed);
    allow_directory_in_asset_scope(&app, path)?;

    if let Ok(canonical) = std::fs::canonicalize(path) {
        if canonical != path {
            let _ = allow_directory_in_asset_scope(&app, &canonical);
        }
    }

    Ok(())
}

/// Authorizes the asset protocol to read a single user-selected file.
///
/// Used for the manual thumbnail preview: the user picks an image from an arbitrary
/// location and it is previewed via `convertFileSrc` before being imported into the
/// library. Only the exact selected file is granted, not its directory.
#[tauri::command]
pub async fn allow_asset_file(app: AppHandle, path: String) -> AppResult<()> {
    let trimmed = path.trim().to_string();

    if trimmed.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidTargetPath,
            "path is empty",
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
