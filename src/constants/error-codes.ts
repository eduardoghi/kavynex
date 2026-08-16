import type { AppErrorCode } from "../types/generated/AppErrorCode";

export const APP_ERROR_CODE = "APP_ERROR" as const;
export const INVALID_INPUT_ERROR_CODE = "INVALID_INPUT" as const;
// Tags an error authored on the frontend whose message is meant to be shown to the user verbatim
// (see `ClientError` in utils/app-error.ts). Kept distinct from APP_ERROR (which the backend
// uses deliberately to *suppress* raw internal messages), so a user-facing client message is
// never mistaken for a backend one and hidden behind the generic fallback.
export const CLIENT_ERROR_CODE = "CLIENT_ERROR" as const;
export const DATABASE_SCHEMA_TOO_NEW_ERROR_CODE = "DATABASE_SCHEMA_TOO_NEW" as const;

export const INVALID_URL_ERROR_CODE = "INVALID_URL" as const;
export const INVALID_LIBRARY_PATH_ERROR_CODE = "INVALID_LIBRARY_PATH" as const;
// Raised when the library being registered in the asset scope was already released this session
// (the app migrated away from it and back). Tauri's scope cannot withdraw a forbid, so the grant
// would succeed while every media file stayed unreadable. This code is what turns that into a
// message telling the user to restart. See src-tauri/src/commands/security.rs.
export const ASSET_SCOPE_RESTART_REQUIRED_ERROR_CODE = "ASSET_SCOPE_RESTART_REQUIRED" as const;
export const INVALID_DIRECTORY_PATH_ERROR_CODE = "INVALID_DIRECTORY_PATH" as const;
export const READ_DIR_FAILED_ERROR_CODE = "READ_DIR_FAILED" as const;
// Diagnostics > Open log folder could not spawn the file manager. Catalogued because the generic
// fallback answers it by telling the user to go read the log file, which is exactly what just
// failed to open.
export const LOG_DIRECTORY_OPEN_FAILED_ERROR_CODE = "LOG_DIRECTORY_OPEN_FAILED" as const;
export const INVALID_MEDIA_PATH_ERROR_CODE = "INVALID_MEDIA_PATH" as const;
export const INVALID_THUMBNAIL_PATH_ERROR_CODE = "INVALID_THUMBNAIL_PATH" as const;
export const INVALID_TEMP_THUMBNAIL_PATH_ERROR_CODE = "INVALID_TEMP_THUMBNAIL_PATH" as const;

export const SOURCE_MEDIA_NOT_FOUND_ERROR_CODE = "SOURCE_MEDIA_NOT_FOUND" as const;
export const INVALID_SOURCE_MEDIA_ERROR_CODE = "INVALID_SOURCE_MEDIA" as const;
export const SOURCE_THUMBNAIL_NOT_FOUND_ERROR_CODE = "SOURCE_THUMBNAIL_NOT_FOUND" as const;
export const MEDIA_FILE_NOT_FOUND_ERROR_CODE = "MEDIA_FILE_NOT_FOUND" as const;
export const LIVE_CHAT_FILE_NOT_FOUND_ERROR_CODE = "LIVE_CHAT_FILE_NOT_FOUND" as const;
export const LIVE_CHAT_FILE_UNREADABLE_ERROR_CODE = "LIVE_CHAT_FILE_UNREADABLE" as const;
// The replay read refused by its concurrency gate, which is about load rather than about the file.
// so it sits with the other two rather than with them being reused for it. The distinction reaches
// the user: the other two mean the replay is gone or damaged, this one means to try again shortly.
export const TOO_MANY_CONCURRENT_LIVE_CHAT_READS_ERROR_CODE =
    "TOO_MANY_CONCURRENT_LIVE_CHAT_READS" as const;
