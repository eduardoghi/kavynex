import type { MediaCommentRow, MediaRow, YtDlpComment } from "../types/media";
import {
    countMediaUsingFilePathOutsideMedia,
    countMediaUsingLiveChatOutsideMedia,
    countMediaUsingThumbnailOutsideMedia,
    deleteMediaById,
    findMediaByChannelAndFilePath,
    insertMedia,
    listMediaByChannel,
    listMediaCommentsByMediaId,
    markMediaAsUnwatched,
    markMediaAsWatched,
    updateMediaProgress,
    updateMediaTitle as updateMediaTitleInRepository,
} from "../repositories";
import { deleteMediaFile } from "./media-file-service";
import { readMediaDurationInSeconds } from "./media-metadata-service";
import { deleteThumbnailFile } from "./thumbnail-service";
import { deleteLiveChatFileFromAppData } from "./live-chat-service";
import {
    cleanupCreatedArtifacts,
    prepareLocalArtifacts,
    prepareYtDlpArtifacts,
    type PreparedMediaArtifacts,
} from "./media-artifacts-service";
import {
    type CreateMediaInput,
    normalizeDeleteMediaInput,
    validateChannelId,
    validateCreateMediaInput,
    validateMediaId,
} from "./media-input-service";
import { createAppError } from "../utils/app-error";
import { fetchYouTubeComments } from "./media-download-service";
import { replaceMediaCommentsInBackend } from "./media-comments-service";
import { logError } from "../utils/app-logger";

type CreateMediaResult = {
    id: number | null;
};

type CreateMediaOptions = {
    onProgress?: (message: string) => void | Promise<void>;
};

type RefreshMediaCommentsResult = {
    updated: boolean;
    totalComments: number;
};

type PreparedMediaArtifactsExtended = PreparedMediaArtifacts & {
    isLive?: boolean;
    liveChatFilePath?: string | null;
};

async function emitProgress(
    onProgress: CreateMediaOptions["onProgress"],
    message: string
): Promise<void> {
    if (!onProgress) {
        return;
    }

    await onProgress(message);
}

export async function updateMediaTitle(mediaId: number, title: string): Promise<void> {
    validateMediaId(mediaId);

    const normalizedTitle = title.trim();

    if (!normalizedTitle) {
        throw createAppError(
            "INVALID_MEDIA_TITLE",
            "The media title cannot be empty."
        );
    }

    await updateMediaTitleInRepository(mediaId, normalizedTitle);
}

function normalizeFetchedComments(comments: unknown): YtDlpComment[] {
    if (!Array.isArray(comments)) {
        return [];
    }

    return comments.map((comment) => {
        const item = (comment ?? {}) as Record<string, unknown>;

        return {
            comment_id:
                typeof item.comment_id === "string" && item.comment_id.trim()
                    ? item.comment_id.trim()
                    : null,
            parent_comment_id:
                typeof item.parent_comment_id === "string" && item.parent_comment_id.trim()
                    ? item.parent_comment_id.trim()
                    : null,
            author_name:
                typeof item.author_name === "string" && item.author_name.trim()
                    ? item.author_name.trim()
                    : "Unknown author",
            author_handle:
                typeof item.author_handle === "string" && item.author_handle.trim()
                    ? item.author_handle.trim()
                    : null,
            author_channel_id:
                typeof item.author_channel_id === "string" && item.author_channel_id.trim()
                    ? item.author_channel_id.trim()
                    : null,
            author_thumbnail:
                typeof item.author_thumbnail === "string" && item.author_thumbnail.trim()
                    ? item.author_thumbnail.trim()
                    : null,
            text:
                typeof item.text === "string"
                    ? item.text
                    : "",
            like_count:
                typeof item.like_count === "number" && Number.isFinite(item.like_count)
                    ? Math.max(0, Math.floor(item.like_count))
                    : 0,
            reply_count:
                typeof item.reply_count === "number" && Number.isFinite(item.reply_count)
                    ? Math.max(0, Math.floor(item.reply_count))
                    : 0,
            is_author_uploader: Boolean(item.is_author_uploader),
            is_favorited: Boolean(item.is_favorited),
            is_pinned: Boolean(item.is_pinned),
            is_edited: Boolean(item.is_edited),
            time_text:
                typeof item.time_text === "string" && item.time_text.trim()
                    ? item.time_text.trim()
                    : null,
            published_at:
                typeof item.published_at === "string" && item.published_at.trim()
                    ? item.published_at.trim()
                    : null,
        };
    });
}

