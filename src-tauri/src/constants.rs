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
/// Both producers read it. The yt-dlp download normalizes to it with `--convert-thumbnails` and
/// then looks the written file up by it (`services/thumbnail/download.rs`), and the local-import
/// FFmpeg preview names its output with it (`services/thumbnail/temp.rs`). It lives here rather
/// than in either module because it is one decision, and it was made in only one of them. The
/// download switched to JPEG while the local import kept writing lossless PNG, so a library that
/// mixes both sources ended up holding both formats for the same kind of content, and the size
/// win the switch was made for applied to half the paths.
///
/// JPEG rather than PNG: YouTube serves photographic JPEG thumbnails, and re-encoding those
/// losslessly to PNG multiplied the stored size for no visual gain. Measured on a real library,
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
/// already applies (`thumbnail/temp.rs`'s scale filter), so a locally-imported thumbnail is passed
/// through at its own size rather than resampled for nothing. Against a yt-dlp `maxresdefault` at
/// 1280x720 it is a quarter of the decoded bitmap.
pub const DISPLAY_THUMBNAIL_MAX_WIDTH: u32 = 640;

pub const TEMP_DIR_THUMBS: &str = "thumbs-temp";
pub const TEMP_DIR_YT_DLP: &str = "yt-dlp-temp";
pub const TEMP_DIR_YT_DLP_THUMB: &str = "yt-dlp-thumb-temp";

// Holds the display-sized copies of the library's thumbnails (see services/thumbnail/display.rs).
// Derived and disposable. Every entry is regenerable from the canonical file in the library, is
// addressed by that file's own content hash, and is swept with the rest of the cache directory.
pub const TEMP_DIR_THUMB_DISPLAY: &str = "thumb-display";

// Holds one marker per in-flight media creation, naming the library artifacts it has already
// written but not yet registered a row for. A marker still here at startup is a creation that died
// in that window; see services/pending_media.rs.
pub const TEMP_DIR_PENDING_MEDIA: &str = "pending-media";

/// The cache subdirectories whose files the webview actually renders, and therefore the only ones
/// the asset protocol is authorized to serve (`commands::security::managed_cache_scope_dirs`).
///
/// Both are drawn through `convertFileSrc`. `thumbs-temp/` holds the preview shown before a
/// thumbnail is committed to the library, and `thumb-display/` the display-sized derivatives the
/// grid draws. The other cache subdirectories are backend-only. `yt-dlp-temp/` and
/// `yt-dlp-thumb-temp/` are scratch whose output is moved into the library before any path reaches
/// the frontend, and `pending-media/` is read by the startup sweep alone.
///
/// The point of naming them is that the cache *root* is never granted. On Windows
/// `app_cache_dir()` resolves to `%LOCALAPPDATA%\<identifier>`, which is also the parent of the log
/// directory (`app_log_dir()`) and of the WebView2 profile (`EBWebView/`), so a recursive grant of
/// the root hands the renderer a tree it has no reason to reach. That is the same mistake
/// [`MANAGED_LIBRARY_DIRS`] exists to avoid for the user's library, and it is avoided here the same
/// way. Name the subdirectories, never the parent.
pub const WEBVIEW_READABLE_CACHE_DIRS: [&str; 2] = [TEMP_DIR_THUMBS, TEMP_DIR_THUMB_DISPLAY];

pub const EVENT_YT_DLP_LOG: &str = "yt-dlp-log";
pub const EVENT_YT_DLP_ERROR: &str = "yt-dlp-error";
pub const EVENT_YT_DLP_FINISHED: &str = "yt-dlp-finished";
pub const EVENT_YT_DLP_CANCELLED: &str = "yt-dlp-cancelled";
pub const EVENT_YT_DLP_TERMINAL: &str = "yt-dlp-terminal";

// Emitted when the background full integrity check finds the database may be corrupt, so the
// frontend can surface it proactively instead of leaving it buried in the log file. The payload
// is `{ "problems": [..] }`.
pub const EVENT_DATABASE_INTEGRITY_FAILED: &str = "database-integrity-failed";

// Emitted when the startup sweep gives up on one or more pending-media markers, i.e. when a crashed
// creation's artifacts have failed to reconcile enough times to stop being retried. Payload.
// `{ "abandoned": <count> }`. It exists for the same reason as the event above. The outcome is disk
// the user is paying for and a concrete next step (Diagnostics reports the files as unreferenced),
// and without this the only record of it is a log line nobody opens. See services/pending_media.rs.
pub const EVENT_PENDING_MEDIA_ABANDONED: &str = "pending-media-abandoned";