export const INVALID_SOURCE_THUMBNAIL_ERROR_CODE = "INVALID_SOURCE_THUMBNAIL" as const;
export const INVALID_THUMBNAIL_FILE_ERROR_CODE = "INVALID_THUMBNAIL_FILE" as const;
export const THUMBNAIL_NOT_SUPPORTED_FOR_AUDIO_ERROR_CODE =
    "THUMBNAIL_NOT_SUPPORTED_FOR_AUDIO" as const;

export const FFMPEG_NOT_FOUND_ERROR_CODE = "FFMPEG_NOT_FOUND" as const;
export const FFMPEG_FAILED_ERROR_CODE = "FFMPEG_FAILED" as const;
export const FFMPEG_EXEC_FAILED_ERROR_CODE = "FFMPEG_EXEC_FAILED" as const;

export const YT_DLP_NOT_FOUND_ERROR_CODE = "YT_DLP_NOT_FOUND" as const;
export const YT_DLP_METADATA_TIMEOUT_ERROR_CODE = "YT_DLP_METADATA_TIMEOUT" as const;
export const YT_DLP_DOWNLOAD_TIMEOUT_ERROR_CODE = "YT_DLP_DOWNLOAD_TIMEOUT" as const;
export const YT_DLP_THUMBNAIL_TIMEOUT_ERROR_CODE = "YT_DLP_THUMBNAIL_TIMEOUT" as const;
export const YT_DLP_DOWNLOAD_FAILED_ERROR_CODE = "YT_DLP_DOWNLOAD_FAILED" as const;
export const YT_DLP_DOWNLOAD_CANCELLED_ERROR_CODE = "YT_DLP_DOWNLOAD_CANCELLED" as const;
export const YT_DLP_THUMBNAIL_FAILED_ERROR_CODE = "YT_DLP_THUMBNAIL_FAILED" as const;
export const YT_DLP_METADATA_FAILED_ERROR_CODE = "YT_DLP_METADATA_FAILED" as const;
// The two remaining metadata failures of the paste-a-URL flow. Their comment-fetch counterparts
// (YT_DLP_COMMENTS_EXEC_FAILED / _PARSE_FAILED) were catalogued and these were not, which left the
// app's hottest path answering with the generic line for the two causes a user can act on: a yt-dlp
// that cannot be started, and one too old to read what YouTube now returns.
export const YT_DLP_METADATA_EXEC_FAILED_ERROR_CODE = "YT_DLP_METADATA_EXEC_FAILED" as const;
export const YT_DLP_METADATA_PARSE_FAILED_ERROR_CODE = "YT_DLP_METADATA_PARSE_FAILED" as const;
export const INVALID_FORMAT_ID_ERROR_CODE = "INVALID_FORMAT_ID" as const;
export const INVALID_RUN_ID_ERROR_CODE = "INVALID_RUN_ID" as const;
export const TOO_MANY_CONCURRENT_YT_DLP_RUNS_ERROR_CODE =
    "TOO_MANY_CONCURRENT_YT_DLP_RUNS" as const;

export const YT_DLP_SELECTED_FORMAT_NOT_FOUND_ERROR_CODE =
    "YT_DLP_SELECTED_FORMAT_NOT_FOUND" as const;
export const YT_DLP_RUN_ALREADY_ACTIVE_ERROR_CODE = "YT_DLP_RUN_ALREADY_ACTIVE" as const;

// The comment backup failures. They only reach the user through the player's manual refresh (the
// import path logs them and continues without comments), and there the fetch runs before anything
// is written, so the comments already saved are always intact. That is the part worth saying, and
// the generic fallback these used to take could not say it.
export const YT_DLP_COMMENTS_TIMEOUT_ERROR_CODE = "YT_DLP_COMMENTS_TIMEOUT" as const;
export const YT_DLP_COMMENTS_EXEC_FAILED_ERROR_CODE = "YT_DLP_COMMENTS_EXEC_FAILED" as const;
export const YT_DLP_COMMENTS_FAILED_ERROR_CODE = "YT_DLP_COMMENTS_FAILED" as const;
export const YT_DLP_COMMENTS_PARSE_FAILED_ERROR_CODE = "YT_DLP_COMMENTS_PARSE_FAILED" as const;
export const YT_DLP_COMMENTS_INCOMPLETE_ERROR_CODE = "YT_DLP_COMMENTS_INCOMPLETE" as const;

