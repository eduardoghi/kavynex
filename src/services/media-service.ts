import type { MediaCommentRow } from "../types/media";
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
import { createAppError, parseAppError } from "../utils/app-error";
import { YT_DLP_DOWNLOAD_CANCELLED_ERROR_CODE } from "../constants/error-codes";
import { commentsRefreshRunId, fetchMediaComments } from "./media-download-service";
import { logError } from "../utils/app-logger";

// What the comment backup that follows a download ended in. `failed` is the one the caller has to
// say out loud. The media is registered either way, and the only other trace of it is a line in the
// terminal of a modal that closes on its own.
export type CommentsBackupOutcome = "saved" | "none" | "skipped" | "failed" | "not-requested";

type CreateMediaResult = {
    id: number | null;
    comments: CommentsBackupOutcome;
};

type CreateMediaOptions = {
    onProgress?: (message: string) => void | Promise<void>;
    // Makes the comment backup that follows the registration cancellable. The download's run is
    // released once the media is registered, so the fetch registers this id for itself, and
    // onCommentsFetchChange tells the caller while it runs, the only time a Cancel can reach it.
    commentsRunId?: string;
    onCommentsFetchChange?: (fetching: boolean) => void;
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
    options: CreateMediaOptions
): Promise<CommentsBackupOutcome> {
    const { onProgress, commentsRunId, onCommentsFetchChange } = options;
    const normalizedVideoId = youtubeVideoId?.trim() ?? "";

    if (!mediaId || !normalizedVideoId) {
        return "not-requested";
    }

    try {
        await emitProgress(onProgress, "Fetching YouTube comments...");

        let outcome;
        onCommentsFetchChange?.(true);

        try {
            // Fetches and stores in one backend call, so the comments are saved even if this
            // window goes away before the call returns.
            outcome = await fetchMediaComments(
                mediaId,
                normalizedVideoId,
                cookiesBrowser,
                cookiesPath,
                commentsRunId
            );
        } finally {
            onCommentsFetchChange?.(false);
        }

        await emitProgress(
            onProgress,
            outcome.fetched === 0
                ? "No public comments were returned for this media."
                : `Comments saved: ${outcome.stored}`
        );

        return outcome.fetched === 0 ? "none" : "saved";
    } catch (error) {
        // The user skipped them. The media is already registered and stays.
        if (parseAppError(error).code === YT_DLP_DOWNLOAD_CANCELLED_ERROR_CODE) {
            await emitProgress(onProgress, "Comments skipped. The media was added without them.");
            return "skipped";
        }

        logError("media-service", "Failed to fetch and persist YouTube comments.", error, {
            mediaId,
            youtubeVideoId: normalizedVideoId,
            cookiesBrowser,
        });

        await emitProgress(
            onProgress,
            "Failed to fetch comments. Import will continue without them."
        );

        return "failed";
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

    const outcome = await fetchMediaComments(
        mediaId,
        normalizedVideoId,
        cookiesBrowser,
        cookiesPath,
        // Register the run so the player's "Cancel" can abort this backup (up to a few minutes)
        // promptly. Deterministic in the media id so the caller can cancel it without threading a
        // generated run id back through React state.
        commentsRefreshRunId(mediaId)
    );

    // Genuinely zero comments (the backend already turns "the video has comments but none could
    // be retrieved" into an error). The backend kept the saved comments and recorded that the
    // fetch found nothing, so the caller shows a neutral notice instead of a failure.
    if (outcome.fetched === 0) {
        return {
            updated: false,
            totalComments: 0,
        };
    }

    // `stored`, not `fetched`. The merge keeps every comment saved earlier, including the ones
    // this fetch no longer found.
    return {
        updated: true,
        totalComments: outcome.stored,
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
        importMode: normalizedInput.importMode,
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

    let comments: CommentsBackupOutcome = "not-requested";

    if (normalizedInput.sourceMode === "yt-dlp") {
        if (normalizedInput.downloadComments) {
            comments = await tryPersistYouTubeComments(
                created.id,
                created.youtubeVideoId,
                normalizedInput.cookiesBrowser,
                normalizedInput.cookiesPath,
                options
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
        comments,
    };
}

// The backend deletes the row and its now-unreferenced files atomically; files it could
// not remove are reported back so an orphaned file left in the library stays visible. Resolves
// with how many of them stayed behind.
export async function deleteMediaWithFileCleanup(mediaId: number): Promise<number> {
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

    return report.failed_paths.length;
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