async function prepareMediaArtifacts(
    input: CreateMediaInput
): Promise<PreparedMediaArtifactsExtended> {
    if (input.sourceMode === "yt-dlp") {
        return (await prepareYtDlpArtifacts({
            sourceValue: input.sourceValue,
            thumbnailSourcePath: input.thumbnailSourcePath,
            libraryPath: input.libraryPath,
            ytDlpRunId: input.ytDlpRunId,
            ytDlpFormatId: input.ytDlpFormatId,
            cookiesBrowser: input.cookiesBrowser,
            downloadLiveChat: input.downloadLiveChat,
        })) as PreparedMediaArtifactsExtended;
    }

    return (await prepareLocalArtifacts({
        sourceValue: input.sourceValue,
        thumbnailSourcePath: input.thumbnailSourcePath,
        mediaType: input.mediaType,
        importMode: input.importMode,
        libraryPath: input.libraryPath,
        publishedAt: input.publishedAt,
    })) as PreparedMediaArtifactsExtended;
}

async function ensureMediaDoesNotAlreadyExist(
    channelId: number,
    filePath: string
): Promise<void> {
    const existing = await findMediaByChannelAndFilePath(channelId, filePath);

    if (existing) {
        throw createAppError(
            "VIDEO_ALREADY_EXISTS_FOR_CHANNEL",
            "This media is already registered for the selected channel."
        );
    }
}

// Sentinel media id used when cleaning up artifacts that were prepared but never
// registered as a media row (createMedia failed before insertMedia). No real media row
// has this id, so the "outside media" reference counts return the number of *other* rows
// that rely on the artifact.
const UNREGISTERED_MEDIA_ID = -1;

async function removeMediaFileIfUnused(
    mediaId: number,
    filePath: string,
    libraryPath: string
): Promise<void> {
    const usageOutsideMedia = await countMediaUsingFilePathOutsideMedia(filePath, mediaId);

    if (usageOutsideMedia === 0) {
        await deleteMediaFile(filePath, libraryPath);
    }
}

async function removeMediaThumbnailIfUnused(
    mediaId: number,
    thumbnailPath: string | null,
    libraryPath: string
): Promise<void> {
    if (!thumbnailPath) {
        return;
    }

    const usageOutsideMedia = await countMediaUsingThumbnailOutsideMedia(thumbnailPath, mediaId);

    if (usageOutsideMedia === 0) {
        await deleteThumbnailFile(thumbnailPath, libraryPath);
    }
}

async function removeMediaLiveChatIfUnused(
    mediaId: number,
    liveChatFilePath: string | null
): Promise<void> {
    const normalizedLiveChatFilePath = liveChatFilePath?.trim() ?? "";

    if (!normalizedLiveChatFilePath) {
        return;
    }

    // Live chat replays are stored per YouTube video id, so the same file can back more
    // than one media row (e.g. the same video added to several channels). Only delete it
    // when no other media row still references it.
    const usageOutsideMedia = await countMediaUsingLiveChatOutsideMedia(
        normalizedLiveChatFilePath,
        mediaId
    );

    if (usageOutsideMedia === 0) {
        await deleteLiveChatFileFromAppData(normalizedLiveChatFilePath);
    }
}

