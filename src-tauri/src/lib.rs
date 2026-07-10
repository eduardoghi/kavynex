pub mod commands;
pub mod constants;
pub mod error;
pub mod models;
pub mod services;
pub mod utils;

pub use error::{AppError, AppErrorCode, AppResult};

use std::time::Duration;

use tauri::{AppHandle, Manager};

// How often the in-session backup check below wakes up. `backup_database` itself throttles
// the actual snapshot to once per 24h, so this only needs to be frequent enough that a
// long-running session eventually crosses that threshold - it does not create extra backups.
const PERIODIC_BACKUP_CHECK_INTERVAL_SECS: u64 = 6 * 60 * 60;

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

/// The pre-migration/post-open backup in `services::database` only runs once, at pool init,
/// so an app left running for several days never gets a fresh daily snapshot mid-session.
/// This periodically re-invokes the (internally throttled) `backup_database` so a long
/// session still gets its daily snapshot without waiting for the next restart. Failures are
/// logged and never stop the loop or the app.
fn spawn_periodic_backup(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(PERIODIC_BACKUP_CHECK_INTERVAL_SECS)).await;

            let db_path = match services::database::database_path(&app_handle) {
                Ok(db_path) => db_path,
                Err(error) => {
                    services::logger::warn(
                        "db_backup",
                        format!("periodic backup: failed to resolve database path: {error}"),
                    );
                    continue;
                }
            };

            match services::db_backup::backup_database(&db_path).await {
                Ok(true) => services::logger::info("db_backup", "periodic snapshot written"),
                Ok(false) => {}
                Err(error) => {
                    services::logger::warn("db_backup", format!("periodic backup failed: {error}"))
                }
            }
        }
    });
}

/// Reports a fatal startup failure and terminates with a non-zero code. The app is built with
/// `windows_subsystem = "windows"` (no console), so a panic here would be invisible - the user
/// would just see the app fail to open. This logs the reason (stderr, plus the file log if it
/// was initialized) and, on Windows, shows it in a native dialog before exiting.
fn fail_startup(message: &str) -> ! {
    services::logger::error("app", message);
    show_startup_error_dialog(message);
    std::process::exit(1);
}

#[cfg(windows)]
fn show_startup_error_dialog(message: &str) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    fn to_wide(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut core::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            u_type: u32,
        ) -> i32;
    }

    const MB_OK: u32 = 0x0000_0000;
    const MB_ICONERROR: u32 = 0x0000_0010;

    let text = to_wide(message);
    let caption = to_wide("Kavynex could not start");

    // SAFETY: both buffers are NUL-terminated UTF-16 and outlive the call; a null hwnd shows
    // an unowned modal dialog, which is what we want when there is no application window yet.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(not(windows))]
fn show_startup_error_dialog(_message: &str) {
    // Non-Windows builds do not hide the console, so the stderr line logged above is already
    // visible in the terminal/journal; no native dialog is needed.
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin registered: a second launch is redirected here instead of
        // opening a second instance, which would otherwise open a second SqlitePool onto the
        // same database and duplicate the per-process download registry.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Persist logs to a file (in addition to stderr) so issues on a user's machine
            // can be diagnosed from bug reports.
            if let Ok(log_dir) = app.path().app_log_dir() {
                services::logger::init(log_dir);
            }

            services::logger::info("app", "application setup started");

            // Apply a database import staged by the import command before the pool can open.
            // The connection pool is a process-wide singleton that cannot be swapped
            // in-process, so the actual file swap is deferred to this pre-open point. A
            // failure is logged but must not stop the app from starting.
            match services::database::database_path(&app_handle) {
                Ok(db_path) => match services::db_backup::apply_pending_database_import(&db_path) {
                    Ok(true) => services::logger::info("app", "applied a pending database import"),
                    Ok(false) => {}
                    Err(error) => services::logger::error(
                        "app",
                        format!("failed to apply pending database import: {error}"),
                    ),
                },
                Err(error) => services::logger::warn(
                    "app",
                    format!("failed to resolve database path for import check: {error}"),
                ),
            }

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

            spawn_startup_cleanup(app_handle.clone());
            spawn_periodic_backup(app_handle);
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
            commands::media::cleanup_unreferenced_media_artifacts,
            commands::live_chat::read_live_chat_file,
            commands::live_chat::delete_live_chat_file,
            commands::live_chat::list_live_chat_files,
            commands::live_chat::migrate_live_chat_to_library,
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
            commands::database::ensure_database_ready,
            commands::database::get_database_backup_status,
            commands::database::restore_database_from_backup,
            commands::database::export_database,
            commands::database::import_database,
            commands::database::get_database_import_undo_status,
            commands::database::undo_database_import,
            commands::logging::log_frontend_error,
            commands::settings::get_app_settings,
            commands::settings::set_app_settings,
            commands::channels::list_channels,
            commands::channels::find_channel_by_youtube_handle,
            commands::channels::get_channel_by_id,
            commands::channels::insert_channel,
            commands::channels::update_channel_name_and_handle,
            commands::channels::replace_channel_avatar,
            commands::channels::delete_channel_with_artifacts,
            commands::videos::update_media_title,
            commands::videos::list_media_by_channel,
            commands::videos::find_media_by_channel_and_file_path,
            commands::videos::insert_media,
            commands::videos::list_media_comments_by_media_id,
            commands::videos::delete_media_with_artifacts,
            commands::videos::mark_media_as_watched,
            commands::videos::mark_media_as_unwatched,
            commands::videos::update_media_progress,
            commands::videos::get_media_repository_stats,
            commands::videos::list_media_integrity_references
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| fail_startup(&format!("failed to build the application: {error}")))
        .run(|_app_handle, event| {
            // Terminate any in-flight yt-dlp/ffmpeg downloads when the app is exiting so
            // they are not left running as orphaned processes after the window closes.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                services::yt_dlp::cancel_all_active_downloads_blocking();
            }
        });
}
