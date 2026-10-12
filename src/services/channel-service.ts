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
import {
    CHANNEL_ALREADY_EXISTS_ERROR_CODE,
    CHANNEL_NOT_FOUND_ERROR_CODE,
} from "../constants/error-codes";
import { logError } from "../utils/app-logger";

export async function listAllChannels(): Promise<Channel[]> {
    return listChannels();
}

/**
 * Refuses a channel that createChannel would refuse: an invalid name or handle, or a handle that is
 * already registered.
 *
 * Separate so a caller can ask before doing the expensive part. Creating a channel with an avatar
 * writes or downloads that avatar first, and a refusal after that left the file in the library with
 * nothing pointing at it.
 */
export async function ensureChannelCanBeCreated(
    name: string,
    youtubeHandle: string
): Promise<void> {
    const normalizedInput = validateCreateChannelInput({
        name,
        youtubeHandle,
        avatarPath: null,
    });

    await rejectRegisteredHandle(normalizedInput.youtubeHandle);
}

async function rejectRegisteredHandle(youtubeHandle: string): Promise<void> {
    const existing = await findChannelByYoutubeHandle(youtubeHandle);

    if (existing) {
        throw createAppError(
            CHANNEL_ALREADY_EXISTS_ERROR_CODE,
            "A channel with this YouTube handle already exists."
        );
    }
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

    await rejectRegisteredHandle(normalizedInput.youtubeHandle);

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
    validateChannelId(channelId);
    const normalizedInput = validateCreateChannelInput({
        name,
        youtubeHandle,
        avatarPath: null,
    });

    const existingChannel = await getChannelById(channelId);

    // Deleted meanwhile (another window, a restore). Returning quietly closed the edit form as if the
    // change had been saved.
    if (!existingChannel) {
        throw createAppError(CHANNEL_NOT_FOUND_ERROR_CODE, "This channel no longer exists.");
    }

    // A handle the channel already holds is never a conflict, even when a database from before the
    // case-insensitive rule holds another channel with the same handle in another case.
    const keepsItsHandle = existingChannel.youtube_handle === normalizedInput.youtubeHandle;
    const existingWithHandle = keepsItsHandle
        ? null
        : await findChannelByYoutubeHandle(normalizedInput.youtubeHandle);

    if (existingWithHandle && existingWithHandle.id !== channelId) {
        throw createAppError(
            CHANNEL_ALREADY_EXISTS_ERROR_CODE,
            "A channel with this YouTube handle already exists."
        );
    }

    await updateChannelNameAndHandle(
        channelId,
        normalizedInput.name,
        normalizedInput.youtubeHandle
    );
}

// Resolves with how many files of the previous avatar stayed behind, like the channel deletion, so
// the caller can say so rather than only the log.
export async function updateChannelAvatarWithCleanup(
    channelId: number,
    avatarPath: string | null
): Promise<number> {
    validateChannelId(channelId);
    const nextAvatarPath = avatarPath?.trim() || null;

    // The backend updates the avatar and, in the same transaction, decides whether the
    // previous avatar file became unreferenced (across both video thumbnails and other
    // channel avatars) before removing it. Doing the row write and the reference decision
    // atomically closes the check-then-act race the old two-call sequence had; the old file
    // removal is best-effort, so files it could not delete are reported back as orphans.
    const report = await replaceChannelAvatar(channelId, nextAvatarPath);

    if (report.failed_paths.length > 0) {
        logError(
            "channel-service",
            "Channel avatar was updated but the previous avatar file could not be deleted; it may be orphaned in the library.",
            null,
            { channelId: channelId, failedPaths: report.failed_paths }
        );
    }

    return report.failed_paths.length;
}

// The backend deletes the channel row (media and comments cascade) and its
// now-unreferenced files atomically; files it could not remove are reported back so an
// orphaned file left in the library stays visible. Resolves with how many of them stayed behind.
export async function deleteChannelWithThumbnailCleanup(channelId: number): Promise<number> {
    validateChannelId(channelId);

    const report = await deleteChannelWithArtifacts(channelId);

    if (report.failed_paths.length > 0) {
        logError(
            "channel-service",
            "Channel was removed but some of its files could not be deleted; they may be orphaned in the library.",
            null,
            { channelId: channelId, failedPaths: report.failed_paths }
        );
    }

    return report.failed_paths.length;
}