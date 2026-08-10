// The typed contract between a Tauri command name and what invoking it resolves to. `invokeCommand`
// indexes this map by the command it is given, so a caller can no longer pick an arbitrary result
// type unrelated to the command (the one type-safety hole at the IPC seam): the return type follows
// from the command name itself. When a Rust command's return type changes, update its entry here and
// every call site is re-checked against it - the same drift protection the generated ts-rs bindings
// give the payload types, extended to the command results.
//
// Every value type below mirrors what the corresponding Rust command returns (see
// src-tauri/src/commands). A command that returns `AppResult<()>` maps to `void`.
import type { TauriCommandName } from "../constants/tauri-commands";
import type {
    Channel,
    MediaCommentRow,
    YtDlpComment,
    YtDlpFormatsResult,
} from "../types/media";
import type { CreatedMedia } from "../types/generated/CreatedMedia";
import type {
    ExternalToolsStatus,
    LibraryIntegrityReport,
    MediaIntegrityReference,
    MediaRepositoryStats,
} from "../types/diagnostics";
import type { ArtifactCleanupReport } from "../types/generated/ArtifactCleanupReport";
import type { DisplayThumbnail } from "../types/generated/DisplayThumbnail";
import type { DatabaseBackupStatus } from "../types/generated/DatabaseBackupStatus";
import type { DatabaseIntegrityReport } from "../types/generated/DatabaseIntegrityReport";
import type { LibrarySummaryInfo } from "../types/generated/LibrarySummaryInfo";
import type { MigrateLibraryDirectoryResult } from "../types/generated/MigrateLibraryDirectoryResult";
import type { MediaPage } from "../types/generated/MediaPage";
import type { StoredAppSettingsPayload } from "../types/generated/StoredAppSettingsPayload";
import type { WebviewCheckPlan } from "../types/generated/WebviewCheckPlan";

export type TauriCommandReturns = {
    check_external_tools: ExternalToolsStatus;
    log_frontend_error: void;
    open_log_directory: void;

    // null on every launch that is not a `--webview-check` run, which is what lets the frontend ask
    // unconditionally at boot. `report_webview_check` never resolves during a check: the backend
    // terminates the process with the outcome instead of answering.
    begin_webview_check: WebviewCheckPlan | null;
    report_webview_check: void;

    resolve_default_library_directory: string;
    ensure_directory_exists: string;
    resolve_existing_directory: string;
    migrate_library_directory: MigrateLibraryDirectoryResult;
    get_library_summary: LibrarySummaryInfo;
    check_library_integrity: LibraryIntegrityReport;
    open_path_in_system: void;

    // The whole creation, not a step of it: the backend produces the artifacts, records the crash
    // marker, inserts the row and clears the marker, and answers with the registered media.
    create_media: CreatedMedia;
    stream_live_chat_file: void;
    delete_live_chat_file: void;
    list_live_chat_files: string[];
    migrate_live_chat_to_library: void;
    cleanup_unreferenced_media_artifacts: ArtifactCleanupReport;

    generate_temporary_thumbnail: string;
    // The path of the staged copy in the preview directory, not the path the user picked.
    stage_manual_thumbnail: string;
    persist_thumbnail_file: string;
    download_channel_avatar_from_handle: string;
    // One entry per requested path, in order. Not a nullable string: "no derivative" carries
    // whether asking again could change the answer, which is what stops the caller re-asking
    // forever about a path that can never be resolved. See the DisplayThumbnail doc comment.
    resolve_display_thumbnails: DisplayThumbnail[];
    delete_temporary_thumbnail: void;
    delete_thumbnail_file: void;

    list_yt_dlp_formats: YtDlpFormatsResult;
    cancel_media_download: void;
    fetch_youtube_comments: YtDlpComment[];
    replace_media_comments: number;

    is_directory_empty: boolean;

    register_library_asset_scope: void;

    ensure_database_ready: void;
    get_database_backup_status: DatabaseBackupStatus;
    restore_database_from_backup: void;
    export_database: void;
    import_database: void;
    get_database_import_undo_status: boolean;
    undo_database_import: void;
    check_database_integrity: DatabaseIntegrityReport;
    get_app_settings: StoredAppSettingsPayload;
    set_app_settings: void;
    set_external_backup_dir: void;

    list_channels: Channel[];
    find_channel_by_youtube_handle: Channel | null;
    get_channel_by_id: Channel | null;
    insert_channel: number;
    update_channel_name_and_handle: void;
    replace_channel_avatar: ArtifactCleanupReport;
    delete_channel_with_artifacts: ArtifactCleanupReport;

    update_media_title: void;
    list_media_page: MediaPage;
    list_media_comments_by_media_id: MediaCommentRow[];
    delete_media_with_artifacts: ArtifactCleanupReport;
    mark_media_as_watched: string;
    mark_media_as_unwatched: void;
    update_media_duration: void;
    update_media_progress: void;
    get_media_repository_stats: MediaRepositoryStats;
    list_media_integrity_references: MediaIntegrityReference[];
};

// Compile-time proof the map stays in lockstep with the command list: its type is `true` only when
// every command in TAURI_COMMANDS has an entry above and no entry names something that is not a
// command. If either drifts, the type becomes `false`, the `= true` assignment fails to compile, and
// the build points here instead of failing at some unrelated call site. Exported so `noUnusedLocals`
// does not report it; the value itself is never read.
export const COMMAND_MAP_IS_EXHAUSTIVE: Exclude<
    TauriCommandName,
    keyof TauriCommandReturns
> extends never
    ? Exclude<keyof TauriCommandReturns, TauriCommandName> extends never
        ? true
        : false
    : false = true;
