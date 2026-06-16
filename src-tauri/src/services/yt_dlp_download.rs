use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::Mutex,
    time::timeout,
};

use crate::models::yt_dlp::{DownloadLogEvent, DownloadedMediaResult};
use crate::services::binaries::{
    ffmpeg_location_argument, resolve_ffmpeg_binary, resolve_yt_dlp_binary,
};
use crate::services::filesystem::{
    clean_matching_files_in_dir, find_best_matching_file, replace_file_safely,
};
use crate::services::library_paths::ensure_library_dir;
use crate::services::logger;
use crate::services::temp_paths::yt_dlp_temp_dir;
use crate::services::thumbnail_download::download_thumbnail_for_media_async;
use crate::services::yt_dlp_events::{
    emit_download_cancelled, emit_download_error, emit_download_finished, emit_download_log,
    infer_log_level,
};
use crate::services::yt_dlp_metadata::{
    fetch_yt_dlp_metadata, normalize_download_metadata, sanitize_filename_component,
};
use crate::services::yt_dlp_cookies::{
    append_auth_args, normalize_cookies_browser, normalize_cookies_path,
};
use crate::services::yt_dlp_registry::{register_download_run, unregister_download_run};
use crate::utils::format::codec_is_present;
use crate::utils::path::{ensure_path_parent_inside_dir, relative_path_from_base};
use crate::{AppError, AppErrorCode, AppResult};

const YT_DLP_WAIT_POLL_MILLIS: u64 = 250;
const MAX_CAPTURED_STDERR_LINES: usize = 100;
const EVENT_YT_DLP_LOG: &str = "yt-dlp-log";

fn unique_temp_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);

    format!("{}-{}", std::process::id(), nanos)
}

fn infer_is_live(metadata_live_status: Option<&str>, was_live: Option<bool>) -> bool {
    if was_live.unwrap_or(false) {
        return true;
    }

    let normalized = metadata_live_status.unwrap_or("").trim().to_lowercase();

    matches!(normalized.as_str(), "is_live" | "was_live" | "post_live")
}

fn find_live_chat_temp_file(temp_dir: &Path, file_prefix: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(temp_dir).ok()?;

    for entry in entries.flatten() {
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        let file_name = path.file_name()?.to_string_lossy().to_string();
        let normalized_name = file_name.to_lowercase();

        if normalized_name.starts_with(&file_prefix.to_lowercase())
            && normalized_name.contains("live_chat")
        {
            return Some(path);
        }
    }

    None
}

fn ensure_app_live_chat_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| {
        AppError::from_code(
            AppErrorCode::DataDirectoryResolveFailed,
            format!("failed to resolve app data directory: {e}"),
        )
    })?;

    fs::create_dir_all(&app_data_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateDirectoryFailed,
            format!("failed to create app data directory: {e}"),
        )
    })?;

    let live_chat_dir = app_data_dir.join("live_chat");

    fs::create_dir_all(&live_chat_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateDirectoryFailed,
            format!("failed to create app live chat directory: {e}"),
        )
    })?;

    Ok(live_chat_dir)
}

fn build_app_live_chat_relative_path(file_name: &Path) -> String {
    Path::new("live_chat")
        .join(file_name)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(target_os = "windows")]
async fn kill_process_tree(pid: u32) {
    if let Ok(mut child) = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        let _ = child.wait().await;
    }
}

