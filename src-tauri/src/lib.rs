pub mod commands;
pub mod constants;
pub mod error;
pub mod models;
pub mod services;
pub mod utils;

pub use error::{AppError, AppErrorCode, AppResult};

use tauri::AppHandle;

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
            commands::yt_dlp::check_external_tools
        ])
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}
