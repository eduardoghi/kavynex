// Runtime validation for the structured results that cross the IPC boundary.
//
// `invokeCommand` (tauri-client.ts) is typed against `TauriCommandReturns`, and the ts-rs bindings
// plus the CI "generated bindings are up to date" check keep those types in lockstep with the Rust
// structs. That is a *compile-time* guarantee: it proves the code was built against the right shape,
// not that a given response actually has it at runtime. These schemas add the runtime half. Each
// structured response is parsed against a zod schema mirroring its type, so a malformed payload
// (a backend bug, a shape surprise on an edge case) fails loudly at the seam with a clear message
// instead of flowing on as an object of the wrong shape and surfacing as a confusing failure deep
// in a component.
//
// The registry below is typed `z.ZodType<TauriCommandReturns[K]>` per command, so a schema that
// stops matching its command's declared return type (a dropped field, a wrong nullability, a wrong
// element type) fails to compile here. That ties every schema to the generated types the same way
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
    ContentVerificationEvent,
    ContentVerificationReport,
    LiveChatStreamEvent,
    MediaCommentRow,
    YtDlpComment,
    YtDlpFailedEvent,
    YtDlpFinishedEvent,
    YtDlpFormatsResult,
    YtDlpLogEvent,
    YtDlpTerminalEvent,
} from "../types/media";
import type {
    ExternalToolsStatus,
    LibraryIntegrityCheck,
    MediaRepositoryStats,
} from "../types/diagnostics";
import type { ArtifactCleanupReport } from "../types/generated/ArtifactCleanupReport";
import type { CreatedMedia } from "../types/generated/CreatedMedia";
import type { DatabaseBackupStatus } from "../types/generated/DatabaseBackupStatus";
import type { DisplayThumbnail } from "../types/generated/DisplayThumbnail";
import type { DatabaseIntegrityReport } from "../types/generated/DatabaseIntegrityReport";
import type { LibrarySummaryInfo } from "../types/generated/LibrarySummaryInfo";
import type { MigrateLibraryDirectoryResult } from "../types/generated/MigrateLibraryDirectoryResult";
import type { MediaPage } from "../types/generated/MediaPage";
import type { StoredAppSettingsPayload } from "../types/generated/StoredAppSettingsPayload";
import type { WebviewCheckPlan } from "../types/generated/WebviewCheckPlan";

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
    comments_state: z.enum(["unknown", "none", "available"]),
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

const migrateLibraryDirectoryResultSchema = z.object({
    final_library_path: z.string(),
    changed: z.boolean(),
    old_directory_retained: z.boolean(),
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

// The jump-to-the-media target the integrity check resolves for each path its report named. Keyed
// by that path, so the map holds at most the handful of examples the report caps itself at, not
// one entry per media, which is what the renderer used to build for itself.
const diagnosticsMediaTargetSchema = z.object({
    channelId: z.number(),
    mediaId: z.number(),
});

const libraryIntegrityCheckSchema = z.object({
    report: libraryIntegrityReportSchema,
    mediaTargets: z.record(z.string(), diagnosticsMediaTargetSchema),
});

const artifactCleanupReportSchema = z.object({
    deleted_paths: z.array(z.string()),
    skipped_shared_paths: z.array(z.string()),
    failed_paths: z.array(z.string()),
});

const databaseBackupStatusSchema = z.object({
    available: z.boolean(),
    backedUpAtMs: z.number().nullable(),
    totalBytes: z.number(),
    formattedTotalSize: z.string(),
});

const databaseIntegrityReportSchema = z.object({
    ok: z.boolean(),
    problems: z.array(z.string()),
    truncated: z.boolean(),
});

// A discriminated union rather than a nullable string: the caller re-asks about every path it has
// not settled, so "no derivative" has to say whether asking again could change the answer. Discarding
// that here would put the distinction back at the seam where the backend cannot be consulted.
const displayThumbnailSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("resolved"), path: z.string() }),
    z.object({ kind: z.literal("budgetSpent") }),
    z.object({ kind: z.literal("unavailable") }),
]);

const webviewCheckPlanSchema = z.object({
    assetPath: z.string(),
});

