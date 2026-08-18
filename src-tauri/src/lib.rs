pub mod commands;
pub mod constants;
pub mod error;
pub mod models;
pub mod services;
pub mod utils;

pub use error::{AppError, AppErrorCode, AppResult};

use std::path::Path;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

// How often the in-session backup check below wakes up. `backup_database` itself throttles
// the actual snapshot to once per 24h, so this only needs to be frequent enough that a
// long-running session eventually crosses that threshold. It does not create extra backups.
/// Payload of the [`EVENT_DATABASE_INTEGRITY_FAILED`](crate::constants::EVENT_DATABASE_INTEGRITY_FAILED)
/// event: the list of problems the background full integrity check reported. Frontend-owned contract
/// (validated there with a zod schema), so it is a plain serde struct rather than a ts-rs-exported
/// type. The frontend only needs the shape, not a generated binding.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseIntegrityFailedEvent {
    problems: Vec<String>,
}

const PERIODIC_BACKUP_CHECK_INTERVAL_SECS: u64 = 6 * 60 * 60;

// The first backup pass runs after this short delay rather than a full interval, so a session
// that is only open briefly still gets one snapshot (and one external-backup mirror) near
// startup. Both the local snapshot and the external mirror are throttled to once per 24h, so an
// early pass is a no-op when a recent backup already exists. The delay gives app bootstrap time
// to open the database pool (which the external-mirror step reads its setting from) first.
const INITIAL_BACKUP_DELAY_SECS: u64 = 60;

// Delay before the background full integrity check runs, keeping it well off the startup critical
// path (bootstrap, first render, the initial backup pass). The check itself is throttled to once a
// week (see db_backup::integrity_check_is_due), so this delay only shapes when the occasional run
// happens, never how often.
const INTEGRITY_CHECK_STARTUP_DELAY_SECS: u64 = 120;

// Delay before the pending-media sweep runs. Shorter than the integrity check's: it opens the same
// pool but does far less work, and an artifact stranded by a crashed creation is disk the user is
// paying for until it is reconciled. Still off the first-render path.
const PENDING_MEDIA_SWEEP_DELAY_SECS: u64 = 30;

fn spawn_startup_cleanup(app_handle: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        match services::temp_cleanup::cleanup_stale_temp_files_sync(&app_handle) {
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

/// Sweeps the configured library directory for atomic-write leftovers (`.tmp-`/`.backup-`/
/// `.migrated-` scratch files a crashed copy/replace/migrate left behind). Kept separate from
/// `spawn_startup_cleanup`, which only reaches the disposable cache directories: the library path
/// lives in the settings row, so it must be read from the pool first. A missing/unconfigured
/// library (first run) is not an error. There is simply nothing to sweep yet. Failures are
/// logged and never affect startup.
fn spawn_startup_library_cleanup(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let library_dir = match services::library::guard::configured_library_dir(&app_handle).await
        {
            Ok(library_dir) => library_dir,
            // No library configured yet, or the settings could not be read: nothing to sweep.
            Err(_) => return,
        };

        let sweep = utils::task::run_blocking(move || {
            services::temp_cleanup::cleanup_library_leftovers_sync(&library_dir)
        })
        .await;

        match sweep {
            Ok(summary) => {
                if summary.removed_entries > 0 || summary.failed_removals > 0 {
                    services::logger::info(
                        "startup_cleanup",
                        format!(
                            "library leftover sweep finished: scanned={}, removed={}, failed_removals={}",
                            summary.scanned_entries,
                            summary.removed_entries,
                            summary.failed_removals
                        ),
                    );
                }
            }
            Err(error) => services::logger::warn(
                "startup_cleanup",
                format!("library leftover sweep failed: {error}"),
            ),
        }
    });
}

