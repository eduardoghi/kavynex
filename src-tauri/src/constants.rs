pub const LIBRARY_DIR_VIDEO: &str = "video";
pub const LIBRARY_DIR_AUDIO: &str = "audio";
pub const LIBRARY_DIR_THUMBNAILS: &str = "thumbnails";

pub const MANAGED_LIBRARY_DIRS: [&str; 3] =
    [LIBRARY_DIR_VIDEO, LIBRARY_DIR_AUDIO, LIBRARY_DIR_THUMBNAILS];

pub const TEMP_DIR_THUMBS: &str = "thumbs-temp";
pub const TEMP_DIR_YT_DLP: &str = "yt-dlp-temp";
pub const TEMP_DIR_YT_DLP_THUMB: &str = "yt-dlp-thumb-temp";

pub const EVENT_YT_DLP_LOG: &str = "yt-dlp-log";
pub const EVENT_YT_DLP_ERROR: &str = "yt-dlp-error";
pub const EVENT_YT_DLP_FINISHED: &str = "yt-dlp-finished";
pub const EVENT_YT_DLP_CANCELLED: &str = "yt-dlp-cancelled";
pub const EVENT_YT_DLP_TERMINAL: &str = "yt-dlp-terminal";