#[cfg(not(target_os = "windows"))]
async fn kill_process_tree(pid: u32) {
    if let Ok(mut child) = Command::new("kill")
        .args(["-9", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        let _ = child.wait().await;
    }
}

pub async fn download_media_from_url_async(
    app: &AppHandle,
    url: &str,
    library_path: &str,
    run_id: &str,
    format_id: &str,
    download_live_chat: bool,
    skip_auto_thumbnail_download: bool,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
) -> AppResult<DownloadedMediaResult> {
    let normalized_url = url.trim().to_string();
    let normalized_run_id = run_id.trim().to_string();
    let normalized_format_id = format_id.trim().to_string();
    let normalized_cookies_browser = normalize_cookies_browser(cookies_browser);
    let normalized_cookies_path = normalize_cookies_path(cookies_path);

    if normalized_url.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidUrl,
            "url is empty",
        ));
    }

    if library_path.trim().is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryPath,
            "library path is empty",
        ));
    }

    if normalized_run_id.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidRunId,
            "run_id is empty",
        ));
    }

    if normalized_format_id.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidFormatId,
            "format_id is empty",
        ));
    }

    let cancel_flag = register_download_run(&normalized_run_id).await?;
    let yt_dlp = resolve_yt_dlp_binary(app)?;
    let ffmpeg = resolve_ffmpeg_binary(app)?;
    let ffmpeg_location = ffmpeg_location_argument(&ffmpeg);

    let library_dir = ensure_library_dir(library_path)?;
    let temp_root_dir = yt_dlp_temp_dir(app)?;

    let unique_run_dir = format!(
        "{}-{}",
        sanitize_filename_component(&normalized_run_id),
        unique_temp_suffix()
    );
    let temp_dir = temp_root_dir.join(unique_run_dir);

    fs::create_dir_all(&temp_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateTempDirFailed,
            format!("failed to create temporary directory: {e}"),
        )
    })?;

    logger::info(
        "yt_dlp",
        format!(
            "download run started: run_id='{}', url='{}', format_id='{}', download_live_chat='{}', skip_auto_thumbnail_download='{}', cookies_browser='{}', cookies_path='{}'",
            normalized_run_id,
            normalized_url,
            normalized_format_id,
            download_live_chat,
            skip_auto_thumbnail_download,
            normalized_cookies_browser.clone().unwrap_or_default(),
            normalized_cookies_path.clone().unwrap_or_default()
        ),
    );

    let result = async {
        emit_download_log(
            app,
            &normalized_run_id,
            format!("Resolving metadata for: {}", normalized_url),
            "system",
        )?;

        if let Some(path) = normalized_cookies_path.as_ref() {
            emit_download_log(
                app,
                &normalized_run_id,
                format!("Cookies file: {}", path),
                "system",
            )?;
        } else if let Some(browser) = normalized_cookies_browser.as_ref() {
            emit_download_log(
                app,
                &normalized_run_id,
                format!("Cookies from browser: {}", browser),
                "system",
            )?;
        }

        if download_live_chat {
            emit_download_log(
                app,
                &normalized_run_id,
                "Live chat replay: enabled",
                "system",
            )?;
        }

        if skip_auto_thumbnail_download {
            emit_download_log(
                app,
                &normalized_run_id,
                "Automatic thumbnail download: skipped (manual thumbnail provided)",
                "system",
            )?;
        }

        let metadata = match fetch_yt_dlp_metadata(
            &yt_dlp,
            &normalized_url,
            normalized_cookies_browser.as_deref(),
            normalized_cookies_path.as_deref(),
        )
        .await
        {
            Ok(metadata) => metadata,
            Err(error) => {
                emit_download_error(app, &normalized_run_id, error.message.clone());
                return Err(error);
            }
        };

        if cancel_flag.load(Ordering::SeqCst) {
            let message = "yt-dlp download cancelled";
            emit_download_cancelled(app, &normalized_run_id, message);

            return Err(AppError::from_code(
                AppErrorCode::YtDlpDownloadCancelled,
                message,
            ));
        }

        let thumbnail_path = if skip_auto_thumbnail_download {
            None
        } else {
            emit_download_log(
                app,
                &normalized_run_id,
                "Downloading thumbnail before media download",
                "system",
            )?;

            match download_thumbnail_for_media_async(
                app,
                &normalized_url,
                library_path,
                &metadata,
                normalized_cookies_browser.as_deref(),
                normalized_cookies_path.as_deref(),
            )
            .await
            {
                Ok(path) => {
                    if path.is_some() {
                        emit_download_log(
                            app,
                            &normalized_run_id,
                            "Thumbnail downloaded successfully",
                            "system",
                        )?;
                    } else {
                        emit_download_log(
                            app,
                            &normalized_run_id,
                            "No thumbnail available for this media",
                            "system",
                        )?;
                    }

                    path
                }
                Err(error) => {
                    emit_download_error(
                        app,
                        &normalized_run_id,
                        format!(
                            "thumbnail download failed before media download: {}",
                            error.message
                        ),
                    );

                    return Err(error);
                }
            }
        };

        if cancel_flag.load(Ordering::SeqCst) {
            let message = "yt-dlp download cancelled";
            emit_download_cancelled(app, &normalized_run_id, message);

            return Err(AppError::from_code(
                AppErrorCode::YtDlpDownloadCancelled,
                message,
            ));
        }

        let selected_format = metadata
            .formats
            .iter()
            .find(|item| {
                item.format_id
                    .as_deref()
                    .map(|value| value.trim() == normalized_format_id)
                    .unwrap_or(false)
            })
            .cloned();

        let is_combined_format = normalized_format_id.contains('+');

        let has_video = if let Some(format) = selected_format.as_ref() {
            codec_is_present(&format.vcodec)
        } else if is_combined_format {
            true
        } else {
            return Err(AppError::from_code(
                AppErrorCode::YtDlpSelectedFormatNotFound,
                "selected yt-dlp format was not found in metadata",
            ));
        };

        let media_subdir = if has_video { "video" } else { "audio" };
        let media_dir = library_dir.join(media_subdir);

        fs::create_dir_all(&media_dir).map_err(|e| {
            AppError::from_code(
                AppErrorCode::CreateMediaDirFailed,
                format!("failed to create media directory: {e}"),
            )
        })?;

        let app_live_chat_dir = if download_live_chat {
            Some(ensure_app_live_chat_dir(app)?)
        } else {
            None
        };

        let (id, extractor, suggested_title, youtube_video_id, published_at) =
            normalize_download_metadata(&metadata)?;

        let is_live = infer_is_live(metadata.live_status.as_deref(), metadata.was_live);

        let thumbnail_url = metadata
            .thumbnail
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let safe_extractor = sanitize_filename_component(&extractor);
        let safe_id = sanitize_filename_component(&id);
        let safe_format_id = sanitize_filename_component(&normalized_format_id);

        let expected_ext = selected_format
            .as_ref()
            .and_then(|format| format.ext.as_ref())
            .map(|value| value.trim().trim_start_matches('.').to_lowercase())
            .filter(|value| !value.is_empty());

        let file_prefix = format!("{}_{}_{}", safe_extractor, safe_id, safe_format_id);
        let file_name_prefix = format!("{file_prefix}.");

        clean_matching_files_in_dir(&temp_dir, &file_name_prefix)?;

        emit_download_log(
            app,
            &normalized_run_id,
            format!(
                "Starting download: {} (format {})",
                suggested_title, normalized_format_id
            ),
            "system",
        )?;

        let mut args = vec![
            "--ignore-config".to_string(),
            "--no-playlist".to_string(),
            "--restrict-filenames".to_string(),
            "--windows-filenames".to_string(),
            "--no-part".to_string(),
            "--newline".to_string(),
            "--progress".to_string(),
            "--no-warnings".to_string(),
            "--ffmpeg-location".to_string(),
            ffmpeg_location.clone(),
            "-f".to_string(),
            normalized_format_id.clone(),
        ];

        if download_live_chat {
            args.push("--write-subs".to_string());
            args.push("--sub-langs".to_string());
            args.push("live_chat".to_string());
        }

        append_auth_args(
            &mut args,
            normalized_cookies_browser.as_deref(),
            normalized_cookies_path.as_deref(),
        );

        args.extend_from_slice(&[
            "--paths".to_string(),
            format!("home:{}", temp_dir.to_string_lossy()),
            "--paths".to_string(),
            format!("temp:{}", temp_dir.to_string_lossy()),
            "-o".to_string(),
            format!("{}.%(ext)s", file_prefix),
            normalized_url.clone(),
        ]);

        emit_download_log(
            app,
            &normalized_run_id,
            format!("yt-dlp args: {}", args.join(" ")),
            "system",
        )?;

        let mut child = Command::new(&yt_dlp)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                AppError::from_code(
                    AppErrorCode::YtDlpDownloadSpawnFailed,
                    format!("failed to start yt-dlp download: {e}"),
                )
            })?;

        let child_pid = child.id();

        let stdout = child.stdout.take().ok_or_else(|| {
            AppError::from_code(
                AppErrorCode::YtDlpStdoutCaptureFailed,
                "failed to capture yt-dlp stdout",
            )
        })?;

        let stderr = child.stderr.take().ok_or_else(|| {
            AppError::from_code(
                AppErrorCode::YtDlpStderrCaptureFailed,
                "failed to capture yt-dlp stderr",
            )
        })?;

        let app_stdout = app.clone();
        let app_stderr = app.clone();
        let run_id_stdout = normalized_run_id.clone();
        let run_id_stderr = normalized_run_id.clone();

        let stderr_buffer: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let stderr_buffer_reader = Arc::clone(&stderr_buffer);

        let stdout_task = tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();

            while let Ok(Some(line_value)) = lines.next_line().await {
                let line = line_value.to_string();

                let _ = app_stdout.emit(
                    EVENT_YT_DLP_LOG,
                    DownloadLogEvent {
                        run_id: run_id_stdout.clone(),
                        level: infer_log_level(&line, "stdout"),
                        line: line.clone(),
                        stream: "stdout".to_string(),
                    },
                );
            }
        });

        let stderr_task = tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();

            while let Ok(Some(line_value)) = lines.next_line().await {
                let line = line_value.to_string();

                let mut guard = stderr_buffer_reader.lock().await;

                if guard.len() >= MAX_CAPTURED_STDERR_LINES {
                    guard.remove(0);
                }

                guard.push(line.clone());
                drop(guard);

                let _ = app_stderr.emit(
                    EVENT_YT_DLP_LOG,
                    DownloadLogEvent {
                        run_id: run_id_stderr.clone(),
                        level: infer_log_level(&line, "stderr"),
                        line: line.clone(),
                        stream: "stderr".to_string(),
                    },
                );
            }
        });

        let mut cancel_requested = false;

        let status = loop {
            if cancel_flag.load(Ordering::SeqCst) && !cancel_requested {
                cancel_requested = true;

                if let Some(pid) = child_pid {
                    kill_process_tree(pid).await;
                } else {
                    let _ = child.kill().await;
                }
            }

            match timeout(Duration::from_millis(YT_DLP_WAIT_POLL_MILLIS), child.wait()).await {
                Ok(wait_result) => {
                    break wait_result.map_err(|e| {
                        AppError::from_code(
                            AppErrorCode::YtDlpWaitFailed,
                            format!("failed while waiting for yt-dlp: {e}"),
                        )
                    })?;
                }
                Err(_) => {
                    continue;
                }
            }
        };

        if let Err(e) = stdout_task.await {
            logger::warn("yt_dlp", format!("yt-dlp stdout task failed: {e}"));
        }

        if let Err(e) = stderr_task.await {
            logger::warn("yt_dlp", format!("yt-dlp stderr task failed: {e}"));
        }

        if cancel_requested {
            let message = "yt-dlp download cancelled";
            emit_download_cancelled(app, &normalized_run_id, message);

            return Err(AppError::from_code(
                AppErrorCode::YtDlpDownloadCancelled,
                message,
            ));
        }

        if !status.success() {
            let stderr_message = {
                let guard = stderr_buffer.lock().await;

                if guard.is_empty() {
                    "yt-dlp failed".to_string()
                } else {
                    guard.join("\n")
                }
            };

            let message = if stderr_message.trim().is_empty() {
                "yt-dlp download failed".to_string()
            } else {
                format!("yt-dlp download failed: {}", stderr_message.trim())
            };

            emit_download_error(app, &normalized_run_id, message.clone());

            return Err(AppError::from_code(
                AppErrorCode::YtDlpDownloadFailed,
                message,
            ));
        }

        let downloaded_temp =
            find_best_matching_file(&temp_dir, &file_name_prefix, expected_ext.as_deref())
                .map_err(|_| {
                    AppError::from_code(
                        AppErrorCode::YtDlpDownloadedFileNotFound,
                        "download completed but the final file was not found",
                    )
                })?;

        let file_name = downloaded_temp.file_name().ok_or_else(|| {
            AppError::from_code(
                AppErrorCode::InvalidDownloadedFile,
                "downloaded file has no valid name",
            )
        })?;

        let final_destination = media_dir.join(file_name);

        ensure_path_parent_inside_dir(&final_destination, &library_dir)?;
        replace_file_safely(&downloaded_temp, &final_destination)?;

        let live_chat_file_path = if download_live_chat {
            if let Some(temp_live_chat_file) = find_live_chat_temp_file(&temp_dir, &file_prefix) {
                let live_chat_file_name = temp_live_chat_file.file_name().ok_or_else(|| {
                    AppError::from_code(
                        AppErrorCode::InvalidDownloadedFile,
                        "live chat file has no valid name",
                    )
                })?;

                let live_chat_dir = app_live_chat_dir.as_ref().ok_or_else(|| {
                    AppError::from_code(
                        AppErrorCode::DataDirectoryResolveFailed,
                        "app live chat directory was not initialized",
                    )
                })?;

                let final_live_chat_destination = live_chat_dir.join(live_chat_file_name);

                replace_file_safely(&temp_live_chat_file, &final_live_chat_destination)?;

                Some(build_app_live_chat_relative_path(Path::new(
                    live_chat_file_name,
                )))
            } else {
                None
            }
        } else {
            None
        };

        let result = DownloadedMediaResult {
            file_path: relative_path_from_base(&library_dir, &final_destination)?,
            suggested_title: suggested_title.clone(),
            youtube_video_id,
            published_at,
            media_type: media_subdir.to_string(),
            thumbnail_url,
            thumbnail_path,
            is_live,
            live_chat_file_path,
        };

        emit_download_finished(
            app,
            &normalized_run_id,
            result.file_path.clone(),
            result.suggested_title.clone(),
        );

        logger::info(
            "yt_dlp",
            format!(
                "download run finished successfully: run_id='{}', file='{}', live_chat='{}'",
                normalized_run_id,
                result.file_path,
                result.live_chat_file_path.clone().unwrap_or_default()
            ),
        );

        Ok(result)
    }
    .await;

    let _ = fs::remove_dir_all(&temp_dir);
    unregister_download_run(&normalized_run_id).await;

    if let Err(error) = &result {
        logger::error(
            "yt_dlp",
            format!(
                "download run failed: run_id='{}', error='{}'",
                normalized_run_id, error
            ),
        );
    }

    result
}