export const UNSUPPORTED_MEDIA_EXTENSION_ERROR_CODE = "UNSUPPORTED_MEDIA_EXTENSION" as const;

// A local import the user stopped. Deliberately its own code rather than reusing
// YT_DLP_DOWNLOAD_CANCELLED: the two are routed identically (both are the outcome the user asked
// for, so both go to the neutral notice channel rather than the error modal), but they are
// different operations, and a yt-dlp code appearing after a file import would be a lie in the log.
export const MEDIA_IMPORT_CANCELLED_ERROR_CODE = "MEDIA_IMPORT_CANCELLED" as const;

// The three database-recovery refusals. They surface in Settings > Database and in the
// restore-from-backup flow the app offers after a failed open, which is the worst possible moment
// to answer with the generic "check the app log file" line.
export const NO_DATABASE_BACKUP_AVAILABLE_ERROR_CODE = "NO_DATABASE_BACKUP_AVAILABLE" as const;
export const NO_DATABASE_IMPORT_TO_UNDO_ERROR_CODE = "NO_DATABASE_IMPORT_TO_UNDO" as const;
export const DATABASE_ALREADY_OPEN_ERROR_CODE = "DATABASE_ALREADY_OPEN" as const;

export const DESTINATION_ALREADY_EXISTS_ERROR_CODE = "DESTINATION_ALREADY_EXISTS" as const;
export const INVALID_LIBRARY_MIGRATION_ERROR_CODE = "INVALID_LIBRARY_MIGRATION" as const;
// A second library folder change started while one is still copying. Nothing is wrong and the
// action is to wait, the same shape as YT_DLP_RUN_ALREADY_ACTIVE. It was the one "already running"
// refusal with no message of its own.
export const LIBRARY_MIGRATION_ALREADY_RUNNING_ERROR_CODE =
    "LIBRARY_MIGRATION_ALREADY_RUNNING" as const;
// The deep library verification is single-run: a second request is refused rather than queued,
// because the work is proportional to the size of the library and two sweeps would read every
// byte twice while competing for the same disk. Nothing is wrong and the action is to wait, the
// same shape as LIBRARY_MIGRATION_ALREADY_RUNNING above.
export const LIBRARY_VERIFICATION_IN_PROGRESS_ERROR_CODE =
    "LIBRARY_VERIFICATION_IN_PROGRESS" as const;
export const LIBRARY_VERIFICATION_FAILED_ERROR_CODE = "LIBRARY_VERIFICATION_FAILED" as const;
export const PATH_OUTSIDE_BASE_DIR_ERROR_CODE = "PATH_OUTSIDE_BASE_DIR" as const;

export const CHANNEL_ALREADY_EXISTS_ERROR_CODE = "CHANNEL_ALREADY_EXISTS" as const;
export const INVALID_YOUTUBE_HANDLE_ERROR_CODE = "INVALID_YOUTUBE_HANDLE" as const;
export const INVALID_CHANNEL_NAME_ERROR_CODE = "INVALID_CHANNEL_NAME" as const;
export const INVALID_CHANNEL_ID_ERROR_CODE = "INVALID_CHANNEL_ID" as const;
export const INVALID_MEDIA_CREATION_ARGUMENTS_ERROR_CODE =
    "INVALID_MEDIA_CREATION_ARGUMENTS" as const;
export const MEDIA_IMPORT_FAILED_ERROR_CODE = "MEDIA_IMPORT_FAILED" as const;
export const VIDEO_ALREADY_EXISTS_FOR_CHANNEL_ERROR_CODE =
    "VIDEO_ALREADY_EXISTS_FOR_CHANNEL" as const;
