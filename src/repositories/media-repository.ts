import type { MediaCommentRow } from "../types/media";
import type { MediaRepositoryStats } from "../types/diagnostics";
import type { ArtifactCleanupReport } from "../types/generated/ArtifactCleanupReport";
import type { CreateMediaRequest } from "../types/generated/CreateMediaRequest";
import type { CreatedMedia } from "../types/generated/CreatedMedia";
import type { MediaPage } from "../types/generated/MediaPage";
import type { MediaPageQuery } from "../types/generated/MediaPageQuery";
import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";

export async function updateMediaTitle(mediaId: number, title: string): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.UPDATE_MEDIA_TITLE, { mediaId, title });
}

export async function listMediaPage(
    channelId: number,
    query: MediaPageQuery
): Promise<MediaPage> {
    return invokeCommand(TAURI_COMMANDS.LIST_MEDIA_PAGE, { channelId, query });
}

// Creates a media end to end. One call rather than the chain this file used to expose (duplicate
// pre-check, download or import, crash marker, duplicate check, insert, clear marker), because the
// backend owns that sequence now - see src-tauri/src/services/media_creation.rs.
//
// The request is passed as one named object for the reason the old `insertMedia` input was: it
// carries four `string | null` fields in a row, and a positional list would let two of them be
// swapped at the call site with the mistake showing up only as wrong data in the database.
export async function createMedia(request: CreateMediaRequest): Promise<CreatedMedia> {
    return invokeCommand(TAURI_COMMANDS.CREATE_MEDIA, { request });
}

export async function listMediaCommentsByMediaId(mediaId: number): Promise<MediaCommentRow[]> {
    return invokeCommand(TAURI_COMMANDS.LIST_MEDIA_COMMENTS_BY_MEDIA_ID, {
        mediaId,
    });
}

export async function deleteMediaWithArtifacts(mediaId: number): Promise<ArtifactCleanupReport> {
    return invokeCommand(TAURI_COMMANDS.DELETE_MEDIA_WITH_ARTIFACTS, {
        mediaId,
    });
}

export async function markMediaAsWatched(mediaId: number): Promise<string> {
    return invokeCommand(TAURI_COMMANDS.MARK_MEDIA_AS_WATCHED, { mediaId });
}

export async function markMediaAsUnwatched(mediaId: number): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.MARK_MEDIA_AS_UNWATCHED, { mediaId });
}

export async function updateMediaProgress(
    mediaId: number,
    progressSeconds: number
): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.UPDATE_MEDIA_PROGRESS, { mediaId, progressSeconds });
}

export async function cleanupUnreferencedMediaArtifacts(
    filePath: string | null,
    thumbnailPath: string | null,
    liveChatFilePath: string | null
): Promise<ArtifactCleanupReport> {
    return invokeCommand(
        TAURI_COMMANDS.CLEANUP_UNREFERENCED_MEDIA_ARTIFACTS,
        { filePath, thumbnailPath, liveChatFilePath }
    );
}

// Records the duration measured for an already-created media. Separate from `createMedia` because
// the measurement is: the probe decodes the file through a media element, which only the webview
// can do, so it runs here once the row exists rather than inside the creation.
export async function updateMediaDuration(
    mediaId: number,
    durationSeconds: number | null
): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.UPDATE_MEDIA_DURATION, { mediaId, durationSeconds });
}

export async function getMediaRepositoryStats(): Promise<MediaRepositoryStats> {
    return invokeCommand(TAURI_COMMANDS.GET_MEDIA_REPOSITORY_STATS);
}

// `listMediaIntegrityReferences` lived here until the integrity check stopped needing the renderer
// to assemble its inputs. Its only caller built three arrays of every stored path out of the rows
// and sent them straight back to the backend, which reads them from the pool itself now.
