export const EVENT_YT_DLP_LOG = "yt-dlp-log";
export const EVENT_YT_DLP_ERROR = "yt-dlp-error";
export const EVENT_YT_DLP_FINISHED = "yt-dlp-finished";
export const EVENT_YT_DLP_CANCELLED = "yt-dlp-cancelled";
export const EVENT_YT_DLP_TERMINAL = "yt-dlp-terminal";

// Emitted by the backend when the background full integrity check finds the database may be
// corrupt, so the app can surface it to the user instead of leaving it only in the log file.
export const EVENT_DATABASE_INTEGRITY_FAILED = "database-integrity-failed";