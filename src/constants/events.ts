export const EVENT_YT_DLP_LOG = "yt-dlp-log";
export const EVENT_YT_DLP_ERROR = "yt-dlp-error";
export const EVENT_YT_DLP_FINISHED = "yt-dlp-finished";
export const EVENT_YT_DLP_CANCELLED = "yt-dlp-cancelled";
export const EVENT_YT_DLP_TERMINAL = "yt-dlp-terminal";

// Emitted by the backend when the background full integrity check finds the database may be
// corrupt, so the app can surface it to the user instead of leaving it only in the log file.
export const EVENT_DATABASE_INTEGRITY_FAILED = "database-integrity-failed";

// Emitted by the backend's startup sweep when it stops retrying one or more crashed media
// creations, leaving their files in the library for Diagnostics to report. Same reasoning as the
// event above: the outcome costs the user disk and has a concrete next step, so it should not live
// only in the log file.
export const EVENT_PENDING_MEDIA_ABANDONED = "pending-media-abandoned";