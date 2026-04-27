import {
    countChannelsUsingAvatarPathOutsideChannel,
    countMediaUsingFilePathOutsideChannel,
    countMediaUsingThumbnailOutsideChannel,
    getChannelAvatarPathByChannelId,
    listDistinctFilePathsByChannelId,
    listDistinctThumbnailPathsByChannelId,
} from "../repositories/channel-repository";
import { deleteMediaFile } from "./media-file-service";
import { deleteThumbnailFile } from "./thumbnail-service";
import { logError } from "../utils/app-logger";

export type ChannelArtifactsSnapshot = {
    avatarPath: string | null;
    thumbnailPaths: string[];
    filePaths: string[];
};

function normalizeUniquePaths(paths: string[]): string[] {
    return [...new Set(paths.map((item) => item.trim()).filter(Boolean))];
}

export async function listChannelArtifactsSnapshot(
    channelId: number
): Promise<ChannelArtifactsSnapshot> {
    const [avatarPath, thumbnailPaths, filePaths] = await Promise.all([
        getChannelAvatarPathByChannelId(channelId),
        listDistinctThumbnailPathsByChannelId(channelId),
        listDistinctFilePathsByChannelId(channelId),
    ]);

    return {
        avatarPath: avatarPath?.trim() || null,
        thumbnailPaths: normalizeUniquePaths(thumbnailPaths),
        filePaths: normalizeUniquePaths(filePaths),
    };
}

export async function cleanupUnusedChannelArtifacts(
    channelId: number,
    libraryPath: string,
    snapshot: ChannelArtifactsSnapshot
): Promise<void> {
    const normalizedLibraryPath = libraryPath.trim();

    if (!normalizedLibraryPath) {
        return;
    }

    if (snapshot.avatarPath) {
        try {
            const usageOutsideChannel = await countChannelsUsingAvatarPathOutsideChannel(
                snapshot.avatarPath,
                channelId
            );

            if (usageOutsideChannel === 0) {
                await deleteThumbnailFile(snapshot.avatarPath, normalizedLibraryPath);
            }
        } catch (error) {
            logError("channel-artifacts", "Failed to cleanup avatar while deleting channel.", error, {
                channelId,
                avatarPath: snapshot.avatarPath,
                libraryPath: normalizedLibraryPath,
            });
        }
    }

    for (const thumbnailPath of normalizeUniquePaths(snapshot.thumbnailPaths)) {
        try {
            const usageOutsideChannel = await countMediaUsingThumbnailOutsideChannel(
                thumbnailPath,
                channelId
            );

            if (usageOutsideChannel === 0) {
                await deleteThumbnailFile(thumbnailPath, normalizedLibraryPath);
            }
        } catch (error) {
            logError("channel-artifacts", "Failed to cleanup thumbnail while deleting channel.", error, {
                channelId,
                thumbnailPath,
                libraryPath: normalizedLibraryPath,
            });
        }
    }

    for (const filePath of normalizeUniquePaths(snapshot.filePaths)) {
        try {
            const usageOutsideChannel = await countMediaUsingFilePathOutsideChannel(
                filePath,
                channelId
            );

            if (usageOutsideChannel === 0) {
                await deleteMediaFile(filePath, normalizedLibraryPath);
            }
        } catch (error) {
            logError("channel-artifacts", "Failed to cleanup media while deleting channel.", error, {
                channelId,
                filePath,
                libraryPath: normalizedLibraryPath,
            });
        }
    }
}