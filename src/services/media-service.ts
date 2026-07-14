import type { MediaCommentRow, MediaRow, YtDlpComment } from "../types/media";
import type { MediaPage } from "../types/generated/MediaPage";
import type { MediaPageQuery } from "../types/generated/MediaPageQuery";
import {
    deleteMediaWithArtifacts,
    findMediaByChannelAndFilePath,
    insertMedia,
    listMediaByChannel,
    listMediaCommentsByMediaId,
    listMediaPage,
    markMediaAsUnwatched,
    markMediaAsWatched,
    mediaExistsForChannelAndYoutubeId,
    updateMediaProgress,
    updateMediaTitle as updateMediaTitleInRepository,
} from "../repositories";
import { readMediaDurationInSeconds } from "./media-metadata-service";
import {
    cleanupCreatedArtifacts,
    prepareLocalArtifacts,
    prepareYtDlpArtifacts,
    type PreparedMediaArtifacts,
} from "./media-artifacts-service";
import {
    type CreateMediaInput,
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

function normalizeFetchedComments(comments: YtDlpComment[]): YtDlpComment[] {
    return comments.map((comment) => ({
        comment_id: comment.comment_id?.trim() || null,
        parent_comment_id: comment.parent_comment_id?.trim() || null,
        author_name: comment.author_name.trim() || "Unknown author",
        author_handle: comment.author_handle?.trim() || null,
        author_channel_id: comment.author_channel_id?.trim() || null,
        author_thumbnail: comment.author_thumbnail?.trim() || null,
        text: comment.text,
        like_count: Number.isFinite(comment.like_count)
            ? Math.max(0, Math.floor(comment.like_count))
            : 0,
        reply_count: Number.isFinite(comment.reply_count)
            ? Math.max(0, Math.floor(comment.reply_count))
            : 0,
        is_author_uploader: comment.is_author_uploader,
        is_favorited: comment.is_favorited,
        is_pinned: comment.is_pinned,
        is_edited: comment.is_edited,
        time_text: comment.time_text?.trim() || null,
        published_at: comment.published_at?.trim() || null,
    }));
}

async function prepareMediaArtifacts(
    input: CreateMediaInput
): Promise<PreparedMediaArtifacts> {
    if (input.sourceMode === "yt-dlp") {
        return prepareYtDlpArtifacts({
            sourceValue: input.sourceValue,
            thumbnailSourcePath: input.thumbnailSourcePath,
            libraryPath: input.libraryPath,
            ytDlpRunId: input.ytDlpRunId,
            ytDlpFormatId: input.ytDlpFormatId,
            cookiesBrowser: input.cookiesBrowser,
            cookiesPath: input.cookiesPath,
            downloadLiveChat: input.downloadLiveChat,
        });
    }

    return prepareLocalArtifacts({
        sourceValue: input.sourceValue,
        thumbnailSourcePath: input.thumbnailSourcePath,
        mediaType: input.mediaType,
        importMode: input.importMode,
        libraryPath: input.libraryPath,
        publishedAt: input.publishedAt,
    });
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

// Pre-download duplicate guard for the yt-dlp (URL) add flow: the youtube video id resolved
// from the format-loading metadata (see use-yt-dlp-format-loader.ts) is known before the media
// is downloaded, so a re-add of an already-registered video can fail fast with the same
// friendly error `ensureMediaDoesNotAlreadyExist` raises for the local-import path, instead of
// downloading the whole file and only then hitting the `idx_videos_channel_youtube_video_id_unique`
// unique index in `insert_media`. The post-download index check stays in place as a safety net
// (e.g. when the id could not be resolved up front, or a race with another add).
async function ensureYtDlpMediaDoesNotAlreadyExist(
    channelId: number,
    youtubeVideoId: string | null
): Promise<void> {
    const normalizedVideoId = youtubeVideoId?.trim() ?? "";

    if (!normalizedVideoId) {
        return;
    }

    const alreadyExists = await mediaExistsForChannelAndYoutubeId(channelId, normalizedVideoId);

    if (alreadyExists) {
        throw createAppError(
            "VIDEO_ALREADY_EXISTS_FOR_CHANNEL",
            "This media is already registered for the selected channel."
        );
    }
}

async function tryPersistYouTubeComments(
    mediaId: number | null,
    youtubeVideoId: string | null,
    cookiesBrowser: string | null,
    cookiesPath: string | null,
    onProgress?: (message: string) => void | Promise<void>
): Promise<void> {
    const normalizedVideoId = youtubeVideoId?.trim() ?? "";

    if (!mediaId || !normalizedVideoId) {
        return;
    }

    try {
        await emitProgress(onProgress, "Fetching YouTube comments...");
        const fetchedComments = await fetchYouTubeComments(
            normalizedVideoId,
            cookiesBrowser,
            cookiesPath
        );
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

// Returns one filtered/sorted page of a channel's media plus the total match count, so the
// library list can page through large channels instead of loading every row.
export async function listChannelMediaPage(
    channelId: number,
    query: MediaPageQuery
): Promise<MediaPage> {
    validateChannelId(channelId);
    return listMediaPage(channelId, query);
}

export async function listMediaComments(mediaId: number): Promise<MediaCommentRow[]> {
    validateMediaId(mediaId);
    return listMediaCommentsByMediaId(mediaId);
}

export async function refreshMediaComments(
    mediaId: number,
    youtubeVideoId: string | null,
    cookiesBrowser: string | null,
    cookiesPath: string | null = null
): Promise<RefreshMediaCommentsResult> {
    validateMediaId(mediaId);

    const normalizedVideoId = youtubeVideoId?.trim() ?? "";

    if (!normalizedVideoId) {
        throw createAppError(
            "MEDIA_WITHOUT_YOUTUBE_SOURCE",
            "This media does not have a YouTube video id."
        );
    }

    const fetchedComments = await fetchYouTubeComments(
        normalizedVideoId,
        cookiesBrowser,
        cookiesPath
    );
    const comments = normalizeFetchedComments(fetchedComments);

    if (!Array.isArray(fetchedComments)) {
        throw createAppError(
            "INVALID_YOUTUBE_COMMENTS_PAYLOAD",
            "The comment refresh returned an invalid payload."
        );
    }

    // Genuinely zero comments (the backend already turns "the video has comments but none
    // could be retrieved" into an error). Keep the saved comments untouched and report that
    // nothing was updated, so the caller can show a neutral notice instead of a failure.
    if (comments.length === 0) {
        return {
            updated: false,
            totalComments: 0,
        };
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
        if (normalizedInput.sourceMode === "yt-dlp") {
            await ensureYtDlpMediaDoesNotAlreadyExist(
                normalizedInput.channelId,
                normalizedInput.ytDlpYoutubeVideoId
            );
        }

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
                    normalizedInput.cookiesPath,
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
            // One atomic backend call reference-counts and removes the media file,
            // thumbnail and live chat replay that were prepared before insertMedia failed,
            // keeping any that a registered row still shares.
            await cleanupCreatedArtifacts(
                createdFilePath,
                createdThumbnailPath,
                createdLiveChatFilePath
            );
        }

        throw error;
    }
}

// The backend deletes the row and its now-unreferenced files atomically; files it could
// not remove are reported back so an orphaned file left in the library stays visible.
export async function deleteMediaWithFileCleanup(mediaId: number): Promise<void> {
    validateMediaId(mediaId);

    const report = await deleteMediaWithArtifacts(mediaId);

    if (report.failed_paths.length > 0) {
        logError(
            "media-service",
            "Media row was removed but some of its files could not be deleted; they may be orphaned in the library.",
            null,
            { mediaId, failedPaths: report.failed_paths }
        );
    }
}

export async function setMediaWatched(mediaId: number): Promise<string> {
    validateMediaId(mediaId);
    return markMediaAsWatched(mediaId);
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
