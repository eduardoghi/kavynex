export const TAURI_COMMANDS = {
    CHECK_EXTERNAL_TOOLS: "check_external_tools",

    RESOLVE_DEFAULT_LIBRARY_DIRECTORY: "resolve_default_library_directory",
    ENSURE_DIRECTORY_EXISTS: "ensure_directory_exists",
    RESOLVE_EXISTING_DIRECTORY: "resolve_existing_directory",
    MIGRATE_LIBRARY_DIRECTORY: "migrate_library_directory",
    GET_LIBRARY_SUMMARY: "get_library_summary",
    CHECK_LIBRARY_INTEGRITY: "check_library_integrity",
    OPEN_PATH_IN_SYSTEM: "open_path_in_system",

    IMPORT_MEDIA_FILE: "import_media_file",
    DELETE_MEDIA_FILE: "delete_media_file",

    GENERATE_TEMP_THUMBNAIL: "generate_temporary_thumbnail",
    PERSIST_THUMBNAIL_FILE: "persist_thumbnail_file",
    DOWNLOAD_THUMBNAIL_FROM_URL: "download_thumbnail_from_url",
    DOWNLOAD_CHANNEL_AVATAR_FROM_HANDLE: "download_channel_avatar_from_handle",
    DELETE_TEMP_THUMBNAIL: "delete_temporary_thumbnail",
    DELETE_THUMBNAIL_FILE: "delete_thumbnail_file",

    LIST_YT_DLP_FORMATS: "list_yt_dlp_formats",
    DOWNLOAD_MEDIA_FROM_URL: "download_media_from_url",
    CANCEL_MEDIA_DOWNLOAD: "cancel_media_download",
    FETCH_YOUTUBE_COMMENTS: "fetch_youtube_comments",
    REPLACE_MEDIA_COMMENTS: "replace_media_comments",

    IS_DIRECTORY_EMPTY: "is_directory_empty",

    REGISTER_LIBRARY_ASSET_SCOPE: "register_library_asset_scope",
    ALLOW_ASSET_FILE: "allow_asset_file",
} as const;

export const TAURI_EVENTS = {
    YT_DLP_LOG: "yt-dlp-log",
    YT_DLP_ERROR: "yt-dlp-error",
    YT_DLP_FINISHED: "yt-dlp-finished",
    YT_DLP_CANCELLED: "yt-dlp-cancelled",
    YT_DLP_TERMINAL: "yt-dlp-terminal",
} as const;

export type TauriCommandName =
    typeof TAURI_COMMANDS[keyof typeof TAURI_COMMANDS];

export type TauriEventName =
    typeof TAURI_EVENTS[keyof typeof TAURI_EVENTS];