// Removes the on-disk artifacts of a media row that was already deleted. File cleanup is
// best-effort (a failure must not undo the DB deletion), but failures are logged with the
// affected path so an orphaned file left in the library is visible for diagnostics.
async function cleanupMediaArtifactsWithLogging(
    mediaId: number,
    filePath: string,
    thumbnailPath: string | null,
    liveChatFilePath: string | null,
    libraryPath: string
): Promise<void> {
    const results = await Promise.allSettled([
        removeMediaFileIfUnused(mediaId, filePath, libraryPath),
        removeMediaThumbnailIfUnused(mediaId, thumbnailPath, libraryPath),
        removeMediaLiveChatIfUnused(mediaId, liveChatFilePath),
    ]);

    const targets: { label: string; path: string | null }[] = [
        { label: "media file", path: filePath },
        { label: "thumbnail", path: thumbnailPath },
        { label: "live chat file", path: liveChatFilePath },
    ];

    results.forEach((result, index) => {
        if (result.status === "rejected") {
            const target = targets[index];

            logError(
                "media-service",
                `Media row was removed but its ${target.label} could not be deleted; a file may be orphaned in the library.`,
                result.reason,
                { mediaId, path: target.path }
            );
        }
    });
}

async function tryPersistYouTubeComments(
    mediaId: number | null,
    youtubeVideoId: string | null,
    cookiesBrowser: string | null,
    onProgress?: (message: string) => void | Promise<void>
): Promise<void> {
    const normalizedVideoId = youtubeVideoId?.trim() ?? "";

    if (!mediaId || !normalizedVideoId) {
        return;
    }

    try {
        await emitProgress(onProgress, "Fetching YouTube comments...");
        const fetchedComments = await fetchYouTubeComments(normalizedVideoId, cookiesBrowser);
        const comments = normalizeFetchedComments(fetchedComments);

        await emitProgress(onProgress, `Comments fetched: ${comments.length}`);

        if (comments.length === 0) {
            await emitProgress(onProgress, "No public comments were returned for this media.");
        } else {
            await emitProgress(onProgress, "Persisting comments...");
        }

        await replaceMediaCommentsInBackend(mediaId, comments);
        await emitProgress(onProgress, `Comments saved successfully: ${comments.length}`);
    } catch (error) {
        logError("media-service", "Failed to fetch and persist YouTube comments.", error, {
            mediaId,
            youtubeVideoId: normalizedVideoId,
            cookiesBrowser,
        });

        await emitProgress(
            onProgress,
            "Failed to fetch comments. Import will continue without them."
        );
    }
}

export async function listChannelMedia(channelId: number): Promise<MediaRow[]> {
    validateChannelId(channelId);
    return listMediaByChannel(channelId);
}

export async function listMediaComments(mediaId: number): Promise<MediaCommentRow[]> {
    validateMediaId(mediaId);
    return listMediaCommentsByMediaId(mediaId);
}

export async function refreshMediaComments(
    mediaId: number,
    youtubeVideoId: string | null,
    cookiesBrowser: string | null
): Promise<RefreshMediaCommentsResult> {
    validateMediaId(mediaId);

    const normalizedVideoId = youtubeVideoId?.trim() ?? "";

    if (!normalizedVideoId) {
        throw createAppError(
            "MEDIA_WITHOUT_YOUTUBE_SOURCE",
            "This media does not have a YouTube video id."
        );
    }

    const fetchedComments = await fetchYouTubeComments(normalizedVideoId, cookiesBrowser);
    const comments = normalizeFetchedComments(fetchedComments);

    if (!Array.isArray(fetchedComments)) {
        throw createAppError(
            "INVALID_YOUTUBE_COMMENTS_PAYLOAD",
            "The comment refresh returned an invalid payload."
        );
    }

    if (comments.length === 0) {
        throw createAppError(
            "YOUTUBE_COMMENTS_EMPTY_REFRESH",
            "Comment refresh returned zero comments. Existing saved comments were preserved."
        );
    }

    await replaceMediaCommentsInBackend(mediaId, comments);

    return {
        updated: true,
        totalComments: comments.length,
    };
}

