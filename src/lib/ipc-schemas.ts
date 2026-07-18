// Runtime validation for the structured results that cross the IPC boundary.
//
// `invokeCommand` (tauri-client.ts) is typed against `TauriCommandReturns`, and the ts-rs bindings
// plus the CI "generated bindings are up to date" check keep those types in lockstep with the Rust
// structs. That is a *compile-time* guarantee: it proves the code was built against the right shape,
// not that a given response actually has it at runtime. These schemas add the runtime half - each
// structured response is parsed against a zod schema mirroring its type, so a malformed payload
// (a backend bug, a shape surprise on an edge case) fails loudly at the seam with a clear message
// instead of flowing on as an object of the wrong shape and surfacing as a confusing failure deep
// in a component.
//
// The registry below is typed `z.ZodType<TauriCommandReturns[K]>` per command, so a schema that
// stops matching its command's declared return type - a dropped field, a wrong nullability, a wrong
// element type - fails to compile here. That ties every schema to the generated types the same way
// the command map ties every result type to its command, so the runtime schemas cannot silently
// drift from the shapes they validate.
//
// Only structured results (objects, and arrays of them) are registered; a command that returns a
// bare string/number/boolean or `void` is not, since there is no shape for a wrong value to hide
// inside. Objects are parsed non-strictly (zod's default strips unknown keys), so a backend that
// adds a new field ships before the schema learns about it rather than breaking every call.

import { z } from "zod";

import { APP_ERROR_CODE } from "../constants/error-codes";
import type { TauriCommandName } from "../constants/tauri-commands";
import type { TauriCommandReturns } from "./tauri-command-returns";
import type { AppErrorShape } from "../utils/app-error";

import type {
    Channel,
    DownloadedMediaResult,
    MediaCommentRow,
    MediaRow,
    YtDlpComment,
    YtDlpFormatsResult,
} from "../types/media";
import type {
    ExternalToolsStatus,
    LibraryIntegrityReport,
    MediaIntegrityReference,
    MediaRepositoryStats,
} from "../types/diagnostics";
import type { ArtifactCleanupReport } from "../types/generated/ArtifactCleanupReport";
import type { DatabaseBackupStatus } from "../types/generated/DatabaseBackupStatus";
import type { DatabaseIntegrityReport } from "../types/generated/DatabaseIntegrityReport";
import type { LibrarySummaryInfo } from "../types/generated/LibrarySummaryInfo";
import type { MediaPage } from "../types/generated/MediaPage";
import type { StoredAppSettingsPayload } from "../types/generated/StoredAppSettingsPayload";

const mediaTypeSchema = z.enum(["video", "audio"]);

const channelSchema = z.object({
    id: z.number(),
    name: z.string(),
    youtube_handle: z.string(),
    avatar_path: z.string().nullable(),
    created_at: z.string(),
});

const mediaRowSchema = z.object({
    id: z.number(),
    channel_id: z.number(),
    title: z.string(),
    file_path: z.string(),
    thumbnail_path: z.string().nullable(),
    media_type: mediaTypeSchema,
    youtube_video_id: z.string().nullable(),
    watched_at: z.string().nullable(),
    published_at: z.string().nullable(),
    duration_seconds: z.number().nullable(),
    // Stored as 0/1 integers on the Rust side (SQLite has no boolean), so the wire type is number.
    progress_seconds: z.number(),
    has_comments: z.number(),
    comments_count: z.number(),
    is_live: z.number(),
    has_live_chat: z.number(),
    live_chat_file_path: z.string().nullable(),
    created_at: z.string(),
});

const mediaCommentRowSchema = z.object({
    id: z.number(),
    video_id: z.number(),
    comment_id: z.string().nullable(),
    parent_comment_id: z.string().nullable(),
    author_name: z.string(),
    author_handle: z.string().nullable(),
    author_channel_id: z.string().nullable(),
    author_thumbnail: z.string().nullable(),
    text: z.string(),
    like_count: z.number(),
    reply_count: z.number(),
    is_author_uploader: z.number(),
    is_favorited: z.number(),
    is_pinned: z.number(),
    is_edited: z.number(),
    time_text: z.string().nullable(),
    published_at: z.string().nullable(),
    created_at: z.string(),
});

const downloadedMediaResultSchema = z.object({
    file_path: z.string(),
    suggested_title: z.string(),
    youtube_video_id: z.string().nullable(),
    published_at: z.string().nullable(),
    media_type: mediaTypeSchema,
    thumbnail_url: z.string().nullable(),
    thumbnail_path: z.string().nullable(),
    is_live: z.boolean(),
    live_chat_file_path: z.string().nullable(),
});

