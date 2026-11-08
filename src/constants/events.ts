// The event names the backend emits, generated from src-tauri/src/constants.rs so the two sides
// cannot name an event differently. What each one is for is on its constant there.
export {
    EVENT_YT_DLP_LOG,
    EVENT_YT_DLP_ERROR,
    EVENT_YT_DLP_FINISHED,
    EVENT_YT_DLP_CANCELLED,
    EVENT_YT_DLP_TERMINAL,
    EVENT_DATABASE_INTEGRITY_FAILED,
    EVENT_PENDING_MEDIA_ABANDONED,
    EVENT_IMPORTED_DATABASE_MISSING_FILES,
} from "../types/generated/events";
