import type { Channel } from "../types/media";
import {
    deleteChannelWithArtifacts,
    findChannelByYoutubeHandle,
    getChannelById,
    insertChannel,
    listChannels,
    replaceChannelAvatar,
    updateChannelNameAndHandle,
} from "../repositories/channel-repository";
import {
    validateChannelId,
    validateCreateChannelInput,
} from "./channel-input-service";
import { createAppError } from "../utils/app-error";
import { CHANNEL_ALREADY_EXISTS_ERROR_CODE } from "../constants/error-codes";
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
    avatarPath: string | null
): Promise<void> {
    const normalizedInput = validateChannelId(channelId);
    const nextAvatarPath = avatarPath?.trim() || null;

    // The backend updates the avatar and, in the same transaction, decides whether the
    // previous avatar file became unreferenced (across both video thumbnails and other
    // channel avatars) before removing it. Doing the row write and the reference decision
    // atomically closes the check-then-act race the old two-call sequence had; the old file
    // removal is best-effort, so files it could not delete are reported back as orphans.
    const report = await replaceChannelAvatar(normalizedInput.channelId, nextAvatarPath);

    if (report.failed_paths.length > 0) {
        logError(
            "channel-service",
            "Channel avatar was updated but the previous avatar file could not be deleted; it may be orphaned in the library.",
            null,
            { channelId: normalizedInput.channelId, failedPaths: report.failed_paths }
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