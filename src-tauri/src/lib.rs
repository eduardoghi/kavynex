pub mod commands;
pub mod constants;
pub mod error;
pub mod models;
pub mod services;
pub mod utils;

pub use error::{AppError, AppErrorCode, AppResult};

use tauri::{AppHandle, Manager};

fn spawn_startup_cleanup(app_handle: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        match services::cleanup::cleanup_stale_temp_files_sync(&app_handle) {
            Ok(summary) => {
                services::logger::info(
                    "startup_cleanup",
                    format!(
                        "cleanup finished: scanned={}, removed={}, failed_removals={}",
                        summary.scanned_entries, summary.removed_entries, summary.failed_removals
                    ),
                );
            }
            Err(error) => {
                services::logger::error(
                    "startup_cleanup",
                    format!("startup temp cleanup failed: {}", error),
                );
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            services::logger::info("app", "application setup started");

            // Authorize the app cache directory in the asset protocol scope so temporary
            // thumbnail previews (generated into the cache dir) can be loaded via
            // convertFileSrc. The library directory is authorized at runtime once the
            // stored library path is known (see register_library_asset_scope).
            match app.path().app_cache_dir() {
                Ok(cache_dir) => {
                    if let Err(error) = app.asset_protocol_scope().allow_directory(&cache_dir, true)
                    {
                        services::logger::warn(
                            "asset_scope",
                            format!("failed to authorize cache dir in asset scope: {error}"),
                        );
                    }
                }
                Err(error) => {
                    services::logger::warn(
                        "asset_scope",
                        format!("failed to resolve cache dir for asset scope: {error}"),
                    );
                }
            }

            spawn_startup_cleanup(app_handle);
            services::logger::info("app", "application setup finished");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::library::resolve_default_library_directory,
            commands::library::ensure_directory_exists,
            commands::library::resolve_existing_directory,
            commands::library::is_directory_empty,
            commands::library::migrate_library_directory,
            commands::library::get_library_summary,
            commands::library::check_library_integrity,
            commands::library::open_path_in_system,
            commands::media::import_media_file,
            commands::media::delete_media_file,
            commands::thumbnail::generate_temporary_thumbnail,
            commands::thumbnail::persist_thumbnail_file,
            commands::thumbnail::download_thumbnail_from_url,
            commands::thumbnail::download_channel_avatar_from_handle,
            commands::thumbnail::delete_temporary_thumbnail,
            commands::thumbnail::delete_thumbnail_file,
            commands::comments::replace_media_comments,
            commands::yt_dlp::fetch_youtube_comments,
            commands::yt_dlp::list_yt_dlp_formats,
            commands::yt_dlp::download_media_from_url,
            commands::yt_dlp::cancel_media_download,
            commands::yt_dlp::check_external_tools,
            commands::security::register_library_asset_scope,
            commands::security::allow_asset_file,
            commands::settings::get_app_settings,
            commands::settings::set_app_settings,
            commands::channels::list_channels,
            commands::channels::find_channel_by_youtube_handle,
            commands::channels::get_channel_by_id,
            commands::channels::insert_channel,
            commands::channels::update_channel_name_and_handle,
            commands::channels::update_channel_avatar_path,
            commands::channels::delete_channel_by_id,
            commands::channels::list_distinct_thumbnail_paths_by_channel_id,
            commands::channels::list_distinct_file_paths_by_channel_id,
            commands::channels::get_channel_avatar_path_by_channel_id,
            commands::channels::count_channels_using_avatar_path_outside_channel,
            commands::channels::count_media_using_thumbnail_outside_channel,
            commands::channels::count_media_using_file_path_outside_channel
        ])
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}
