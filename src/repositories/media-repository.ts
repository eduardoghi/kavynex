import type { MediaCommentRow, MediaRow, MediaType } from "../types/media";
import type { MediaIntegrityReference, MediaRepositoryStats } from "../types/diagnostics";
import type { ArtifactCleanupReport } from "../types/generated/ArtifactCleanupReport";
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

export async function findMediaByChannelAndFilePath(
    channelId: number,
    filePath: string
): Promise<MediaRow | null> {
    return invokeCommand(
        TAURI_COMMANDS.FIND_MEDIA_BY_CHANNEL_AND_FILE_PATH,
        { channelId, filePath }
    );
}

export async function mediaExistsForChannelAndYoutubeId(
    channelId: number,
    youtubeVideoId: string
): Promise<boolean> {
    return invokeCommand(TAURI_COMMANDS.MEDIA_EXISTS_FOR_CHANNEL_AND_YOUTUBE_ID, {
        channelId,
        youtubeVideoId,
    });
}

// Named rather than positional, unlike its siblings here, because ten arguments in a row put four
// `string | null`s next to each other: swapping youtubeVideoId and publishedAt at the call site
// type-checks cleanly and only shows up as wrong data in the database. The parameter names are the
// only thing that can catch that, so they have to be at the call site rather than in this file.
export type InsertMediaInput = {
    channelId: number;
    title: string;
    filePath: string;
    thumbnailPath: string | null;
    mediaType: MediaType;
    youtubeVideoId: string | null;
    publishedAt: string | null;
    durationSeconds: number | null;
    isLive: boolean;
    liveChatFilePath: string | null;
};

export async function insertMedia(input: InsertMediaInput): Promise<number> {
    return invokeCommand(TAURI_COMMANDS.INSERT_MEDIA, input);
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

export async function getMediaRepositoryStats(): Promise<MediaRepositoryStats> {
    return invokeCommand(TAURI_COMMANDS.GET_MEDIA_REPOSITORY_STATS);
}

export async function listMediaIntegrityReferences(): Promise<MediaIntegrityReference[]> {
    return invokeCommand(
        TAURI_COMMANDS.LIST_MEDIA_INTEGRITY_REFERENCES
    );
}
