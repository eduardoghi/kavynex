import type { ImportMode } from "../types/settings";
import type { MediaType } from "../types/media";
import { cleanupUnreferencedMediaArtifacts } from "../repositories";
import { downloadMediaFromUrl } from "./media-download-service";
import { importMediaFile } from "./media-file-service";
import {
    deleteTemporaryThumbnail,
    downloadThumbnailFromUrl,
    generateTemporaryThumbnail,
    persistThumbnailFile,
} from "./thumbnail-service";
import { logError } from "../utils/app-logger";

export type PreparedMediaArtifacts = {
    filePath: string;
    thumbnailPath: string | null;
    youtubeVideoId: string | null;
    publishedAt: string | null;
    mediaType: MediaType;
    isLive?: boolean;
    liveChatFilePath?: string | null;
};

type PrepareYtDlpArtifactsInput = {
    sourceValue: string;
    thumbnailSourcePath: string | null;
    libraryPath: string;
    ytDlpRunId: string;
    ytDlpFormatId: string;
    cookiesBrowser: string | null;
    downloadLiveChat?: boolean;
};

type PrepareLocalArtifactsInput = {
    sourceValue: string;
    thumbnailSourcePath: string | null;
    mediaType: MediaType;
    importMode: ImportMode;
    libraryPath: string;
    publishedAt: string | null;
};

function isRemoteUrl(value: string | null): boolean {
    const normalized = value?.trim() ?? "";
    return /^https?:\/\//i.test(normalized);
}

function isAbsoluteFilePath(value: string | null): boolean {
    const normalized = value?.trim() ?? "";

    if (!normalized) {
        return false;
    }

    return /^[a-zA-Z]:[\\/]/.test(normalized) || normalized.startsWith("/");
}

function isManagedRelativeThumbnailPath(value: string | null): boolean {
    const normalized = value?.trim() ?? "";

    if (!normalized) {
        return false;
    }

    if (isRemoteUrl(normalized) || isAbsoluteFilePath(normalized)) {
        return false;
    }

    return normalized.startsWith("thumbnails/");
}

async function resolveThumbnailFromYtDlpImport(
    thumbnailSourcePath: string | null,
    thumbnailUrl: string | null,
    libraryPath: string
): Promise<string | null> {
    if (thumbnailSourcePath) {
        if (isManagedRelativeThumbnailPath(thumbnailSourcePath)) {
            return thumbnailSourcePath.trim();
        }

        if (isRemoteUrl(thumbnailSourcePath)) {
            return downloadThumbnailFromUrl(thumbnailSourcePath, libraryPath);
        }

        return persistThumbnailFile(thumbnailSourcePath, libraryPath);
    }

    if (thumbnailUrl) {
        return downloadThumbnailFromUrl(thumbnailUrl, libraryPath);
    }

    return null;
}

async function generateAndPersistTemporaryThumbnail(
    sourceValue: string,
    libraryPath: string
): Promise<string | null> {
    const temporaryThumbPath = await generateTemporaryThumbnail(sourceValue);

    try {
        return await persistThumbnailFile(temporaryThumbPath, libraryPath);
    } finally {
        try {
            await deleteTemporaryThumbnail(temporaryThumbPath);
        } catch (error) {
            logError(
                "media-artifacts",
                "Failed to cleanup temporary thumbnail after persistence.",
                error,
                {
                    temporaryThumbPath,
                }
            );
        }
    }
}

async function resolveThumbnailFromLocalImport(
    sourceValue: string,
    thumbnailSourcePath: string | null,
    mediaType: MediaType,
    libraryPath: string
): Promise<string | null> {
    if (thumbnailSourcePath) {
        if (isManagedRelativeThumbnailPath(thumbnailSourcePath)) {
            return thumbnailSourcePath.trim();
        }

        if (isRemoteUrl(thumbnailSourcePath)) {
            return downloadThumbnailFromUrl(thumbnailSourcePath, libraryPath);
        }

        return persistThumbnailFile(thumbnailSourcePath, libraryPath);
    }

    if (mediaType === "audio") {
        try {
            return await generateAndPersistTemporaryThumbnail(sourceValue, libraryPath);
        } catch (error) {
            logError(
                "media-artifacts",
                "Audio file does not have an embedded thumbnail or thumbnail extraction failed. Import will continue without thumbnail.",
                error,
                {
                    sourceValue,
                    libraryPath,
                }
            );

            return null;
        }
    }

    return generateAndPersistTemporaryThumbnail(sourceValue, libraryPath);
}