/// The pre-migration/post-open backup in `services::database` only runs once, at pool init,
/// so an app left running for several days never gets a fresh daily snapshot mid-session.
/// This periodically re-invokes the (internally throttled) `backup_database` so a long
/// session still gets its daily snapshot without waiting for the next restart. Failures are
/// logged and never stop the loop or the app.
/// Reads the configured external backup directory (Settings > Database) and, when one is set,
/// mirrors the database into it so a disk failure that takes the app config directory does not take
/// every snapshot with it. Best effort: any failure is logged and never stops the periodic loop. An
/// empty or absent setting means the feature is off and is silent.
async fn run_external_database_backup(app_handle: &AppHandle, db_path: &Path) {
    // The setting lives in the database, so reading it opens the shared pool if it is not open yet.
    let pool = match services::database::shared_pool(app_handle).await {
        Ok(pool) => pool,
        Err(error) => {
            services::logger::warn(
                "db_backup",
                format!("external backup: failed to open the database pool: {error}"),
            );
            return;
        }
    };

    let external_dir = match services::database::get_app_settings_from_pool(&pool).await {
        Ok(settings) => settings.external_backup_dir.unwrap_or_default(),
        Err(error) => {
            services::logger::warn(
                "db_backup",
                format!("external backup: failed to read the setting: {error}"),
            );
            return;
        }
    };

    let external_dir = external_dir.trim();

    if external_dir.is_empty() {
        return;
    }

    match services::db_backup::mirror_database_to_external_dir(db_path, Path::new(external_dir))
        .await
    {
        Ok(true) => services::logger::info("db_backup", "external database backup written"),
        Ok(false) => {}
        Err(error) => services::logger::warn(
            "db_backup",
            format!("external database backup failed: {error}"),
        ),
    }
}

/// Runs a full `PRAGMA integrity_check` in the background, off the startup critical path and
/// throttled to once a week. The automatic paths use the fast `quick_check`, which a subtly
/// damaged page can pass and then be migrated over, but this thorough check catches that. On a
/// clean result the throttle marker is refreshed. On a failing one it is deliberately not, so a
/// damaged database is re-checked every launch, and the failure is logged prominently (with a
/// pointer to the Settings > Database restore) rather than left for the user to discover via the
/// manual Diagnostics check. Best effort throughout: any failure to run the check never affects
/// the app.
fn spawn_startup_integrity_check(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(INTEGRITY_CHECK_STARTUP_DELAY_SECS)).await;

        let db_path = match services::database::database_path(&app_handle) {
            Ok(db_path) => db_path,
            Err(error) => {
                services::logger::warn(
                    "db_integrity",
                    format!("integrity check: failed to resolve database path: {error}"),
                );
                return;
            }
        };

        if !services::db_backup::integrity_check_is_due(&db_path) {
            return;
        }

        // Opening the shared pool here is safe: a database too damaged to open (or one failing
        // quick_check with a migration pending) fails the open, which the startup recovery flow
        // already surfaces. This check is for the subtler damage that opens cleanly.
        let pool = match services::database::shared_pool(&app_handle).await {
            Ok(pool) => pool,
            Err(error) => {
                services::logger::warn(
                    "db_integrity",
                    format!("integrity check: failed to open the database pool: {error}"),
                );
                return;
            }
        };

        match services::db_backup::run_full_integrity_check(&pool).await {
            Ok(report) if report.ok => {
                services::db_backup::mark_integrity_check_passed(&db_path);
                services::logger::info("db_integrity", "background integrity check passed");
            }
            Ok(report) => {
                services::logger::error(
                    "db_integrity",
                    format!(
                        "background integrity check found {} problem(s). The database may be corrupt. Open Settings > Database to restore from a backup: {}",
                        report.problems.len(),
                        report.problems.join("; ")
                    ),
                );

                // Push it to the frontend too, so the user is told proactively (a banner pointing at
                // Settings > Database) instead of the failure only living in the log file. Fire and
                // forget: an emit failure (no window yet) must not affect anything, and the log line
                // above already recorded the problem regardless.
                let _ = app_handle.emit(
                    crate::constants::EVENT_DATABASE_INTEGRITY_FAILED,
                    DatabaseIntegrityFailedEvent {
                        problems: report.problems.clone(),
                    },
                );
            }
            Err(error) => services::logger::warn(
                "db_integrity",
                format!("background integrity check could not run: {error}"),
            ),
        }
    });
}

