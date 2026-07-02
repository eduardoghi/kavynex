import type { Channel } from "../types/media";
import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";
import { ensureSchemaReady } from "../lib/schema-bridge";

export async function listChannels(): Promise<Channel[]> {
    await ensureSchemaReady();
    return invokeCommand<Channel[]>(TAURI_COMMANDS.LIST_CHANNELS);
}

export async function findChannelByYoutubeHandle(
    youtubeHandle: string
): Promise<Channel | null> {
    await ensureSchemaReady();
    return invokeCommand<Channel | null>(TAURI_COMMANDS.FIND_CHANNEL_BY_YOUTUBE_HANDLE, {
        youtubeHandle,
    });
}

export async function getChannelById(channelId: number): Promise<Channel | null> {
    await ensureSchemaReady();
    return invokeCommand<Channel | null>(TAURI_COMMANDS.GET_CHANNEL_BY_ID, {
        channelId,
    });
}

export async function insertChannel(
    name: string,
    youtubeHandle: string,
    avatarPath: string | null
): Promise<number | null> {
    await ensureSchemaReady();
    return invokeCommand<number | null>(TAURI_COMMANDS.INSERT_CHANNEL, {
        name,
        youtubeHandle,
        avatarPath,
    });
}

export async function updateChannelNameAndHandle(
    channelId: number,
    name: string,
    youtubeHandle: string
): Promise<void> {
    await ensureSchemaReady();
    await invokeVoid(TAURI_COMMANDS.UPDATE_CHANNEL_NAME_AND_HANDLE, {
        channelId,
        name,
        youtubeHandle,
    });
}

export async function updateChannelAvatarPath(
    channelId: number,
    avatarPath: string | null
): Promise<void> {
    await ensureSchemaReady();
    await invokeVoid(TAURI_COMMANDS.UPDATE_CHANNEL_AVATAR_PATH, {
        channelId,
        avatarPath,
    });
}

export async function deleteChannelById(channelId: number): Promise<void> {
    await ensureSchemaReady();
    await invokeVoid(TAURI_COMMANDS.DELETE_CHANNEL_BY_ID, {
        channelId,
    });
}

export async function listDistinctThumbnailPathsByChannelId(
    channelId: number
): Promise<string[]> {
    await ensureSchemaReady();
    return invokeCommand<string[]>(
        TAURI_COMMANDS.LIST_DISTINCT_THUMBNAIL_PATHS_BY_CHANNEL_ID,
        { channelId }
    );
}

export async function listDistinctFilePathsByChannelId(
    channelId: number
): Promise<string[]> {
    await ensureSchemaReady();
    return invokeCommand<string[]>(TAURI_COMMANDS.LIST_DISTINCT_FILE_PATHS_BY_CHANNEL_ID, {
        channelId,
    });
}

export async function getChannelAvatarPathByChannelId(
    channelId: number
): Promise<string | null> {
    await ensureSchemaReady();
    return invokeCommand<string | null>(
        TAURI_COMMANDS.GET_CHANNEL_AVATAR_PATH_BY_CHANNEL_ID,
        { channelId }
    );
}

export async function countChannelsUsingAvatarPathOutsideChannel(
    avatarPath: string,
    channelId: number
): Promise<number> {
    await ensureSchemaReady();
    return invokeCommand<number>(
        TAURI_COMMANDS.COUNT_CHANNELS_USING_AVATAR_PATH_OUTSIDE_CHANNEL,
        { avatarPath, channelId }
    );
}

export async function countMediaUsingThumbnailOutsideChannel(
    thumbnailPath: string,
    channelId: number
): Promise<number> {
    await ensureSchemaReady();
    return invokeCommand<number>(
        TAURI_COMMANDS.COUNT_MEDIA_USING_THUMBNAIL_OUTSIDE_CHANNEL,
        { thumbnailPath, channelId }
    );
}

export async function countMediaUsingFilePathOutsideChannel(
    filePath: string,
    channelId: number
): Promise<number> {
    await ensureSchemaReady();
    return invokeCommand<number>(
        TAURI_COMMANDS.COUNT_MEDIA_USING_FILE_PATH_OUTSIDE_CHANNEL,
        { filePath, channelId }
    );
}
