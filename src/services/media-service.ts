import type { MediaCommentRow, YtDlpComment } from "../types/media";
import type { MediaPage } from "../types/generated/MediaPage";
import type { MediaPageQuery } from "../types/generated/MediaPageQuery";
import type { CreatedMedia } from "../types/generated/CreatedMedia";
import {
    createMedia as createMediaInBackend,
    deleteMediaWithArtifacts,
    listMediaCommentsByMediaId,
    listMediaPage,
    markMediaAsUnwatched,
    markMediaAsWatched,
    updateMediaDuration,
    updateMediaProgress,
    updateMediaTitle as updateMediaTitleInRepository,
} from "../repositories";
import { readMediaDurationInSeconds } from "./media-metadata-service";
import {
    type CreateMediaInput,
    validateCreateMediaInput,
    validateMediaId,
} from "./media-input-service";
import { validateChannelId } from "./channel-input-service";
import { createAppError } from "../utils/app-error";
import { commentsRefreshRunId, fetchYouTubeComments } from "./media-download-service";
import {
    markMediaCommentsAbsentInBackend,
    replaceMediaCommentsInBackend,
} from "./media-comments-service";
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

// Measures the media that was just created and stores the result. Best effort and deliberately
// after the fact. The probe decodes the file through a media element, so it can only run here, and
// a media whose duration cannot be read is a card without a runtime rather than a failed import.
//
// It used to run *inside* the creation, between the crash marker and the insert. Besides putting a
// renderer step in the middle of a backend transaction, that placement carried a real hazard. The
// probe settles on `loadedmetadata` or `error`, and a source that fires neither left the promise
// pending forever with the marker on disk and the row never inserted.
async function tryStoreMeasuredDuration(
    created: CreatedMedia,
    libraryPath: string
): Promise<void> {
    try {
        const durationSeconds = await readMediaDurationInSeconds(
            created.filePath,
            libraryPath,
            created.mediaType
        );

        if (durationSeconds === null) {
            return;
        }

        await updateMediaDuration(created.id, durationSeconds);
    } catch (error) {
        logError("media-service", "Could not store the measured media duration.", error, {
            mediaId: created.id,
        });
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
        cookiesPath,
        // Register the run so the player's "Cancel" can abort this backup (up to a few minutes)
        // promptly. Deterministic in the media id so the caller can cancel it without threading a
        // generated run id back through React state.
        commentsRefreshRunId(mediaId)
    );
    // Guard the payload shape before normalizing it. normalizeFetchedComments maps over the value,
    // so a non-array would throw a raw TypeError there instead of this friendly AppError. The IPC
    // seam already validates this against a zod array schema, so this is defense in depth that must
    // still run first to mean anything.
    if (!Array.isArray(fetchedComments)) {
        throw createAppError(
            "INVALID_YOUTUBE_COMMENTS_PAYLOAD",
            "The comment refresh returned an invalid payload."
        );
    }

    const comments = normalizeFetchedComments(fetchedComments);

    // Genuinely zero comments (the backend already turns "the video has comments but none
    // could be retrieved" into an error). Keep the saved comments untouched and report that
    // nothing was updated, so the caller can show a neutral notice instead of a failure.
    if (comments.length === 0) {
        // Record that the question was asked, which is the part this path used to skip. Returning
        // without telling the backend anything left the media indistinguishable from one nothing
        // had ever been fetched for, so the player kept offering a Fetch button and the user could
        // re-run a refresh that could never return anything.
        //
        // Deliberately not `replaceMediaCommentsInBackend(mediaId, [])`. That deletes before it
        // inserts, so it would wipe a saved backup because a later fetch came back empty. This one
        // writes only the state, and only when no comments are stored.
        await markMediaCommentsAbsentInBackend(mediaId);

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

    await emitProgress(options.onProgress, "Registering media in local library...");

    // One call, and everything that used to be sequenced here is inside it. The duplicate
    // pre-check, the download or import, the thumbnail, the crash marker, the insert and the
    // marker's removal. What that buys is not fewer lines but a window that no longer crosses the
    // process boundary, and an exclusion against a concurrent cleanup that is a backend lock rather
    // than this modal refusing to open twice. A failure unwinds inside the backend too, artifacts
    // and all, so there is nothing left here to clean up.
    const created = await createMediaInBackend({
        channelId: normalizedInput.channelId,
        title: normalizedInput.title,
        sourceMode: normalizedInput.sourceMode,
        sourceValue: normalizedInput.sourceValue,
        thumbnailSourcePath: normalizedInput.thumbnailSourcePath,
        mediaType: normalizedInput.mediaType,
        importMode: normalizedInput.importMode,
        libraryPath: normalizedInput.libraryPath,
        publishedAt: normalizedInput.publishedAt,
        ytDlpRunId: normalizedInput.ytDlpRunId,
        ytDlpFormatId: normalizedInput.ytDlpFormatId,
        ytDlpYoutubeVideoId: normalizedInput.ytDlpYoutubeVideoId,
        downloadLiveChat: normalizedInput.downloadLiveChat,
        cookiesBrowser: normalizedInput.cookiesBrowser,
        cookiesPath: normalizedInput.cookiesPath,
    });

    await emitProgress(options.onProgress, "Media registered successfully.");

    // Everything below runs against a media that is already registered, which is why it stayed on
    // this side. Each step is best effort, none of it can strand an artifact, and the duration probe
    // needs a media element the backend does not have.
    await tryStoreMeasuredDuration(created, normalizedInput.libraryPath);

    if (normalizedInput.sourceMode === "yt-dlp") {
        if (normalizedInput.downloadComments) {
            await tryPersistYouTubeComments(
                created.id,
                created.youtubeVideoId,
                normalizedInput.cookiesBrowser,
                normalizedInput.cookiesPath,
                options.onProgress
            );
        } else {
            await emitProgress(options.onProgress, "Skipping comments because the user disabled them.");
        }

        if (normalizedInput.downloadLiveChat) {
            if (created.liveChatFilePath?.trim()) {
                await emitProgress(options.onProgress, "Live chat replay saved successfully.");
            } else {
                await emitProgress(
                    options.onProgress,
                    "Live chat replay was not found for this media."
                );
            }
        } else {
            await emitProgress(options.onProgress, "Skipping live chat because the user disabled it.");
        }
    }

    return {
        id: created.id,
    };
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