export async function prepareYtDlpArtifacts({
    sourceValue,
    thumbnailSourcePath,
    libraryPath,
    ytDlpRunId,
    ytDlpFormatId,
    cookiesBrowser,
    downloadLiveChat = false,
}: PrepareYtDlpArtifactsInput): Promise<PreparedMediaArtifacts> {
    const shouldSkipAutoThumbnailDownload = Boolean(thumbnailSourcePath?.trim());

    const downloaded = await downloadMediaFromUrl(
        sourceValue,
        libraryPath,
        ytDlpRunId,
        ytDlpFormatId,
        cookiesBrowser,
        null,
        downloadLiveChat,
        shouldSkipAutoThumbnailDownload
    );

    const managedThumbnailPath =
        "thumbnail_path" in downloaded && typeof downloaded.thumbnail_path === "string"
            ? downloaded.thumbnail_path.trim() || null
            : null;

    const thumbnailUrl =
        "thumbnail_url" in downloaded && typeof downloaded.thumbnail_url === "string"
            ? downloaded.thumbnail_url.trim() || null
            : null;

    // Every branch below assigns thumbnailPath before it is read, so no initializer.
    let thumbnailPath: string | null;

    if (thumbnailSourcePath) {
        thumbnailPath = await resolveThumbnailFromYtDlpImport(
            thumbnailSourcePath,
            null,
            libraryPath
        );

        if (managedThumbnailPath && managedThumbnailPath !== thumbnailPath) {
            // The auto-downloaded thumbnail was overridden by a manual one. Remove it only
            // when no registered row references it - it can be content-shared with an
            // existing media (the same video already added elsewhere) - reference-counted
            // atomically in the backend rather than deleted unconditionally.
            try {
                await cleanupUnreferencedMediaArtifacts(null, managedThumbnailPath, null);
            } catch (error) {
                logError(
                    "media-artifacts",
                    "Failed to cleanup yt-dlp managed thumbnail after overriding with manual thumbnail.",
                    error,
                    {
                        managedThumbnailPath,
                        libraryPath,
                    }
                );
            }
        }
    } else if (managedThumbnailPath) {
        thumbnailPath = managedThumbnailPath;
    } else {
        thumbnailPath = await resolveThumbnailFromYtDlpImport(null, thumbnailUrl, libraryPath);
    }

    return {
        filePath: downloaded.file_path,
        thumbnailPath,
        youtubeVideoId: downloaded.youtube_video_id,
        publishedAt: downloaded.published_at,
        mediaType: downloaded.media_type,
        isLive: Boolean(downloaded.is_live),
        liveChatFilePath: downloaded.live_chat_file_path ?? null,
    };
}

export async function prepareLocalArtifacts({
    sourceValue,
    thumbnailSourcePath,
    mediaType,
    importMode,
    libraryPath,
    publishedAt,
}: PrepareLocalArtifactsInput): Promise<PreparedMediaArtifacts> {
    let thumbnailPath: string | null = null;
    let filePath: string | null = null;

    try {
        thumbnailPath = await resolveThumbnailFromLocalImport(
            sourceValue,
            thumbnailSourcePath,
            mediaType,
            libraryPath
        );

        filePath = await importMediaFile(sourceValue, importMode, libraryPath);

        return {
            filePath,
            thumbnailPath,
            youtubeVideoId: null,
            publishedAt,
            mediaType,
            isLive: false,
            liveChatFilePath: null,
        };
    } catch (error) {
        // Reference-counted cleanup in the backend: an artifact shared with an existing row
        // (a content-addressed media file that duplicates an already-imported one, or a
        // reused managed thumbnail) is kept, never the frontend deleting it unconditionally.
        await cleanupCreatedArtifacts(filePath, thumbnailPath, null);

        throw error;
    }
}

/**
 * Removes the on-disk artifacts (media file, thumbnail, live chat replay) prepared during a
 * media creation that failed before the DB row was inserted.
 *
 * Media files, thumbnails and live chat replays are content-addressed and can be shared with
 * an already-registered row (re-adding an existing video, or the same video added to several
 * channels), so deleting unconditionally would destroy a file another row depends on. The
 * backend reference-counts each path and unlinks only the ones nothing else references, doing
 * the count and the delete in one call so no other operation can interleave between them. The
 * library directory is re-derived backend-side from the persisted settings.
 */
export async function cleanupCreatedArtifacts(
    filePath: string | null,
    thumbnailPath: string | null,
    liveChatFilePath: string | null
): Promise<void> {
    if (!filePath && !thumbnailPath && !liveChatFilePath) {
        return;
    }

    try {
        const report = await cleanupUnreferencedMediaArtifacts(
            filePath,
            thumbnailPath,
            liveChatFilePath
        );

        if (report.failed_paths.length > 0) {
            logError(
                "media-artifacts",
                "Some artifacts prepared for a failed media creation could not be removed; they may be orphaned in the library.",
                null,
                { failedPaths: report.failed_paths }
            );
        }
    } catch (error) {
        logError(
            "media-artifacts",
            "Failed to clean up artifacts after a media creation failure.",
            error,
            { filePath, thumbnailPath, liveChatFilePath }
        );
    }
}