export async function createMedia(
    input: CreateMediaInput,
    options: CreateMediaOptions = {}
): Promise<CreateMediaResult> {
    const normalizedInput = validateCreateMediaInput(input);

    let createdFilePath: string | null = null;
    let createdThumbnailPath: string | null = null;
    let createdLiveChatFilePath: string | null = null;
    let mediaRegistered = false;

    try {
        const prepared = await prepareMediaArtifacts(normalizedInput);

        createdFilePath = prepared.filePath;
        createdThumbnailPath = prepared.thumbnailPath;
        createdLiveChatFilePath = prepared.liveChatFilePath ?? null;

        await emitProgress(options.onProgress, "Registering media in local library...");

        await ensureMediaDoesNotAlreadyExist(normalizedInput.channelId, prepared.filePath);

        const durationSeconds = await readMediaDurationInSeconds(
            prepared.filePath,
            normalizedInput.libraryPath,
            prepared.mediaType
        );

        const createdId = await insertMedia(
            normalizedInput.channelId,
            normalizedInput.title,
            prepared.filePath,
            prepared.thumbnailPath,
            prepared.mediaType,
            prepared.youtubeVideoId,
            prepared.publishedAt,
            durationSeconds,
            Boolean(prepared.isLive),
            prepared.liveChatFilePath ?? null
        );

        mediaRegistered = true;

        await emitProgress(options.onProgress, "Media registered successfully.");

        if (normalizedInput.sourceMode === "yt-dlp") {
            if (normalizedInput.downloadComments) {
                await tryPersistYouTubeComments(
                    createdId,
                    prepared.youtubeVideoId,
                    normalizedInput.cookiesBrowser,
                    options.onProgress
                );
            } else {
                await emitProgress(options.onProgress, "Skipping comments: disabled by user.");
            }

            if (normalizedInput.downloadLiveChat) {
                if (prepared.liveChatFilePath?.trim()) {
                    await emitProgress(options.onProgress, "Live chat replay saved successfully.");
                } else {
                    await emitProgress(
                        options.onProgress,
                        "Live chat replay was not found for this media."
                    );
                }
            } else {
                await emitProgress(options.onProgress, "Skipping live chat: disabled by user.");
            }
        }

        return {
            id: createdId ?? null,
        };
    } catch (error) {
        if (!mediaRegistered) {
            await cleanupCreatedArtifacts(
                createdFilePath,
                createdThumbnailPath,
                normalizedInput.libraryPath
            );

            if (createdLiveChatFilePath) {
                try {
                    await removeMediaLiveChatIfUnused(
                        UNREGISTERED_MEDIA_ID,
                        createdLiveChatFilePath
                    );
                } catch (cleanupError) {
                    logError(
                        "media-service",
                        "Failed to cleanup live chat file after createMedia failure.",
                        cleanupError,
                        { liveChatFilePath: createdLiveChatFilePath }
                    );
                }
            }
        }

        throw error;
    }
}

export async function deleteMediaWithFileCleanup(
    mediaId: number,
    filePath: string,
    thumbnailPath: string | null,
    libraryPath: string,
    liveChatFilePath: string | null = null
): Promise<void> {
    const normalizedInput = normalizeDeleteMediaInput(
        mediaId,
        filePath,
        thumbnailPath,
        libraryPath
    );

    await deleteMediaById(normalizedInput.mediaId);

    await cleanupMediaArtifactsWithLogging(
        normalizedInput.mediaId,
        normalizedInput.filePath,
        normalizedInput.thumbnailPath,
        liveChatFilePath,
        normalizedInput.libraryPath
    );
}

export async function deleteChannelMediaFiles(
    channelId: number,
    libraryPath: string
): Promise<void> {
    validateChannelId(channelId);

    const mediaItems = await listMediaByChannel(channelId);

    await Promise.allSettled(
        mediaItems.map((media) =>
            cleanupMediaArtifactsWithLogging(
                media.id,
                media.file_path,
                media.thumbnail_path,
                media.live_chat_file_path ?? null,
                libraryPath
            )
        )
    );
}

export async function setMediaWatched(mediaId: number): Promise<void> {
    validateMediaId(mediaId);
    await markMediaAsWatched(mediaId);
}

export async function setMediaUnwatched(mediaId: number): Promise<void> {
    validateMediaId(mediaId);
    await markMediaAsUnwatched(mediaId);
}

export async function saveMediaProgress(mediaId: number, progressSeconds: number): Promise<void> {
    validateMediaId(mediaId);

    const safeProgressSeconds = Math.max(0, Math.floor(progressSeconds));

    await updateMediaProgress(mediaId, safeProgressSeconds);
}
