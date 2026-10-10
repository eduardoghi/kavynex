//! Builds the main window, which `tauri.conf.json` declares with `"create": false` so it can be
//! built here with two hooks a config-created window cannot carry.
//!
//! The webview may navigate only to the app's own pages, and `window.open` (or a `target="_blank"`
//! link) opens nothing. Without them, a renderer that got to run a script could load a remote page
//! into the window that holds the IPC bridge, or open a popup the CSP of this app does not govern.
//! The app never navigates away from its own origin (YouTube links go out through
//! `commands::external`), so both refusals cost nothing in normal use.

use tauri::webview::NewWindowResponse;
use tauri::{App, Url, WebviewWindowBuilder};

use crate::services::logger;

/// Whether the main webview may navigate to `url`.
///
/// The bundled frontend is served from `tauri://localhost` (macOS, Linux) or
/// `http(s)://tauri.localhost` (Windows). A dev build loads from the configured dev server instead.
pub(crate) fn is_app_navigation(url: &Url, dev_url: Option<&Url>) -> bool {
    let is_bundled = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    };

    is_bundled || dev_url.is_some_and(|dev_url| dev_url.origin() == url.origin())
}

pub(crate) fn create(app: &App) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .ok_or(tauri::Error::WindowNotFound)?;

    let dev_url = if tauri::is_dev() {
        app.config().build.dev_url.clone()
    } else {
        None
    };

    WebviewWindowBuilder::from_config(app.handle(), &config)?
        .on_navigation(move |url| {
            let allowed = is_app_navigation(url, dev_url.as_ref());

            if !allowed {
                logger::warn(
                    "navigation",
                    format!(
                        "refused a navigation away from the app to {}",
                        url.origin().ascii_serialization()
                    ),
                );
            }

            allowed
        })
        .on_new_window(|url, _features| {
            logger::warn(
                "navigation",
                format!(
                    "refused to open a new window for {}",
                    url.origin().ascii_serialization()
                ),
            );

            NewWindowResponse::Deny
        })
        .build()?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn the_bundled_frontend_may_be_navigated_on_every_platform() {
        for value in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/#/settings",
        ] {
            assert!(is_app_navigation(&url(value), None), "{value}");
        }
    }

    #[test]
    fn the_dev_server_is_allowed_only_when_one_is_configured() {
        let dev = url("http://localhost:1420");

        assert!(is_app_navigation(
            &url("http://localhost:1420/"),
            Some(&dev)
        ));
        assert!(!is_app_navigation(&url("http://localhost:1420/"), None));
        assert!(!is_app_navigation(
            &url("http://localhost:1421/"),
            Some(&dev)
        ));
    }

    #[test]
    fn anything_else_is_refused() {
        for value in [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "http://tauri.localhost.evil.example/",
            "https://evil.example/tauri.localhost",
            "file:///C:/Windows/win.ini",
            "data:text/html,<script>1</script>",
            "javascript:alert(1)",
            "asset://localhost/x",
        ] {
            assert!(!is_app_navigation(&url(value), None), "{value}");
        }
    }
}
