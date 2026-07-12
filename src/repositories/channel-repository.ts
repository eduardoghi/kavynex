import type { Channel } from "../types/media";
import type { ArtifactCleanupReport } from "../types/generated/ArtifactCleanupReport";
import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";

export async function listChannels(): Promise<Channel[]> {
    return invokeCommand<Channel[]>(TAURI_COMMANDS.LIST_CHANNELS);
}

export async function findChannelByYoutubeHandle(
    youtubeHandle: string
): Promise<Channel | null> {
    return invokeCommand<Channel | null>(TAURI_COMMANDS.FIND_CHANNEL_BY_YOUTUBE_HANDLE, {
        youtubeHandle,
    });
}

export async function getChannelById(channelId: number): Promise<Channel | null> {
    return invokeCommand<Channel | null>(TAURI_COMMANDS.GET_CHANNEL_BY_ID, {
        channelId,
    });
}

export async function insertChannel(
    name: string,
    youtubeHandle: string,
    avatarPath: string | null
): Promise<number> {
    return invokeCommand<number>(TAURI_COMMANDS.INSERT_CHANNEL, {
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
    await invokeVoid(TAURI_COMMANDS.UPDATE_CHANNEL_NAME_AND_HANDLE, {
        channelId,
        name,
        youtubeHandle,
    });
}

export async function replaceChannelAvatar(
    channelId: number,
    avatarPath: string | null
): Promise<ArtifactCleanupReport> {
    return invokeCommand<ArtifactCleanupReport>(TAURI_COMMANDS.REPLACE_CHANNEL_AVATAR, {
        channelId,
        avatarPath,
    });
}

export async function deleteChannelWithArtifacts(
    channelId: number
): Promise<ArtifactCleanupReport> {
    return invokeCommand<ArtifactCleanupReport>(TAURI_COMMANDS.DELETE_CHANNEL_WITH_ARTIFACTS, {
        channelId,
    });
}

