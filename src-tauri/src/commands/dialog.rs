//! The native file and folder pickers, opened from the backend instead of through the dialog
//! plugin's own commands.
//!
//! The plugin's renderer-facing `open` and `save` add every path the user picks to the
//! asset-protocol scope when the `protocol-asset` feature is on, recursively for a folder, and a
//! grant cannot be taken back for the rest of the session. Picking the library folder granted its
//! root, which `commands::security::managed_asset_scope_dirs` refuses to grant because the user's
//! own files can sit there, and every imported file, cookies file and database became readable
//! through `asset:`. The same builder driven from Rust grants nothing, so these commands hand the
//! path back and leave the scope alone. The renderer holds no `dialog:` permission at all. See
//! docs/THREAT-MODEL.md.

use serde::Deserialize;
use tauri::{Runtime, Window};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, FilePath};
use ts_rs::TS;

use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

/// One entry of a picker's file-type list, as the user sees it (`Images: png, jpg`).
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct FileDialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

fn file_dialog<R: Runtime>(
    window: &Window<R>,
    title: Option<String>,
    filters: Vec<FileDialogFilter>,
) -> FileDialogBuilder<R> {
    let mut builder = window.dialog().file();

    // Modal to the app window, as the plugin's own commands make it. Linux has no parent to set.
    #[cfg(any(windows, target_os = "macos"))]
    {
        builder = builder.set_parent(window);
    }

    if let Some(title) = title {
        builder = builder.set_title(title);
    }

    for filter in filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        builder = builder.add_filter(filter.name, &extensions);
    }

    builder
}

/// The picked location as a plain path, or `None` when the dialog was cancelled.
///
/// A desktop picker always answers with a filesystem path. The URL form exists for mobile content
/// providers, which this app does not build for, so meeting one is an error rather than a guess.
fn picked_path(picked: Option<FilePath>) -> AppResult<Option<String>> {
    picked
        .map(|picked| {
            picked
                .simplified()
                .into_path()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|error| {
                    AppError::from_code_with_details(
                        AppErrorCode::AppError,
                        "the picked location is not a file path",
                        error.to_string(),
                    )
                })
        })
        .transpose()
}

/// Opens a folder picker. Resolves to the chosen folder, or `None` when cancelled.
#[tauri::command]
pub async fn open_folder_dialog<R: Runtime>(
    window: Window<R>,
    title: Option<String>,
) -> AppResult<Option<String>> {
    // The blocking pick waits on the user for as long as the dialog is open, so it runs on the
    // blocking pool rather than holding an async worker.
    let picked =
        run_blocking(move || Ok(file_dialog(&window, title, Vec::new()).blocking_pick_folder()))
            .await?;

    let picked = picked_path(picked)?;

    // The commands that persist or create a folder accept only what the user picked here (or what
    // is already stored). See services::chosen_folders.
    if let Some(path) = picked.as_deref() {
        crate::services::chosen_folders::record(path);
    }

    Ok(picked)
}

/// Opens a single-file picker. Resolves to the chosen file, or `None` when cancelled.
#[tauri::command]
pub async fn open_file_dialog<R: Runtime>(
    window: Window<R>,
    title: Option<String>,
    filters: Vec<FileDialogFilter>,
) -> AppResult<Option<String>> {
    let picked =
        run_blocking(move || Ok(file_dialog(&window, title, filters).blocking_pick_file())).await?;

    let picked = picked_path(picked)?;

    // The commands that read a user's file accept only one picked here, or a preview the backend
    // wrote. See services::chosen_files.
    if let Some(path) = picked.as_deref() {
        crate::services::chosen_files::record(
            crate::services::chosen_files::ChosenFile::Source,
            path,
        );
    }

    Ok(picked)
}

/// Opens a save dialog with `default_file_name` filled in. Resolves to the chosen destination, or
/// `None` when cancelled. Nothing is written here; the command the destination is handed to decides
/// whether it may be written to.
#[tauri::command]
pub async fn save_file_dialog<R: Runtime>(
    window: Window<R>,
    title: Option<String>,
    default_file_name: Option<String>,
    filters: Vec<FileDialogFilter>,
) -> AppResult<Option<String>> {
    let picked = run_blocking(move || {
        let mut builder = file_dialog(&window, title, filters);

        if let Some(file_name) = default_file_name {
            builder = builder.set_file_name(file_name);
        }

        Ok(builder.blocking_save_file())
    })
    .await?;

    let picked = picked_path(picked)?;

    if let Some(path) = picked.as_deref() {
        crate::services::chosen_files::record(
            crate::services::chosen_files::ChosenFile::Destination,
            path,
        );
    }

    Ok(picked)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cancelled_dialog_resolves_to_none() {
        assert_eq!(picked_path(None).unwrap(), None);
    }

    #[test]
    fn a_picked_path_comes_back_as_written() {
        let path = std::env::temp_dir().join("kavynex-dialog-pick.db");

        assert_eq!(
            picked_path(Some(FilePath::Path(path.clone()))).unwrap(),
            Some(path.to_string_lossy().into_owned())
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_picked_path_loses_the_extended_length_prefix() {
        // What the plugin's own commands hand back too (`simplified`), so a stored library path
        // keeps the spelling it had before the picker moved here.
        let picked = FilePath::Path(std::path::PathBuf::from(r"\\?\C:\Users\me\Library"));

        assert_eq!(
            picked_path(Some(picked)).unwrap().as_deref(),
            Some(r"C:\Users\me\Library")
        );
    }

    #[test]
    fn the_filter_reads_the_shape_the_renderer_sends() {
        let filter: FileDialogFilter =
            serde_json::from_value(serde_json::json!({ "name": "Database", "extensions": ["db"] }))
                .unwrap();

        assert_eq!(filter.name, "Database");
        assert_eq!(filter.extensions, vec!["db".to_string()]);
    }
}
