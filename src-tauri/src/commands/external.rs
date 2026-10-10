use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::services::yt_dlp::metadata::is_valid_youtube_video_id;
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

// The URLs are built here rather than accepted from the renderer, so the system opener only ever
// receives a fixed YouTube prefix followed by an id made of `[A-Za-z0-9_-]`. On Windows the opener
// hands the string to the shell, and a renderer-supplied URL would have to be parsed and re-checked
// for every character the shell treats specially.

/// Builds the watch URL for a YouTube video id, refusing anything that is not one.
fn youtube_watch_url(video_id: &str) -> AppResult<String> {
    let video_id = video_id.trim();

    if !is_valid_youtube_video_id(video_id) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidYoutubeVideoId,
            "not a YouTube video id",
        ));
    }

    Ok(format!("https://www.youtube.com/watch?v={video_id}"))
}

/// Whether `value` is a YouTube channel id, `UC` followed by 22 characters of `[A-Za-z0-9_-]`.
/// The comment and live chat authors carry this form, not a handle.
fn is_youtube_channel_id(value: &str) -> bool {
    value.len() == 24
        && value.starts_with("UC")
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Builds the page URL for a YouTube channel id, refusing anything that is not one.
fn youtube_channel_url(channel_id: &str) -> AppResult<String> {
    let channel_id = channel_id.trim();

    if !is_youtube_channel_id(channel_id) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidInput,
            "not a YouTube channel id",
        ));
    }

    Ok(format!("https://www.youtube.com/channel/{channel_id}"))
}

fn open_in_browser<R: Runtime>(app: AppHandle<R>, url: String) -> AppResult<()> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| AppError::from_code(AppErrorCode::AppError, error.to_string()))
}

/// Opens a YouTube video in the default browser.
///
/// The renderer used to call the opener plugin's `open_url` directly, which needed
/// `opener:allow-open-url` granted to the webview. The app only ever opens a video's watch page or
/// an author's channel page, so the renderer now sends just the id and holds no opener grant.
#[tauri::command]
pub async fn open_youtube_video<R: Runtime>(app: AppHandle<R>, video_id: String) -> AppResult<()> {
    let url = youtube_watch_url(&video_id)?;

    run_blocking(move || open_in_browser(app, url)).await
}

/// Opens a YouTube channel page in the default browser. See `open_youtube_video`.
#[tauri::command]
pub async fn open_youtube_channel<R: Runtime>(
    app: AppHandle<R>,
    channel_id: String,
) -> AppResult<()> {
    let url = youtube_channel_url(&channel_id)?;

    run_blocking(move || open_in_browser(app, url)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_video_id_becomes_its_watch_url() {
        assert_eq!(
            youtube_watch_url(" dQw4w9WgXcQ ").unwrap(),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
    }

    #[test]
    fn anything_but_a_video_id_is_refused_before_the_opener() {
        for value in [
            "",
            "https://evil.example/",
            "dQw4w9WgXcQ&x",
            "dQw4w9W\"gXc",
            "dQw4w9 gXcQ",
            "dQw4w9\ngXcQ",
            "dQw4w9WgXcQQ",
        ] {
            let error = youtube_watch_url(value).unwrap_err();
            assert_eq!(
                error.code,
                AppErrorCode::InvalidYoutubeVideoId.as_str(),
                "{value:?}"
            );
        }
    }

    #[test]
    fn a_channel_id_becomes_its_channel_url() {
        assert_eq!(
            youtube_channel_url("UCuAXFkgsw1L7xaCfnd5JJOw").unwrap(),
            "https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw"
        );
    }

    #[test]
    fn anything_but_a_channel_id_is_refused_before_the_opener() {
        for value in [
            "",
            "@handle",
            "dQw4w9WgXcQ",
            "UCuAXFkgsw1L7xaCfnd5JJO",
            "UCuAXFkgsw1L7xaCfnd5JJOw/../x",
            "UCuAXFkgsw1L7xaCfnd5JJ\"w",
            "XXuAXFkgsw1L7xaCfnd5JJOw",
        ] {
            let error = youtube_channel_url(value).unwrap_err();
            assert_eq!(error.code, AppErrorCode::InvalidInput.as_str(), "{value:?}");
        }
    }
}
