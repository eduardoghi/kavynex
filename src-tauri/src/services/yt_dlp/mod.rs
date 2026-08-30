//! The yt-dlp feature family. Every invocation of the external binary, the run registry that makes
//! those invocations cancellable, and the URL/cookie/argument handling that decides what is
//! allowed to reach it. Each concern is a submodule here rather than a `yt_dlp_*` sibling of this
//! file; see `services/mod.rs` for why the grouping exists.
//!
//! `download/` keeps its own directory inside the family. It had already outgrown a single file
//! and split into the async orchestration, the pure argv/outcome planning (`command.rs`) and the
//! log redaction (`redaction.rs`).
//!
//! Beyond the re-exports the command layer imports, this module holds nothing of its own.

pub mod cookies;
pub mod download;
pub mod events;
pub mod metadata;
pub mod registry;
pub mod url;

pub use download::{cancel_all_active_downloads_blocking, download_media_from_url_async};
pub use metadata::{
    fetch_youtube_comments_async, fetch_yt_dlp_metadata, list_yt_dlp_formats_async,
    sanitize_filename_component,
};
pub use registry::cancel_media_download;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_filename_component_replaces_invalid_chars() {
        assert_eq!(
            sanitize_filename_component("Hello World?/Test"),
            "Hello_World_Test".to_string()
        );
    }

    #[test]
    fn sanitize_filename_component_falls_back_when_empty() {
        assert_eq!(sanitize_filename_component("   "), "media".to_string());
    }
}