const ytDlpCommentSchema = z.object({
    comment_id: z.string().nullable(),
    parent_comment_id: z.string().nullable(),
    author_name: z.string(),
    author_handle: z.string().nullable(),
    author_channel_id: z.string().nullable(),
    author_thumbnail: z.string().nullable(),
    text: z.string(),
    like_count: z.number(),
    reply_count: z.number(),
    is_author_uploader: z.boolean(),
    is_favorited: z.boolean(),
    is_pinned: z.boolean(),
    is_edited: z.boolean(),
    time_text: z.string().nullable(),
    published_at: z.string().nullable(),
});

const ytDlpFormatSchema = z.object({
    format_id: z.string(),
    ext: z.string(),
    media_type: mediaTypeSchema,
    has_video: z.boolean(),
    has_audio: z.boolean(),
    filesize_bytes: z.number().nullable(),
    height: z.number().nullable(),
    abr: z.number().nullable(),
    tbr: z.number().nullable(),
    vcodec: z.string().nullable(),
    protocol: z.string().nullable(),
});

const ytDlpFormatsResultSchema = z.object({
    suggested_title: z.string(),
    youtube_video_id: z.string().nullable(),
    formats: z.array(ytDlpFormatSchema),
    terminal_logs: z.array(z.string()),
});

const externalToolStatusSchema = z.object({
    path: z.string(),
    version: z.string(),
    healthy: z.boolean(),
    release_age_days: z.number().nullable(),
});

const externalToolsStatusSchema = z.object({
    yt_dlp: externalToolStatusSchema,
    ffmpeg: externalToolStatusSchema,
});

const librarySummaryInfoSchema = z.object({
    total_bytes: z.number(),
    formatted_size: z.string(),
    video_files: z.number(),
    audio_files: z.number(),
    thumbnail_files: z.number(),
});

const libraryIntegrityReportSchema = z.object({
    checked_media_files: z.number(),
    missing_media_files: z.number(),
    missing_media_examples: z.array(z.string()),
    corrupt_media_files: z.number(),
    corrupt_media_examples: z.array(z.string()),
    checked_thumbnail_files: z.number(),
    missing_thumbnail_files: z.number(),
    missing_thumbnail_examples: z.array(z.string()),
    corrupt_thumbnail_files: z.number(),
    corrupt_thumbnail_examples: z.array(z.string()),
    orphan_media_files: z.number(),
    orphan_media_examples: z.array(z.string()),
    orphan_thumbnail_files: z.number(),
    orphan_thumbnail_examples: z.array(z.string()),
    invalid_media_files: z.number(),
    invalid_media_examples: z.array(z.string()),
    invalid_thumbnail_files: z.number(),
    invalid_thumbnail_examples: z.array(z.string()),
    checked_live_chat_files: z.number(),
    missing_live_chat_files: z.number(),
    missing_live_chat_examples: z.array(z.string()),
    corrupt_live_chat_files: z.number(),
    corrupt_live_chat_examples: z.array(z.string()),
    orphan_live_chat_files: z.number(),
    orphan_live_chat_examples: z.array(z.string()),
    invalid_live_chat_files: z.number(),
    invalid_live_chat_examples: z.array(z.string()),
});

const mediaPageSchema = z.object({
    items: z.array(mediaRowSchema),
    total: z.number(),
});

const mediaRepositoryStatsSchema = z.object({
    total_media: z.number(),
    total_video_media: z.number(),
    total_audio_media: z.number(),
    total_with_thumbnail: z.number(),
    total_without_thumbnail: z.number(),
    total_watched: z.number(),
    total_unwatched: z.number(),
    total_live_media: z.number(),
    total_with_live_chat: z.number(),
    total_without_live_chat: z.number(),
    total_media_with_live_chat_flag_but_no_path: z.number(),
    total_media_with_live_chat_path_but_not_live: z.number(),
});

const mediaIntegrityReferenceSchema = z.object({
    id: z.number(),
    channel_id: z.number(),
    title: z.string(),
    file_path: z.string(),
    thumbnail_path: z.string().nullable(),
    live_chat_file_path: z.string().nullable(),
});

const artifactCleanupReportSchema = z.object({
    deleted_paths: z.array(z.string()),
    skipped_shared_paths: z.array(z.string()),
    failed_paths: z.array(z.string()),
});

const databaseBackupStatusSchema = z.object({
    available: z.boolean(),
    backedUpAtMs: z.number().nullable(),
});

const databaseIntegrityReportSchema = z.object({
    ok: z.boolean(),
    problems: z.array(z.string()),
    truncated: z.boolean(),
});

