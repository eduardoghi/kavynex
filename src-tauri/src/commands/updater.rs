//! The app update, checked and installed by the backend, and the relaunch.
//!
//! The renderer used to call the updater and process plugins directly, which the capability grants
//! allowed with every argument the plugin takes. The updater's `check` accepts a proxy, headers and a
//! target from the caller, so a renderer running hostile script could send a request through a
//! proxy of its choosing, carrying whatever it put in the proxy's URL. That was the one outbound
//! channel the app's other guards (the CSP, the image host allow-list) did not cover. These commands
//! take no such arguments. The endpoint, the timeout and everything else come from the app's own
//! configuration, and the renderer holds no updater or process grant at all.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{AppError, AppErrorCode, AppResult};

/// How long a check may take. The startup check runs on every launch, so a slow network fails it
/// rather than holding it.
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// How long the download may take. Settings stays locked while it runs, so one that stalls has to end
/// on its own. Generous for an installer of a few tens of megabytes on a slow link.
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// The update the last check found, which is the only one `install_app_update` installs. The
/// renderer never holds or names one.
#[derive(Default)]
pub struct PendingAppUpdate(tokio::sync::Mutex<Option<Update>>);

/// What the renderer is told about an available update.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub version: String,
    /// When the release was published, as `latest.json` states it.
    pub date: Option<String>,
    /// The release notes.
    pub body: Option<String>,
}

/// One progress message of an update download.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct AppUpdateDownloadProgress {
    /// Bytes downloaded so far.
    #[cfg_attr(test, ts(type = "number"))]
    pub downloaded: u64,
    /// The download's size, when the server said.
    #[cfg_attr(test, ts(type = "number | null"))]
    pub total: Option<u64>,
    /// The download finished and the installer is about to run.
    pub finished: bool,
}

fn update_error(message: &str, error: impl std::fmt::Display) -> AppError {
    AppError::from_code(AppErrorCode::AppError, format!("{message}: {error}"))
}

fn update_info(update: &Update) -> AppUpdateInfo {
    AppUpdateInfo {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date: update
            .raw_json
            .get("pub_date")
            .and_then(|date| date.as_str())
            .map(str::to_string),
        body: update.body.clone(),
    }
}

/// Asks the configured endpoint whether a newer release is out, and keeps what it found for
/// [`install_app_update`].
#[tauri::command]
pub async fn check_for_app_update<R: Runtime>(
    app: AppHandle<R>,
    pending: State<'_, PendingAppUpdate>,
) -> AppResult<Option<AppUpdateInfo>> {
    let updater = app
        .updater_builder()
        .timeout(UPDATE_CHECK_TIMEOUT)
        .build()
        .map_err(|error| update_error("could not prepare the update check", error))?;
    let found = updater
        .check()
        .await
        .map_err(|error| update_error("could not check for updates", error))?;

    let info = found.as_ref().map(update_info);
    *pending.0.lock().await = found;

    Ok(info)
}

/// Downloads and installs the update the last check found, reporting progress on `on_progress`, then
/// relaunches into it. On Windows the installer ends the process itself before the relaunch is
/// reached. The signature is verified by the plugin before anything is installed.
#[tauri::command]
pub async fn install_app_update<R: Runtime>(
    app: AppHandle<R>,
    pending: State<'_, PendingAppUpdate>,
    on_progress: Channel<AppUpdateDownloadProgress>,
) -> AppResult<()> {
    let Some(mut update) = pending.0.lock().await.clone() else {
        return Err(AppError::from_code(
            AppErrorCode::AppError,
            "no update was found to install, so check for updates again",
        ));
    };
    update.timeout = Some(UPDATE_DOWNLOAD_TIMEOUT);

    let downloaded = AtomicU64::new(0);
    let total = AtomicU64::new(0);

    update
        .download_and_install(
            |chunk, content_length| {
                let so_far = downloaded.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
                total.store(content_length.unwrap_or(0), Ordering::Relaxed);

                // A progress message the window did not take must not stop the install.
                let _ = on_progress.send(AppUpdateDownloadProgress {
                    downloaded: so_far,
                    total: content_length,
                    finished: false,
                });
            },
            || {
                let total = total.load(Ordering::Relaxed);

                let _ = on_progress.send(AppUpdateDownloadProgress {
                    downloaded: downloaded.load(Ordering::Relaxed),
                    total: (total > 0).then_some(total),
                    finished: true,
                });
            },
        )
        .await
        .map_err(|error| update_error("could not install the update", error))?;

    app.restart()
}

/// Relaunches the app, after an update or for a database import or undo applied at startup. Goes
/// through the normal exit, so running downloads are stopped and the database log is checkpointed.
///
/// `request_restart`, not `restart`. A command that is not `async` runs on the main thread, and
/// there `restart` skips the exit events and relaunches at once, which left a running yt-dlp or
/// ffmpeg behind and the log unfolded. `request_restart` asks the event loop to exit, which delivers
/// them from any thread.
#[tauri::command]
pub fn relaunch_app<R: Runtime>(app: AppHandle<R>) {
    app.request_restart();
}