export const CHANNEL_NOT_FOUND_ERROR_CODE = "CHANNEL_NOT_FOUND" as const;
export const MEDIA_NOT_FOUND_ERROR_CODE = "MEDIA_NOT_FOUND" as const;
export const INVALID_YOUTUBE_VIDEO_ID_ERROR_CODE = "INVALID_YOUTUBE_VIDEO_ID" as const;
export const INVALID_MEDIA_TITLE_ERROR_CODE = "INVALID_MEDIA_TITLE" as const;
export const MEDIA_WITHOUT_YOUTUBE_SOURCE_ERROR_CODE = "MEDIA_WITHOUT_YOUTUBE_SOURCE" as const;
export const INVALID_YOUTUBE_COMMENTS_PAYLOAD_ERROR_CODE =
    "INVALID_YOUTUBE_COMMENTS_PAYLOAD" as const;
export const YOUTUBE_COMMENTS_EMPTY_REFRESH_ERROR_CODE =
    "YOUTUBE_COMMENTS_EMPTY_REFRESH" as const;

// Error codes raised only by the frontend (never emitted by the Rust backend), so they are not
// part of the ts-rs-generated AppErrorCode union and are exempt from the check below.
type FrontendOnlyErrorCode =
    | typeof CLIENT_ERROR_CODE
    | typeof INVALID_CHANNEL_ID_ERROR_CODE
    | typeof MEDIA_IMPORT_FAILED_ERROR_CODE
    | typeof MEDIA_WITHOUT_YOUTUBE_SOURCE_ERROR_CODE
    | typeof INVALID_YOUTUBE_COMMENTS_PAYLOAD_ERROR_CODE
    | typeof YOUTUBE_COMMENTS_EMPTY_REFRESH_ERROR_CODE;

