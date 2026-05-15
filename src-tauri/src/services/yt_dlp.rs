pub use crate::services::yt_dlp_download::download_media_from_url_async;
pub use crate::services::yt_dlp_metadata::{
    fetch_youtube_comments_async, fetch_yt_dlp_metadata, list_yt_dlp_formats_async,
    sanitize_filename_component,
};
pub use crate::services::yt_dlp_registry::cancel_media_download_async;

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