const createdMediaSchema = z.object({
    id: z.number(),
    filePath: z.string(),
    thumbnailPath: z.string().nullable(),
    mediaType: mediaTypeSchema,
    youtubeVideoId: z.string().nullable(),
    liveChatFilePath: z.string().nullable(),
    isLive: z.boolean(),
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
    // Nullable because a normal launch answers null; only a `--webview-check` run gets a plan.
    begin_webview_check: webviewCheckPlanSchema.nullable() satisfies z.ZodType<WebviewCheckPlan | null>,
    get_library_summary: librarySummaryInfoSchema satisfies z.ZodType<LibrarySummaryInfo>,
    check_library_integrity: libraryIntegrityCheckSchema satisfies z.ZodType<LibraryIntegrityCheck>,
    migrate_library_directory:
        migrateLibraryDirectoryResultSchema satisfies z.ZodType<MigrateLibraryDirectoryResult>,
    list_live_chat_files: z.array(z.string()),
    // The registered media. Worth validating rather than trusting even though it comes straight
    // back from a command this app wrote: the caller feeds `filePath`/`mediaType` to the duration
    // probe and `youtubeVideoId` to the comment backup, so a wrong shape here would surface two
    // steps later as a probe against nothing or a comment fetch for the wrong video.
    create_media: createdMediaSchema satisfies z.ZodType<CreatedMedia>,
    // Positional: entry i answers requested path i, so a shorter or reordered array would silently
    // map a derivative onto the wrong media. The array shape is what this pins; the caller zips it
    // back against the paths it sent.
    resolve_display_thumbnails: z.array(
        displayThumbnailSchema
    ) satisfies z.ZodType<DisplayThumbnail[]>,
    list_yt_dlp_formats: ytDlpFormatsResultSchema satisfies z.ZodType<YtDlpFormatsResult>,
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
    list_media_comments_by_media_id:
        z.array(mediaCommentRowSchema) satisfies z.ZodType<MediaCommentRow[]>,
    delete_media_with_artifacts: artifactCleanupReportSchema satisfies z.ZodType<ArtifactCleanupReport>,
    get_media_repository_stats: mediaRepositoryStatsSchema satisfies z.ZodType<MediaRepositoryStats>,
};

// Schemas for the payloads the backend pushes over `listen`/`Channel` (yt-dlp progress, the live
// chat stream). These cross the same IPC boundary as command results but travel as fire-and-forget
// events, so `invokeCommand`'s validation never sees them: without these, a backend bug that
// changed an event's shape (a `run_id` becoming a number, a batch line that is not a string) would
// flow into a handler as the wrong shape rather than being caught at the seam. Typed
// `z.ZodType<TheEvent>` like the command schemas, so a schema that drifts from its generated type is
// a compile error here.

const ytDlpLogEventSchema = z.object({
    run_id: z.string(),
    line: z.string(),
    stream: z.enum(["stdout", "stderr", "system"]),
    level: z.enum(["info", "warn", "error"]),
}) satisfies z.ZodType<YtDlpLogEvent>;

const ytDlpFinishedEventSchema = z.object({
    run_id: z.string(),
    file_path: z.string(),
    suggested_title: z.string(),
}) satisfies z.ZodType<YtDlpFinishedEvent>;

const ytDlpFailedEventSchema = z.object({
    run_id: z.string(),
    message: z.string(),
}) satisfies z.ZodType<YtDlpFailedEvent>;

const ytDlpTerminalEventSchema = z.object({
    run_id: z.string(),
    status: z.enum(["finished", "failed", "cancelled"]),
    message: z.string().nullable(),
    file_path: z.string().nullable(),
    suggested_title: z.string().nullable(),
}) satisfies z.ZodType<YtDlpTerminalEvent>;

// Payload of the database-integrity-failed event. This is a frontend-owned contract (the backend
// emits a plain serde struct, not a ts-rs-exported type), so there is no generated type to tie it
// to with `satisfies`; the shape is trivial and validated here all the same.
const databaseIntegrityFailedEventSchema = z.object({
    problems: z.array(z.string()),
});

export type DatabaseIntegrityFailedEvent = z.infer<typeof databaseIntegrityFailedEventSchema>;

// Payload of the pending-media-abandoned event: how many crashed media creations the startup sweep
// gave up on. Frontend-owned like the one above, and deliberately just a count. The paths are
// library-relative names a banner cannot act on, and Diagnostics is what names them.
const pendingMediaAbandonedEventSchema = z.object({
    abandoned: z.number(),
});

export type PendingMediaAbandonedEvent = z.infer<typeof pendingMediaAbandonedEventSchema>;

export const IPC_EVENT_SCHEMAS = {
    ytDlpLog: ytDlpLogEventSchema,
    ytDlpFinished: ytDlpFinishedEventSchema,
    // The error and cancelled events carry the same payload shape as a failed event.
    ytDlpFailed: ytDlpFailedEventSchema,
    ytDlpTerminal: ytDlpTerminalEventSchema,
    databaseIntegrityFailed: databaseIntegrityFailedEventSchema,
    pendingMediaAbandoned: pendingMediaAbandonedEventSchema,
} as const;

// The streamed live chat protocol on the `Channel`: a run of `batch` events carrying raw JSON
// lines, ended by a single `done`. The `satisfies` check ties this schema to the generated
// LiveChatStreamEvent binding, so a change to the Rust enum (commands/live_chat.rs) fails to
// compile here instead of silently desyncing the wire shape.
export const liveChatStreamEventSchema = z.union([
    z.object({ kind: z.literal("batch"), lines: z.array(z.string()) }),
    z.object({ kind: z.literal("done") }),
]) satisfies z.ZodType<LiveChatStreamEvent>;

export type { LiveChatStreamEvent };

// The deep library verification's channel: a run of `progress` messages, ended by a single `done`
// carrying the report. Tied to the generated ContentVerificationEvent binding by the `satisfies`
// below, for the same reason as the live chat one above.
const contentVerificationReportSchema = z.object({
    checked: z.number(),
    verified: z.number(),
    corrupt: z.number(),
    corruptExamples: z.array(z.string()),
    unverifiable: z.number(),
    unverifiableExamples: z.array(z.string()),
    unreadable: z.number(),
    unreadableExamples: z.array(z.string()),
    cancelled: z.boolean(),
}) satisfies z.ZodType<ContentVerificationReport>;

export const contentVerificationEventSchema = z.union([
    z.object({ kind: z.literal("progress"), checked: z.number(), total: z.number() }),
    z.object({ kind: z.literal("done"), report: contentVerificationReportSchema }),
]) satisfies z.ZodType<ContentVerificationEvent>;

export type { ContentVerificationEvent, ContentVerificationReport };

// Validates an event/channel payload against `schema`. Returns the parsed value on success, or
// `null` on a mismatch after logging the specific fields that failed. Unlike `validateIpcResult`
// this never throws: an event is fire-and-forget with no caller to reject to, so a malformed
// payload is dropped (and logged for a bug report) rather than propagated into a handler.
export function parseEventPayload<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    source: string,
    payload: unknown
): z.infer<TSchema> | null {
    const parsed = schema.safeParse(payload);

    if (parsed.success) {
        return parsed.data;
    }

    console.error(`Invalid IPC event payload for "${source}": ${describeIssues(parsed.error)}`);
    return null;
}

// Compact, path-annotated summary of what did not match, for the log line below. Kept off zod's
// prettifier so the message shape stays stable across zod point releases.
//
// Exported for its tests rather than for a caller, and that is the point. Both functions above hand
// their result to `console.error` and nothing else, so nothing an assertion can reach observes what
// this produces. A mutation pass over this file reported every one of its parts surviving (the
// `(root)` fallback, the `.` path join, the `: ` between path and message, the `; ` between issues)
// while the polarity decisions around it were killed. That asymmetry is the argument for pinning it
// rather than accepting it: this string is the whole of what a malformed payload leaves behind. The
// user sees a generic message by design, so a bug report is the log line, and a log line that says
// "the backend sent something wrong" without saying *which field* costs the one detail the report
// was worth making. Same reasoning, and the same shape, as the argv redaction gated on the Rust side.
export function describeIssues(error: z.ZodError): string {
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