/// Reconciles the artifacts a media creation wrote but never registered a row for, because the
/// process did not survive the window between the two. The frontend's failure path handles a step
/// that *fails*. Nothing there can run when the process is gone, so a marker left on disk is what
/// records the intent (see `services::pending_media`).
///
/// Runs after a short delay rather than inline with setup: it needs the database pool, and the
/// deletion decision it delegates to reference-counts every path against the rows, so an artifact
/// that did get registered is kept. Best effort. Any failure is logged and never affects startup.
fn spawn_pending_media_sweep(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(PENDING_MEDIA_SWEEP_DELAY_SECS)).await;

        match services::pending_media::sweep_pending_media_artifacts(&app_handle).await {
            Ok(0) => {}
            Ok(removed) => services::logger::info(
                "pending_media",
                format!("reconciled {removed} artifact(s) from an unfinished media creation"),
            ),
            Err(error) => services::logger::warn(
                "pending_media",
                format!("pending media sweep failed: {error}"),
            ),
        }
    });
}

fn spawn_periodic_backup(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut delay = Duration::from_secs(INITIAL_BACKUP_DELAY_SECS);

        loop {
            tokio::time::sleep(delay).await;
            delay = Duration::from_secs(PERIODIC_BACKUP_CHECK_INTERVAL_SECS);

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

            run_external_database_backup(&app_handle, &db_path).await;
        }
    });
}

/// The flag that turns a launch into a startup self-check: run the whole of `setup()` and exit 0
/// without ever entering the event loop. See [`is_smoke_test_run`].
const SMOKE_TEST_FLAG: &str = "--smoke-test";

/// How long a `--webview-check` run waits for the renderer to report before giving up.
///
/// The whole point of the watchdog is that a webview which never loads reports *nothing*: there is
/// no error to catch and no callback to fail, so without a deadline the run would hang until the
/// job timeout and say nothing about why. Generous enough for a cold start on a CI runner under
/// Xvfb (where the first WebKit initialization is by far the slowest part), and far below the
/// release job's own 90-minute bound so this is what fails, with a message, rather than the job.
const WEBVIEW_CHECK_TIMEOUT_SECS: u64 = 90;

/// Arms the deadline for a `--webview-check` run.
///
/// Only the *absence* of a report is handled here. Every reported outcome, pass or fail, exits
/// through `commands::webview_check::report_webview_check`, which is why this task does nothing but
/// sleep: reaching the end of the sleep means the renderer never got far enough to call anything,
/// which is exactly the failure the check was added for (a bundle the webview refuses, a CSP that
/// blocks the entry script, a window that never opens).
fn spawn_webview_check_watchdog() {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(WEBVIEW_CHECK_TIMEOUT_SECS)).await;

        services::logger::error(
            "webview_check",
            format!(
                "the webview reported nothing within {WEBVIEW_CHECK_TIMEOUT_SECS}s: the window \
                 did not open, the frontend bundle did not load, or IPC from the renderer is \
                 refused"
            ),
        );

        std::process::exit(1);
    });
}

/// True when this process was launched to prove it starts, rather than to be used.
///
/// This exists because nothing else in the pipeline runs the binary. `cargo test` links the
/// `rlib` and never initializes the Tauri runtime, the webview, or `setup()`. `pnpm build` only
/// produces the frontend bundle. So the entire class of failure that happens between "the code
/// compiles" and "the window opens" (a bad application manifest, a runtime library the bundle
/// does not resolve, a plugin that fails to register, a panic in `setup()`), passes every gate in
/// `ci.yml` and `release.yml` and reaches the user as an app that does not open. This project has
/// already shipped one such bug (a `build.rs` manifest gate that made the process fail to load at
/// all, invisible to `cargo test`).
///
/// Kept a pure function over an iterator rather than reading `std::env::args()` directly so the
/// matching can be unit-tested (the caller passes the real arguments).
fn is_smoke_test_run(args: impl IntoIterator<Item = String>) -> bool {
    args.into_iter().any(|arg| arg == SMOKE_TEST_FLAG)
}

