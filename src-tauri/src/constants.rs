pub const LIBRARY_DIR_VIDEO: &str = "video";
pub const LIBRARY_DIR_AUDIO: &str = "audio";
pub const LIBRARY_DIR_THUMBNAILS: &str = "thumbnails";
pub const LIBRARY_DIR_LIVE_CHAT: &str = "live_chat";

pub const MANAGED_LIBRARY_DIRS: [&str; 4] = [
    LIBRARY_DIR_VIDEO,
    LIBRARY_DIR_AUDIO,
    LIBRARY_DIR_THUMBNAILS,
    LIBRARY_DIR_LIVE_CHAT,
];

pub const TEMP_DIR_THUMBS: &str = "thumbs-temp";
pub const TEMP_DIR_YT_DLP: &str = "yt-dlp-temp";
pub const TEMP_DIR_YT_DLP_THUMB: &str = "yt-dlp-thumb-temp";

// Holds one marker per in-flight media creation, naming the library artifacts it has already
// written but not yet registered a row for. A marker still here at startup is a creation that died
// in that window; see services/pending_media.rs.
pub const TEMP_DIR_PENDING_MEDIA: &str = "pending-media";

pub const EVENT_YT_DLP_LOG: &str = "yt-dlp-log";
pub const EVENT_YT_DLP_ERROR: &str = "yt-dlp-error";
pub const EVENT_YT_DLP_FINISHED: &str = "yt-dlp-finished";
pub const EVENT_YT_DLP_CANCELLED: &str = "yt-dlp-cancelled";
pub const EVENT_YT_DLP_TERMINAL: &str = "yt-dlp-terminal";

// Emitted when the background full integrity check finds the database may be corrupt, so the
// frontend can surface it proactively instead of leaving it buried in the log file. Payload:
// `{ "problems": [..] }`.
pub const EVENT_DATABASE_INTEGRITY_FAILED: &str = "database-integrity-failed";
