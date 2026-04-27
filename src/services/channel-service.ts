import type { Channel } from "../types/media";
import {
    countChannelsUsingAvatarPathOutsideChannel,
    deleteChannelById,
    findChannelByYoutubeHandle,
    getChannelById,
    insertChannel,
    listChannels,
    updateChannelAvatarPath,
    updateChannelNameAndHandle,
} from "../repositories/channel-repository";
import {
    cleanupUnusedChannelArtifacts,
    listChannelArtifactsSnapshot,
} from "./channel-artifacts-service";
import {
    requireLibraryPath,
    validateChannelId,
    validateCreateChannelInput,
} from "./channel-input-service";
import { createAppError } from "../utils/app-error";
import { CHANNEL_ALREADY_EXISTS_ERROR_CODE } from "../constants/error-codes";
import { deleteThumbnailFile } from "./thumbnail-service";

export async function listAllChannels(): Promise<Channel[]> {
    return listChannels();
}

export async function createChannel(
    name: string,
    youtubeHandle: string,
    avatarPath: string | null = null
): Promise<number | null> {
    const normalizedInput = validateCreateChannelInput({
        name,
        youtubeHandle,
        avatarPath,
    });

    const existing = await findChannelByYoutubeHandle(normalizedInput.youtubeHandle);

    if (existing) {
        throw createAppError(
            CHANNEL_ALREADY_EXISTS_ERROR_CODE,
            "A channel with this YouTube handle already exists."
        );
    }

    return insertChannel(
        normalizedInput.name,
        normalizedInput.youtubeHandle,
        normalizedInput.avatarPath
    );
}

export async function updateChannelNameHandle(
    channelId: number,
    name: string,
    youtubeHandle: string
): Promise<void> {
    const normalizedChannel = validateChannelId(channelId);
    const normalizedInput = validateCreateChannelInput({
        name,
        youtubeHandle,
        avatarPath: null,
    });

    const existingChannel = await getChannelById(normalizedChannel.channelId);

    if (!existingChannel) {
        return;
    }

    const existingWithHandle = await findChannelByYoutubeHandle(normalizedInput.youtubeHandle);

    if (existingWithHandle && existingWithHandle.id !== normalizedChannel.channelId) {
        throw createAppError(
            CHANNEL_ALREADY_EXISTS_ERROR_CODE,
            "A channel with this YouTube handle already exists."
        );
    }

    await updateChannelNameAndHandle(
        normalizedChannel.channelId,
        normalizedInput.name,
        normalizedInput.youtubeHandle
    );
}

export async function updateChannelAvatarWithCleanup(
    channelId: number,
    avatarPath: string | null,
    libraryPath: string
): Promise<void> {
    const normalizedInput = validateChannelId(channelId);
    const existingChannel = await getChannelById(normalizedInput.channelId);

    if (!existingChannel) {
        return;
    }

    const previousAvatarPath = existingChannel.avatar_path?.trim() || null;
    const nextAvatarPath = avatarPath?.trim() || null;

    if (previousAvatarPath === nextAvatarPath) {
        return;
    }

    if (previousAvatarPath) {
        requireLibraryPath(
            libraryPath,
            "Library folder must be configured to replace or remove a saved channel avatar."
        );
    }

    await updateChannelAvatarPath(normalizedInput.channelId, nextAvatarPath);

    if (!previousAvatarPath) {
        return;
    }

    const normalizedLibraryPath = libraryPath.trim();

    const usageOutsideChannel = await countChannelsUsingAvatarPathOutsideChannel(
        previousAvatarPath,
        normalizedInput.channelId
    );

    if (usageOutsideChannel === 0) {
        await deleteThumbnailFile(previousAvatarPath, normalizedLibraryPath);
    }
}

export async function deleteChannelWithThumbnailCleanup(
    channelId: number,
    libraryPath: string
): Promise<void> {
    const normalizedInput = validateChannelId(channelId);
    const existingChannel = await getChannelById(normalizedInput.channelId);

    if (!existingChannel) {
        return;
    }

    const snapshot = await listChannelArtifactsSnapshot(normalizedInput.channelId);

    const hasPhysicalArtifacts =
        !!snapshot.avatarPath ||
        snapshot.thumbnailPaths.length > 0 ||
        snapshot.filePaths.length > 0;

    const normalizedLibraryPath = hasPhysicalArtifacts
        ? requireLibraryPath(
              libraryPath,
              "Library folder must be configured to delete a channel with saved media or thumbnails."
          )
        : libraryPath.trim();

    await deleteChannelById(normalizedInput.channelId);

    await cleanupUnusedChannelArtifacts(
        normalizedInput.channelId,
        normalizedLibraryPath,
        snapshot
    );
}