/// What to tell the user when the platform's webview runtime is the thing that is missing.
///
/// Each platform names the component it actually has to install, because that is the whole value
/// of the message: the failure the runtime reports for a missing WebView2 is a COM registration
/// error, which says nothing a user can act on. macOS is absent on purpose. WKWebView is part of
/// the OS there, so a build failure on macOS is never this.
#[cfg(windows)]
const MISSING_WEBVIEW_HELP: &str = "Kavynex needs the Microsoft Edge WebView2 Runtime, and it is \
     not installed on this computer.\n\nInstall it from \
     https://developer.microsoft.com/microsoft-edge/webview2/ and start Kavynex again.";

#[cfg(target_os = "linux")]
const MISSING_WEBVIEW_HELP: &str = "Kavynex renders its interface with WebKitGTK, which is not \
     available on this system.\n\nInstall the 4.1 series (libwebkit2gtk-4.1-0 on Debian/Ubuntu, \
     webkit2gtk4.1 on Fedora) and start Kavynex again. Installing the .deb/.rpm through your \
     package manager pulls it in for you. The AppImage carries its own copy.";

/// The message a failed `Builder::build` should show, given whether the webview runtime resolved.
///
/// Pure so both branches can be asserted, since the caller terminates the process. The technical
/// detail is kept in the friendly branch rather than replaced: it is what a bug report needs, and
/// dropping it would trade one unhelpful message for another.
#[cfg(any(windows, target_os = "linux"))]
fn startup_failure_message(build_error: &str, webview_available: bool) -> String {
    if webview_available {
        return format!("failed to build the application: {build_error}");
    }

    format!("{MISSING_WEBVIEW_HELP}\n\nTechnical detail: {build_error}")
}

#[cfg(not(any(windows, target_os = "linux")))]
fn startup_failure_message(build_error: &str, _webview_available: bool) -> String {
    format!("failed to build the application: {build_error}")
}

