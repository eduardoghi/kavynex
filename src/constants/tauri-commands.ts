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

    ENSURE_DATABASE_READY: "ensure_database_ready",
    GET_APP_SETTINGS: "get_app_settings",
    SET_APP_SETTINGS: "set_app_settings",

    LIST_CHANNELS: "list_channels",
    FIND_CHANNEL_BY_YOUTUBE_HANDLE: "find_channel_by_youtube_handle",
    GET_CHANNEL_BY_ID: "get_channel_by_id",
    INSERT_CHANNEL: "insert_channel",
    UPDATE_CHANNEL_NAME_AND_HANDLE: "update_channel_name_and_handle",
    UPDATE_CHANNEL_AVATAR_PATH: "update_channel_avatar_path",
    DELETE_CHANNEL_BY_ID: "delete_channel_by_id",
    LIST_DISTINCT_THUMBNAIL_PATHS_BY_CHANNEL_ID: "list_distinct_thumbnail_paths_by_channel_id",
    LIST_DISTINCT_FILE_PATHS_BY_CHANNEL_ID: "list_distinct_file_paths_by_channel_id",
    GET_CHANNEL_AVATAR_PATH_BY_CHANNEL_ID: "get_channel_avatar_path_by_channel_id",
    COUNT_CHANNELS_USING_AVATAR_PATH_OUTSIDE_CHANNEL:
        "count_channels_using_avatar_path_outside_channel",
    COUNT_MEDIA_USING_THUMBNAIL_OUTSIDE_CHANNEL: "count_media_using_thumbnail_outside_channel",
    COUNT_MEDIA_USING_FILE_PATH_OUTSIDE_CHANNEL: "count_media_using_file_path_outside_channel",

    UPDATE_MEDIA_TITLE: "update_media_title",
    LIST_MEDIA_BY_CHANNEL: "list_media_by_channel",
    FIND_MEDIA_BY_CHANNEL_AND_FILE_PATH: "find_media_by_channel_and_file_path",
    INSERT_MEDIA: "insert_media",
    LIST_MEDIA_COMMENTS_BY_MEDIA_ID: "list_media_comments_by_media_id",
    DELETE_MEDIA_BY_ID: "delete_media_by_id",
    MARK_MEDIA_AS_WATCHED: "mark_media_as_watched",
    MARK_MEDIA_AS_UNWATCHED: "mark_media_as_unwatched",
    UPDATE_MEDIA_PROGRESS: "update_media_progress",
    COUNT_MEDIA_USING_THUMBNAIL_OUTSIDE_MEDIA: "count_media_using_thumbnail_outside_media",
    COUNT_MEDIA_USING_FILE_PATH_OUTSIDE_MEDIA: "count_media_using_file_path_outside_media",
    GET_MEDIA_REPOSITORY_STATS: "get_media_repository_stats",
    LIST_MEDIA_INTEGRITY_REFERENCES: "list_media_integrity_references",
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
