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

/// The container every thumbnail this app produces is written in.
///
/// Both producers read it: the yt-dlp download normalizes to it with `--convert-thumbnails` and
/// then looks the written file up by it (`services/thumbnail_download.rs`), and the local-import
/// FFmpeg preview names its output with it (`services/thumbnail_temp.rs`). It lives here rather
/// than in either module because it is one decision, and it was made in only one of them: the
/// download switched to JPEG while the local import kept writing lossless PNG, so a library that
/// mixes both sources ended up holding both formats for the same kind of content, and the size
/// win the switch was made for applied to half the paths.
///
/// JPEG rather than PNG: YouTube serves photographic JPEG thumbnails, and re-encoding those
/// losslessly to PNG multiplied the stored size for no visual gain - measured on a real library,
/// PNG thumbnails averaged ~365 KB against a few dozen KB for the JPEG originals, and the whole
/// directory sat at 322 MB for 904 media. Normalizing to one known extension is still worth doing
/// (the content-addressed name needs one), so the conversion stays; only the target changed.
///
/// Changing it changes only files produced from now on. Names are content-addressed, so an
/// existing thumbnail keeps its own extension and the rows pointing at it stay valid; nothing
/// re-encodes retroactively.
pub const THUMBNAIL_OUTPUT_FORMAT: &str = "jpg";

/// The width a display-sized thumbnail derivative is scaled down to (never up).
///
/// The grid's card is 158 px tall, so at 16:9 it draws roughly 280 px wide; 640 covers that at a
/// device pixel ratio of 2 with room to spare, and matches the cap the local-import generator
/// already applies (`thumbnail_temp.rs`'s scale filter), so a locally-imported thumbnail is passed
/// through at its own size rather than resampled for nothing. Against a yt-dlp `maxresdefault` at
/// 1280x720 it is a quarter of the decoded bitmap.
pub const DISPLAY_THUMBNAIL_MAX_WIDTH: u32 = 640;

pub const TEMP_DIR_THUMBS: &str = "thumbs-temp";
pub const TEMP_DIR_YT_DLP: &str = "yt-dlp-temp";
pub const TEMP_DIR_YT_DLP_THUMB: &str = "yt-dlp-thumb-temp";

// Holds the display-sized copies of the library's thumbnails (see services/thumbnail_display.rs).
// Derived and disposable: every entry is regenerable from the canonical file in the library, is
// addressed by that file's own content hash, and is swept with the rest of the cache directory.
pub const TEMP_DIR_THUMB_DISPLAY: &str = "thumb-display";

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