/// Reports a fatal startup failure and terminates with a non-zero code. The app is built with
/// `windows_subsystem = "windows"` (no console), so a panic here would be invisible. The user
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

    // SAFETY: both buffers are NUL-terminated UTF-16 and outlive the call. A null hwnd shows
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
    // visible in the terminal/journal. No native dialog is needed.
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
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Persist logs to a file (in addition to stderr) so issues on a user's machine
            // can be diagnosed from bug reports.
            if let Ok(log_dir) = app.path().app_log_dir() {
                services::logger::init(log_dir);
            }

            services::logger::info("app", "application setup started");

            // Pin the launch instant while it is still accurate: the pending-media sweep refuses to
            // consume any marker that is not older than it, and that cutoff has to be the real start
            // of the process rather than whenever the sweep first asked (see
            // services::pending_media::pin_process_start).
            services::pending_media::pin_process_start();

            // Apply a database import staged by the import command before the pool can open.
            // The connection pool is a process-wide singleton that cannot be swapped
            // in-process, so the actual file swap is deferred to this pre-open point. A
            // failed restore/import is logged but must not stop the app from starting. A
            // database *path* that cannot be resolved at all is fatal instead, without it
            // `Db` is never managed and every database-backed command would fail, leaving
            // the app an open but dead shell with no explanation.
            match services::database::database_path(&app_handle) {
                Ok(db_path) => {
                    // Register the database in managed state before any command can run, so pool
                    // access (and the restore-from-backup guard) go through it rather than a
                    // process-wide static. The pool itself still opens lazily on first use.
                    app.manage(services::database::Db::new(db_path.clone()));

                    // Finish a restore that died between moving the old database aside and
                    // renaming the staged snapshot in. The pool opens with create_if_missing,
                    // so without this the next launch would quietly create an empty database
                    // and show an empty library while the data sat in `.restore.tmp`. Runs
                    // before the import below so a pending import still sets the *restored*
                    // database aside as its undo snapshot.
                    match services::db_backup::resume_interrupted_restore(&db_path) {
                        Ok(true) => {
                            services::logger::info("app", "resumed an interrupted database restore")
                        }
                        Ok(false) => {}
                        Err(error) => services::logger::error(
                            "app",
                            format!("failed to resume an interrupted database restore: {error}"),
                        ),
                    }

                    match services::db_backup::apply_pending_database_import(&db_path) {
                        Ok(true) => {
                            services::logger::info("app", "applied a pending database import")
                        }
                        Ok(false) => {}
                        Err(error) => services::logger::error(
                            "app",
                            format!("failed to apply pending database import: {error}"),
                        ),
                    }
                }
                Err(error) => fail_startup(&format!(
                    "failed to resolve the database directory (check permissions and free \
                     space on the app config volume): {error}"
                )),
            }

            // Authorize the two cache subdirectories the webview renders from (the temporary
            // thumbnail preview and the display-sized thumbnail derivatives), in the asset
            // protocol scope, so both can be loaded via convertFileSrc. Only those two are
            // granted, never the cache root: on Windows the root is also the parent of the log
            // directory and of the WebView2 profile (see WEBVIEW_READABLE_CACHE_DIRS). The
            // library directory is authorized at runtime once the stored library path is known
            // (see register_library_asset_scope).
            match app.path().app_cache_dir() {
                Ok(cache_dir) => {
                    commands::security::register_cache_asset_scope(&app_handle, &cache_dir)
                }
                Err(error) => {
                    services::logger::warn(
                        "asset_scope",
                        format!("failed to resolve cache dir for asset scope: {error}"),
                    );
                }
            }

            spawn_startup_cleanup(app_handle.clone());
            spawn_startup_library_cleanup(app_handle.clone());
            spawn_pending_media_sweep(app_handle.clone());
            spawn_startup_integrity_check(app_handle.clone());
            spawn_periodic_backup(app_handle);
            services::logger::info("app", "application setup finished");

            // Startup self-check (see is_smoke_test_run): everything above this line has run, so
            // the process loaded, the runtime and every plugin initialized, the database path
            // resolved and any staged import applied. That is the whole of what a release can
            // verify without a human, and it is exactly what no other gate covers.
            //
            // `std::process::exit` rather than `AppHandle::exit`, matching fail_startup above: the
            // event loop has not started yet, so there is nothing to unwind and an unconditional
            // exit keeps the check's outcome unambiguous. The process either reaches this line
            // and returns 0, or it does not.
            if is_smoke_test_run(std::env::args()) {
                services::logger::info("app", "smoke test passed");
                std::process::exit(0);
            }

            // The deeper self-check, and the one this exit is the boundary of: everything past
            // this line (the window opening, the frontend bundle loading, the packaged CSP, and
            // every permission in `capabilities/`) is unreachable from `--smoke-test` by
            // construction. `--webview-check` lets the launch continue normally and has the
            // renderer report what it could actually do (see commands::webview_check). Checked
            // after the smoke test so passing both flags keeps the cheaper answer.
            if commands::webview_check::is_webview_check_run(std::env::args()) {
                services::logger::info(
                    "app",
                    "webview check requested, waiting for the renderer to report",
                );

                spawn_webview_check_watchdog();
            }

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
            commands::library::verify_library_content,
            commands::library::cancel_library_verification,
            commands::library::open_path_in_system,
            commands::media::create_media,
            commands::live_chat::stream_live_chat_file,
            commands::live_chat::list_live_chat_files,
            commands::live_chat::migrate_live_chat_to_library,
            commands::thumbnail::generate_temporary_thumbnail,
            commands::thumbnail::persist_thumbnail_file,
            commands::thumbnail::download_channel_avatar_from_handle,
            commands::thumbnail::resolve_display_thumbnails,
            commands::thumbnail::stage_manual_thumbnail,
            commands::thumbnail::delete_temporary_thumbnail,
            commands::thumbnail::delete_thumbnail_file,
            commands::comments::replace_media_comments,
            commands::comments::mark_media_comments_absent,
            commands::yt_dlp::fetch_youtube_comments,
            commands::yt_dlp::list_yt_dlp_formats,
            commands::yt_dlp::cancel_media_download,
            commands::yt_dlp::check_external_tools,
            commands::security::register_library_asset_scope,
            commands::database::ensure_database_ready,
            commands::database::get_database_backup_status,
            commands::database::restore_database_from_backup,
            commands::database::export_database,
            commands::database::import_database,
            commands::database::get_database_import_undo_status,
            commands::database::undo_database_import,
            commands::database::check_database_integrity,
            commands::logging::log_frontend_error,
            commands::logging::open_log_directory,
            commands::webview_check::begin_webview_check,
            commands::webview_check::report_webview_check,
            commands::settings::get_app_settings,
            commands::settings::set_app_settings,
            commands::settings::set_external_backup_dir,
            commands::channels::list_channels,
            commands::channels::find_channel_by_youtube_handle,
            commands::channels::get_channel_by_id,
            commands::channels::insert_channel,
            commands::channels::update_channel_name_and_handle,
            commands::channels::replace_channel_avatar,
            commands::channels::delete_channel_with_artifacts,
            commands::videos::update_media_title,
            commands::videos::list_media_page,
            commands::videos::list_media_comments_by_media_id,
            commands::videos::delete_media_with_artifacts,
            commands::videos::mark_media_as_watched,
            commands::videos::mark_media_as_unwatched,
            commands::videos::update_media_duration,
            commands::videos::update_media_progress,
            commands::videos::get_media_repository_stats
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| {
            // Asking the runtime rather than pattern-matching the error text: a missing WebView2
            // surfaces as a COM registration failure whose wording belongs to Windows, not to us,
            // and `webview_version()` answers the same question directly.
            fail_startup(&startup_failure_message(
                &error.to_string(),
                tauri::webview_version().is_ok(),
            ))
        })
        .run(|_app_handle, event| {
            // Terminate any in-flight yt-dlp/ffmpeg work when the app is exiting so it is not
            // left running as orphaned processes after the window closes. The download sweep
            // signals cancellation and kills the main download trees. The process-registry
            // sweep additionally covers the metadata, thumbnail and standalone (comment/format/
            // avatar) children, which the download registry never tracked.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                services::yt_dlp::cancel_all_active_downloads_blocking();
                services::process_registry::kill_all_tracked_blocking();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn smoke_test_flag_is_recognized_anywhere_in_the_argument_list() {
        // argv[0] is the executable path, and a launcher may append its own arguments, so the flag
        // must be matched positionally-independently rather than only as the first argument.
        assert!(is_smoke_test_run(args(&["kavynex", SMOKE_TEST_FLAG])));
        assert!(is_smoke_test_run(args(&[
            "/usr/bin/kavynex",
            "--other",
            SMOKE_TEST_FLAG,
        ])));
    }

    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    fn a_build_failure_with_a_working_webview_reports_the_technical_error() {
        let message = startup_failure_message("some other failure", true);

        assert!(message.contains("some other failure"));
        assert!(
            !message.contains(MISSING_WEBVIEW_HELP),
            "a failure that has nothing to do with the webview must not blame it"
        );
    }

    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    fn a_build_failure_with_no_webview_runtime_leads_with_how_to_install_it() {
        // This is the first thing a user sees on a machine without the runtime, and it arrives
        // before any window exists, so the actionable half has to come first.
        let message = startup_failure_message("Class not registered (0x80040154)", false);

        assert!(message.starts_with(MISSING_WEBVIEW_HELP));
        assert!(
            message.contains("Class not registered"),
            "the technical detail a bug report needs must survive"
        );
    }

    #[cfg(windows)]
    #[test]
    fn the_windows_help_points_at_the_runtime_download() {
        assert!(MISSING_WEBVIEW_HELP.contains("developer.microsoft.com/microsoft-edge/webview2"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_linux_help_names_the_package_to_install() {
        assert!(MISSING_WEBVIEW_HELP.contains("libwebkit2gtk-4.1-0"));
    }

    #[test]
    fn a_normal_launch_is_not_a_smoke_test() {
        // The consequence of a false positive here is an app that exits instead of opening, so a
        // near-miss must not match: no prefix, no substring, no bare word.
        assert!(!is_smoke_test_run(args(&["kavynex"])));
        assert!(!is_smoke_test_run(args(&["kavynex", "--smoke-test-mode"])));
        assert!(!is_smoke_test_run(args(&["kavynex", "smoke-test"])));
        assert!(!is_smoke_test_run(args(&["kavynex", "--smoke"])));
        assert!(!is_smoke_test_run(Vec::new()));
    }
}