const storedAppSettingsPayloadSchema = z.object({
    importMode: z.string().nullable(),
    libraryPath: z.string().nullable(),
    loadRemoteImages: z.string().nullable(),
    checkUpdatesOnStartup: z.string().nullable(),
    externalBackupDir: z.string().nullable(),
});

// A schema per command whose result is structured. Typing each entry as
// `z.ZodType<TauriCommandReturns[K]>` is what makes a schema that drifts from its command's declared
// return type a compile error here, rather than a runtime rejection of a valid response. Commands
// absent from this map (void, or a bare string/number/boolean) are returned unvalidated.
type IpcResultSchemas = {
    [K in keyof TauriCommandReturns]?: z.ZodType<TauriCommandReturns[K]>;
};

const IPC_RESULT_SCHEMAS: IpcResultSchemas = {
    check_external_tools: externalToolsStatusSchema satisfies z.ZodType<ExternalToolsStatus>,
    get_library_summary: librarySummaryInfoSchema satisfies z.ZodType<LibrarySummaryInfo>,
    check_library_integrity: libraryIntegrityReportSchema satisfies z.ZodType<LibraryIntegrityReport>,
    list_live_chat_files: z.array(z.string()),
    cleanup_unreferenced_media_artifacts:
        artifactCleanupReportSchema satisfies z.ZodType<ArtifactCleanupReport>,
    list_yt_dlp_formats: ytDlpFormatsResultSchema satisfies z.ZodType<YtDlpFormatsResult>,
    download_media_from_url: downloadedMediaResultSchema satisfies z.ZodType<DownloadedMediaResult>,
    fetch_youtube_comments: z.array(ytDlpCommentSchema) satisfies z.ZodType<YtDlpComment[]>,
    get_database_backup_status: databaseBackupStatusSchema satisfies z.ZodType<DatabaseBackupStatus>,
    check_database_integrity:
        databaseIntegrityReportSchema satisfies z.ZodType<DatabaseIntegrityReport>,
    get_app_settings: storedAppSettingsPayloadSchema satisfies z.ZodType<StoredAppSettingsPayload>,
    list_channels: z.array(channelSchema) satisfies z.ZodType<Channel[]>,
    find_channel_by_youtube_handle: channelSchema.nullable() satisfies z.ZodType<Channel | null>,
    get_channel_by_id: channelSchema.nullable() satisfies z.ZodType<Channel | null>,
    replace_channel_avatar: artifactCleanupReportSchema satisfies z.ZodType<ArtifactCleanupReport>,
    delete_channel_with_artifacts:
        artifactCleanupReportSchema satisfies z.ZodType<ArtifactCleanupReport>,
    list_media_page: mediaPageSchema satisfies z.ZodType<MediaPage>,
    find_media_by_channel_and_file_path: mediaRowSchema.nullable() satisfies z.ZodType<MediaRow | null>,
    list_media_comments_by_media_id:
        z.array(mediaCommentRowSchema) satisfies z.ZodType<MediaCommentRow[]>,
    delete_media_with_artifacts: artifactCleanupReportSchema satisfies z.ZodType<ArtifactCleanupReport>,
    get_media_repository_stats: mediaRepositoryStatsSchema satisfies z.ZodType<MediaRepositoryStats>,
    list_media_integrity_references:
        z.array(mediaIntegrityReferenceSchema) satisfies z.ZodType<MediaIntegrityReference[]>,
};

// Compact, path-annotated summary of what did not match, for the log line below. Kept off zod's
// prettifier so the message shape stays stable across zod point releases.
function describeIssues(error: z.ZodError): string {
    return error.issues
        .map((issue) => {
            const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
            return `${path}: ${issue.message}`;
        })
        .join("; ");
}

// Validates a command's result against its registered schema, if any. Returns the parsed value
// (unknown keys stripped) on success. On a mismatch it logs the specific fields that failed and
// throws a generic AppErrorShape: a malformed backend response is an internal contract violation,
// not something the user can act on, so it degrades to the generic friendly message (APP_ERROR)
// rather than surfacing zod's technical detail, while the detail stays in the console for a bug
// report. A command with no schema returns its result untouched.
export function validateIpcResult<K extends TauriCommandName>(
    command: K,
    result: TauriCommandReturns[K]
): TauriCommandReturns[K] {
    const schema = IPC_RESULT_SCHEMAS[command];

    if (!schema) {
        return result;
    }

    const parsed = schema.safeParse(result);

    if (parsed.success) {
        return parsed.data as TauriCommandReturns[K];
    }

    console.error(
        `Invalid IPC response for "${command}": ${describeIssues(parsed.error)}`
    );

    const shape: AppErrorShape = {
        code: APP_ERROR_CODE,
        message: `The app received an unexpected response from the backend (${command}).`,
        details: null,
    };

    throw shape;
}
