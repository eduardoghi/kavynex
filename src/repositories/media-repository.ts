import type { MediaCommentRow, MediaRow, MediaType } from "../types/media";
import type { MediaIntegrityReference, MediaRepositoryStats } from "../types/diagnostics";
import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";
import { ensureSchemaReady } from "../lib/schema-bridge";

export async function updateMediaTitle(mediaId: number, title: string): Promise<void> {
    await ensureSchemaReady();
    await invokeVoid(TAURI_COMMANDS.UPDATE_MEDIA_TITLE, { mediaId, title });
}

export async function listMediaByChannel(channelId: number): Promise<MediaRow[]> {
    await ensureSchemaReady();
    return invokeCommand<MediaRow[]>(TAURI_COMMANDS.LIST_MEDIA_BY_CHANNEL, { channelId });
}

export async function findMediaByChannelAndFilePath(
    channelId: number,
    filePath: string
): Promise<MediaRow | null> {
    await ensureSchemaReady();
    return invokeCommand<MediaRow | null>(
        TAURI_COMMANDS.FIND_MEDIA_BY_CHANNEL_AND_FILE_PATH,
        { channelId, filePath }
    );
}

export async function insertMedia(
    channelId: number,
    title: string,
    filePath: string,
    thumbnailPath: string | null,
    mediaType: MediaType,
    youtubeVideoId: string | null,
    publishedAt: string | null,
    durationSeconds: number | null,
    isLive: boolean,
    liveChatFilePath: string | null
): Promise<number | null> {
    await ensureSchemaReady();
    return invokeCommand<number | null>(TAURI_COMMANDS.INSERT_MEDIA, {
        channelId,
        title,
        filePath,
        thumbnailPath,
        mediaType,
        youtubeVideoId,
        publishedAt,
        durationSeconds,
        isLive,
        liveChatFilePath,
    });
}

export async function listMediaCommentsByMediaId(mediaId: number): Promise<MediaCommentRow[]> {
    await ensureSchemaReady();
    return invokeCommand<MediaCommentRow[]>(TAURI_COMMANDS.LIST_MEDIA_COMMENTS_BY_MEDIA_ID, {
        mediaId,
    });
}

export async function deleteMediaById(mediaId: number): Promise<void> {
    await ensureSchemaReady();
    await invokeVoid(TAURI_COMMANDS.DELETE_MEDIA_BY_ID, { mediaId });
}

export async function markMediaAsWatched(mediaId: number): Promise<void> {
    await ensureSchemaReady();
    await invokeVoid(TAURI_COMMANDS.MARK_MEDIA_AS_WATCHED, { mediaId });
}

export async function markMediaAsUnwatched(mediaId: number): Promise<void> {
    await ensureSchemaReady();
    await invokeVoid(TAURI_COMMANDS.MARK_MEDIA_AS_UNWATCHED, { mediaId });
}

export async function updateMediaProgress(
    mediaId: number,
    progressSeconds: number
): Promise<void> {
    await ensureSchemaReady();
    await invokeVoid(TAURI_COMMANDS.UPDATE_MEDIA_PROGRESS, { mediaId, progressSeconds });
}

export async function countMediaUsingThumbnailOutsideMedia(
    thumbnailPath: string,
    mediaId: number
): Promise<number> {
    await ensureSchemaReady();
    return invokeCommand<number>(TAURI_COMMANDS.COUNT_MEDIA_USING_THUMBNAIL_OUTSIDE_MEDIA, {
        thumbnailPath,
        mediaId,
    });
}

export async function countMediaUsingFilePathOutsideMedia(
    filePath: string,
    mediaId: number
): Promise<number> {
    await ensureSchemaReady();
    return invokeCommand<number>(TAURI_COMMANDS.COUNT_MEDIA_USING_FILE_PATH_OUTSIDE_MEDIA, {
        filePath,
        mediaId,
    });
}

export async function getMediaRepositoryStats(): Promise<MediaRepositoryStats> {
    await ensureSchemaReady();
    return invokeCommand<MediaRepositoryStats>(TAURI_COMMANDS.GET_MEDIA_REPOSITORY_STATS);
}

export async function listMediaIntegrityReferences(): Promise<MediaIntegrityReference[]> {
    await ensureSchemaReady();
    return invokeCommand<MediaIntegrityReference[]>(
        TAURI_COMMANDS.LIST_MEDIA_INTEGRITY_REFERENCES
    );
}