// Compile-time link to the Rust AppErrorCode enum (the ts-rs-generated union): every known code
// must be either a member of that union or an explicitly-declared frontend-only code. Renaming or
// removing a Rust variant the frontend still lists here then fails `tsc` instead of silently
// leaving a dead `error.code === X` comparison.
export const KNOWN_ERROR_CODES = [
    APP_ERROR_CODE,
    CLIENT_ERROR_CODE,
    INVALID_INPUT_ERROR_CODE,
    DATABASE_SCHEMA_TOO_NEW_ERROR_CODE,
    INVALID_URL_ERROR_CODE,
    INVALID_LIBRARY_PATH_ERROR_CODE,
    INVALID_DIRECTORY_PATH_ERROR_CODE,
    READ_DIR_FAILED_ERROR_CODE,
    LOG_DIRECTORY_OPEN_FAILED_ERROR_CODE,
    INVALID_MEDIA_PATH_ERROR_CODE,
    INVALID_THUMBNAIL_PATH_ERROR_CODE,
    INVALID_TEMP_THUMBNAIL_PATH_ERROR_CODE,
    SOURCE_MEDIA_NOT_FOUND_ERROR_CODE,
    INVALID_SOURCE_MEDIA_ERROR_CODE,
    SOURCE_THUMBNAIL_NOT_FOUND_ERROR_CODE,
    INVALID_SOURCE_THUMBNAIL_ERROR_CODE,
    MEDIA_FILE_NOT_FOUND_ERROR_CODE,
    LIVE_CHAT_FILE_NOT_FOUND_ERROR_CODE,
    LIVE_CHAT_FILE_UNREADABLE_ERROR_CODE,
    TOO_MANY_CONCURRENT_LIVE_CHAT_READS_ERROR_CODE,
    INVALID_THUMBNAIL_FILE_ERROR_CODE,
    THUMBNAIL_NOT_SUPPORTED_FOR_AUDIO_ERROR_CODE,
    FFMPEG_NOT_FOUND_ERROR_CODE,
    FFMPEG_FAILED_ERROR_CODE,
    FFMPEG_EXEC_FAILED_ERROR_CODE,
    YT_DLP_NOT_FOUND_ERROR_CODE,
    YT_DLP_METADATA_TIMEOUT_ERROR_CODE,
    YT_DLP_DOWNLOAD_TIMEOUT_ERROR_CODE,
    YT_DLP_THUMBNAIL_TIMEOUT_ERROR_CODE,
    YT_DLP_DOWNLOAD_FAILED_ERROR_CODE,
    YT_DLP_DOWNLOAD_CANCELLED_ERROR_CODE,
    YT_DLP_THUMBNAIL_FAILED_ERROR_CODE,
    YT_DLP_METADATA_FAILED_ERROR_CODE,
    YT_DLP_METADATA_EXEC_FAILED_ERROR_CODE,
    YT_DLP_METADATA_PARSE_FAILED_ERROR_CODE,
    INVALID_FORMAT_ID_ERROR_CODE,
    INVALID_RUN_ID_ERROR_CODE,
    TOO_MANY_CONCURRENT_YT_DLP_RUNS_ERROR_CODE,
    YT_DLP_SELECTED_FORMAT_NOT_FOUND_ERROR_CODE,
    YT_DLP_RUN_ALREADY_ACTIVE_ERROR_CODE,
    YT_DLP_COMMENTS_TIMEOUT_ERROR_CODE,
    YT_DLP_COMMENTS_EXEC_FAILED_ERROR_CODE,
    YT_DLP_COMMENTS_FAILED_ERROR_CODE,
    YT_DLP_COMMENTS_PARSE_FAILED_ERROR_CODE,
    YT_DLP_COMMENTS_INCOMPLETE_ERROR_CODE,
    UNSUPPORTED_MEDIA_EXTENSION_ERROR_CODE,
    MEDIA_IMPORT_CANCELLED_ERROR_CODE,
    NO_DATABASE_BACKUP_AVAILABLE_ERROR_CODE,
    NO_DATABASE_IMPORT_TO_UNDO_ERROR_CODE,
    DATABASE_ALREADY_OPEN_ERROR_CODE,
    DESTINATION_ALREADY_EXISTS_ERROR_CODE,
    INVALID_LIBRARY_MIGRATION_ERROR_CODE,
    LIBRARY_MIGRATION_ALREADY_RUNNING_ERROR_CODE,
    LIBRARY_VERIFICATION_IN_PROGRESS_ERROR_CODE,
    LIBRARY_VERIFICATION_FAILED_ERROR_CODE,
    ASSET_SCOPE_RESTART_REQUIRED_ERROR_CODE,
    PATH_OUTSIDE_BASE_DIR_ERROR_CODE,
    CHANNEL_ALREADY_EXISTS_ERROR_CODE,
    INVALID_YOUTUBE_HANDLE_ERROR_CODE,
    INVALID_CHANNEL_NAME_ERROR_CODE,
    INVALID_CHANNEL_ID_ERROR_CODE,
    INVALID_MEDIA_CREATION_ARGUMENTS_ERROR_CODE,
    MEDIA_IMPORT_FAILED_ERROR_CODE,
    VIDEO_ALREADY_EXISTS_FOR_CHANNEL_ERROR_CODE,
    CHANNEL_NOT_FOUND_ERROR_CODE,
    MEDIA_NOT_FOUND_ERROR_CODE,
    INVALID_YOUTUBE_VIDEO_ID_ERROR_CODE,
    INVALID_MEDIA_TITLE_ERROR_CODE,
    MEDIA_WITHOUT_YOUTUBE_SOURCE_ERROR_CODE,
    INVALID_YOUTUBE_COMMENTS_PAYLOAD_ERROR_CODE,
    YOUTUBE_COMMENTS_EMPTY_REFRESH_ERROR_CODE,
] as const satisfies readonly (AppErrorCode | FrontendOnlyErrorCode)[];

export type KnownErrorCode = typeof KNOWN_ERROR_CODES[number];