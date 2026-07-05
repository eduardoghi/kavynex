import type { Channel } from "../types/media";
import {
    countChannelsUsingAvatarPathOutsideChannel,
    deleteChannelWithArtifacts,
    findChannelByYoutubeHandle,
    getChannelById,
    insertChannel,
    listChannels,
    updateChannelAvatarPath,
    updateChannelNameAndHandle,
} from "../repositories/channel-repository";
import {
    requireLibraryPath,
    validateChannelId,
    validateCreateChannelInput,
} from "./channel-input-service";
import { createAppError } from "../utils/app-error";
import { CHANNEL_ALREADY_EXISTS_ERROR_CODE } from "../constants/error-codes";
import { deleteThumbnailFile } from "./thumbnail-service";
import { logError } from "../utils/app-logger";

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

    // The avatar change is already persisted at this point; failing to remove the old
    // file must not surface as a failed update, only leave a logged orphan.
    try {
        const usageOutsideChannel = await countChannelsUsingAvatarPathOutsideChannel(
            previousAvatarPath,
            normalizedInput.channelId
        );

        if (usageOutsideChannel === 0) {
            await deleteThumbnailFile(previousAvatarPath, normalizedLibraryPath);
        }
    } catch (error) {
        logError(
            "channel-service",
            "Channel avatar was updated but the previous avatar file could not be deleted; it may be orphaned in the library.",
            error,
            { channelId: normalizedInput.channelId, previousAvatarPath }
        );
    }
}

// The backend deletes the channel row (media and comments cascade) and its
// now-unreferenced files atomically; files it could not remove are reported back so an
// orphaned file left in the library stays visible.
export async function deleteChannelWithThumbnailCleanup(channelId: number): Promise<void> {
    const normalizedInput = validateChannelId(channelId);

    const report = await deleteChannelWithArtifacts(normalizedInput.channelId);

    if (report.failed_paths.length > 0) {
        logError(
            "channel-service",
            "Channel was removed but some of its files could not be deleted; they may be orphaned in the library.",
            null,
            { channelId: normalizedInput.channelId, failedPaths: report.failed_paths }
        );
    }
}