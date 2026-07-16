export const TAURI_COMMANDS = {
    CHECK_EXTERNAL_TOOLS: "check_external_tools",
    LOG_FRONTEND_ERROR: "log_frontend_error",

    RESOLVE_DEFAULT_LIBRARY_DIRECTORY: "resolve_default_library_directory",
    ENSURE_DIRECTORY_EXISTS: "ensure_directory_exists",
    RESOLVE_EXISTING_DIRECTORY: "resolve_existing_directory",
    MIGRATE_LIBRARY_DIRECTORY: "migrate_library_directory",
    GET_LIBRARY_SUMMARY: "get_library_summary",
    CHECK_LIBRARY_INTEGRITY: "check_library_integrity",
    OPEN_PATH_IN_SYSTEM: "open_path_in_system",

    IMPORT_MEDIA_FILE: "import_media_file",
    READ_LIVE_CHAT_FILE: "read_live_chat_file",
    DELETE_LIVE_CHAT_FILE: "delete_live_chat_file",
    LIST_LIVE_CHAT_FILES: "list_live_chat_files",
    MIGRATE_LIVE_CHAT_TO_LIBRARY: "migrate_live_chat_to_library",
    CLEANUP_UNREFERENCED_MEDIA_ARTIFACTS: "cleanup_unreferenced_media_artifacts",

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
    GET_DATABASE_BACKUP_STATUS: "get_database_backup_status",
    RESTORE_DATABASE_FROM_BACKUP: "restore_database_from_backup",
    EXPORT_DATABASE: "export_database",
    IMPORT_DATABASE: "import_database",
    GET_DATABASE_IMPORT_UNDO_STATUS: "get_database_import_undo_status",
    UNDO_DATABASE_IMPORT: "undo_database_import",
    CHECK_DATABASE_INTEGRITY: "check_database_integrity",
    GET_APP_SETTINGS: "get_app_settings",
    SET_APP_SETTINGS: "set_app_settings",

    LIST_CHANNELS: "list_channels",
    FIND_CHANNEL_BY_YOUTUBE_HANDLE: "find_channel_by_youtube_handle",
    GET_CHANNEL_BY_ID: "get_channel_by_id",
    INSERT_CHANNEL: "insert_channel",
    UPDATE_CHANNEL_NAME_AND_HANDLE: "update_channel_name_and_handle",
    REPLACE_CHANNEL_AVATAR: "replace_channel_avatar",
    DELETE_CHANNEL_WITH_ARTIFACTS: "delete_channel_with_artifacts",

    UPDATE_MEDIA_TITLE: "update_media_title",
    LIST_MEDIA_PAGE: "list_media_page",
    FIND_MEDIA_BY_CHANNEL_AND_FILE_PATH: "find_media_by_channel_and_file_path",
    MEDIA_EXISTS_FOR_CHANNEL_AND_YOUTUBE_ID: "media_exists_for_channel_and_youtube_id",
    INSERT_MEDIA: "insert_media",
    LIST_MEDIA_COMMENTS_BY_MEDIA_ID: "list_media_comments_by_media_id",
    DELETE_MEDIA_WITH_ARTIFACTS: "delete_media_with_artifacts",
    MARK_MEDIA_AS_WATCHED: "mark_media_as_watched",
    MARK_MEDIA_AS_UNWATCHED: "mark_media_as_unwatched",
    UPDATE_MEDIA_PROGRESS: "update_media_progress",
    GET_MEDIA_REPOSITORY_STATS: "get_media_repository_stats",
    LIST_MEDIA_INTEGRITY_REFERENCES: "list_media_integrity_references",
} as const;

export type TauriCommandName =
    typeof TAURI_COMMANDS[keyof typeof TAURI_COMMANDS];
