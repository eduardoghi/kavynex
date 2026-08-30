export const TAURI_COMMANDS = {
    CHECK_EXTERNAL_TOOLS: "check_external_tools",
    LOG_FRONTEND_ERROR: "log_frontend_error",
    // Takes no arguments, deliberately. The backend resolves the log directory from `app_log_dir()`
    // so there is no path for a caller to redirect. See src-tauri/src/commands/logging.rs.
    OPEN_LOG_DIRECTORY: "open_log_directory",

    // The startup self-check that runs inside the webview (src/lib/webview-check.ts). Only ever
    // called by that module: BEGIN returns null on every normal launch, and REPORT terminates the
    // process with the check's outcome.
    BEGIN_WEBVIEW_CHECK: "begin_webview_check",
    REPORT_WEBVIEW_CHECK: "report_webview_check",

    ENSURE_DIRECTORY_EXISTS: "ensure_directory_exists",
    RESOLVE_EXISTING_DIRECTORY: "resolve_existing_directory",
    MIGRATE_LIBRARY_DIRECTORY: "migrate_library_directory",
    GET_LIBRARY_SUMMARY: "get_library_summary",
    CHECK_LIBRARY_INTEGRITY: "check_library_integrity",
    VERIFY_LIBRARY_CONTENT: "verify_library_content",
    CANCEL_LIBRARY_VERIFICATION: "cancel_library_verification",
    OPEN_PATH_IN_SYSTEM: "open_path_in_system",

    // Creating a media is one command rather than the chain of steps this list used to name
    // (import/download, the two crash-marker ends, the duplicate pre-check, insert). The backend
    // owns that sequence now, so the steps are no longer reachable from here. See
    // src-tauri/src/commands/media.rs for why they were removed rather than left registered.
    CREATE_MEDIA: "create_media",
    STREAM_LIVE_CHAT_FILE: "stream_live_chat_file",
    LIST_LIVE_CHAT_FILES: "list_live_chat_files",
    MIGRATE_LIVE_CHAT_TO_LIBRARY: "migrate_live_chat_to_library",

    GENERATE_TEMP_THUMBNAIL: "generate_temporary_thumbnail",
    STAGE_MANUAL_THUMBNAIL: "stage_manual_thumbnail",
    PERSIST_THUMBNAIL_FILE: "persist_thumbnail_file",
    DOWNLOAD_CHANNEL_AVATAR_FROM_HANDLE: "download_channel_avatar_from_handle",
    RESOLVE_DISPLAY_THUMBNAILS: "resolve_display_thumbnails",
    DELETE_TEMP_THUMBNAIL: "delete_temporary_thumbnail",

    LIST_YT_DLP_FORMATS: "list_yt_dlp_formats",
    CANCEL_MEDIA_DOWNLOAD: "cancel_media_download",
    FETCH_YOUTUBE_COMMENTS: "fetch_youtube_comments",
    REPLACE_MEDIA_COMMENTS: "replace_media_comments",
    MARK_MEDIA_COMMENTS_ABSENT: "mark_media_comments_absent",

    IS_DIRECTORY_EMPTY: "is_directory_empty",

    REGISTER_LIBRARY_ASSET_SCOPE: "register_library_asset_scope",

    ENSURE_DATABASE_READY: "ensure_database_ready",
    GET_DATABASE_BACKUP_STATUS: "get_database_backup_status",
    RESTORE_DATABASE_FROM_BACKUP: "restore_database_from_backup",
    EXPORT_DATABASE: "export_database",
    IMPORT_DATABASE: "import_database",
    GET_DATABASE_IMPORT_UNDO_STATUS: "get_database_import_undo_status",
    UNDO_DATABASE_IMPORT: "undo_database_import",
    CHECK_DATABASE_INTEGRITY: "check_database_integrity",
    GET_APP_SETTINGS: "get_app_settings",
    SET_APP_SETTINGS: "set_app_settings",
    SET_EXTERNAL_BACKUP_DIR: "set_external_backup_dir",

    LIST_CHANNELS: "list_channels",
    FIND_CHANNEL_BY_YOUTUBE_HANDLE: "find_channel_by_youtube_handle",
    GET_CHANNEL_BY_ID: "get_channel_by_id",
    INSERT_CHANNEL: "insert_channel",
    UPDATE_CHANNEL_NAME_AND_HANDLE: "update_channel_name_and_handle",
    REPLACE_CHANNEL_AVATAR: "replace_channel_avatar",
    DELETE_CHANNEL_WITH_ARTIFACTS: "delete_channel_with_artifacts",

    UPDATE_MEDIA_TITLE: "update_media_title",
    LIST_MEDIA_PAGE: "list_media_page",
    LIST_MEDIA_COMMENTS_BY_MEDIA_ID: "list_media_comments_by_media_id",
    DELETE_MEDIA_WITH_ARTIFACTS: "delete_media_with_artifacts",
    MARK_MEDIA_AS_WATCHED: "mark_media_as_watched",
    MARK_MEDIA_AS_UNWATCHED: "mark_media_as_unwatched",
    // Written after the row exists, from the media element that measured it. The probe is a
    // webview capability, so it stays here while the creation itself does not.
    UPDATE_MEDIA_DURATION: "update_media_duration",
    UPDATE_MEDIA_PROGRESS: "update_media_progress",
    GET_MEDIA_REPOSITORY_STATS: "get_media_repository_stats",
    // `list_media_integrity_references` was here until the integrity check stopped needing the
    // renderer to assemble its inputs. It only ever fed CHECK_LIBRARY_INTEGRITY, which reads the
    // same rows from the pool it already holds.
} as const;

export type TauriCommandName =
    typeof TAURI_COMMANDS[keyof typeof TAURI_COMMANDS];
