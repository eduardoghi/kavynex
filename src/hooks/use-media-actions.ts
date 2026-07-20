import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaRow } from "../types/media";
import { resolveErrorMessage } from "../utils/error-message";
import { parseAppError } from "../utils/app-error";
import { INVALID_RUN_ID_ERROR_CODE } from "../constants/error-codes";
import { executeDeleteMedia } from "../use-cases/delete-media";
import { executeMarkMediaWatched } from "../use-cases/mark-media-watched";
import { executeMarkMediaUnwatched } from "../use-cases/mark-media-unwatched";
import { useAsyncFlag } from "./use-async-flag";
import { usePerIdAsyncFlag } from "./use-per-id-async-flag";
import { logError } from "../utils/app-logger";
import { openExternalUrl, openFileLocation } from "../services/library-service";
import {
    cancelMediaDownload,
    commentsRefreshRunId,
} from "../services/media-download-service";
import { refreshMediaComments, updateMediaTitle } from "../services/media-service";
import { buildYoutubeWatchUrl } from "../utils/youtube";
import { updateItemById } from "../utils/update-item-by-id";
import { useMemoObject } from "./use-memo-object";

type UseMediaActionsOptions = {
    libraryPath: string;
    setMediaItems: React.Dispatch<React.SetStateAction<MediaRow[]>>;
    // Notifies the pager that `count` rows left the in-memory list (a delete), so the filtered and
    // channel totals stay correct without a full refetch.
    onItemsRemoved: (count: number) => void;
    mediaPlayer: {
        activeMedia: MediaRow | null;
        setActiveMedia: (media: MediaRow | null) => void;
        closePlayer: () => void;
    };
    onError: (message: string) => void;
    onNotice: (message: string) => void;
};

type UseMediaActionsReturn = {
    confirmDeleteMediaOpen: boolean;
    mediaToDelete: MediaRow | null;
    isDeletingMedia: boolean;
    commentsInFlight: ReadonlySet<number>;
    // The media ids currently being marked watched/unwatched, for the same reason commentsInFlight
    // is per id rather than one shared flag: markAsWatched/markAsUnwatched are guarded by
    // usePerIdAsyncFlag (see runWatchedActionFor below), and a caller that renders a busy state for
    // one row must resolve it against that row's id, not "something is in flight".
    watchedActionInFlight: ReadonlySet<number>;
    isUpdatingTitle: boolean;
    requestDeleteMedia: (media: MediaRow) => void;
    confirmDeleteMedia: () => Promise<void>;
    closeDeleteMediaModal: () => void;
    markAsWatched: (mediaId: number) => Promise<void>;
    markAsUnwatched: (mediaId: number) => Promise<void>;
    refreshComments: (media: MediaRow) => Promise<void>;
    cancelRefreshComments: (mediaId: number) => Promise<void>;
    editTitle: (media: MediaRow, title: string) => Promise<void>;
    openMediaFileLocation: (media: MediaRow) => Promise<void>;
    openMediaSourceInYoutube: (media: MediaRow) => Promise<void>;
};

export function useMediaActions({
    libraryPath,
    setMediaItems,
    onItemsRemoved,
    mediaPlayer,
    onError,
    onNotice,
}: UseMediaActionsOptions): UseMediaActionsReturn {
    const [confirmDeleteMediaOpen, setConfirmDeleteMediaOpen] = useState(false);
    const [mediaToDelete, setMediaToDelete] = useState<MediaRow | null>(null);

    const { isRunning: isDeletingMedia, runWithFlag: runDeleteAction } = useAsyncFlag();

    // Watched updates are guarded per media row, not by one shared flag. A single flag made the
    // second of two quick toggles on *different* cards a silent no-op: useAsyncFlag's runWithFlag
    // returns undefined without throwing when it is already running, and no component renders a
    // busy state for it, so the click just vanished. Keying by media id keeps the re-entrancy
    // guard where it belongs - one row cannot be toggled twice concurrently - while leaving
    // independent rows independent.
    const { inFlight: watchedActionInFlight, runFor: runWatchedActionFor } = usePerIdAsyncFlag();

    // Refreshing comments is per media for the same reason: the player's Back button is live while
    // a refresh is in flight, so opening another media and refreshing it is an ordinary sequence,
    // and one shared flag silently dropped that second refresh - the button responded, the
    // comments stayed stale, and nothing said so.
    const { inFlight: commentsInFlight, runFor: runRefreshCommentsFor } = usePerIdAsyncFlag();
    const { isRunning: isUpdatingTitle, runWithFlag: runUpdateTitleAction } = useAsyncFlag();

    // A ref that always holds the latest active media so the callbacks below can read it
    // without listing the per-render activeMedia object as a dependency. Depending on
    // activeMedia recreated these callbacks - and thus every per-card handler derived from
    // them in Home - on any player change (opening a video, editing a title), which
    // re-rendered the entire media grid and defeated the MediaCard memoization. The ref stays
    // current, so the callbacks can spread the up-to-date media while remaining stable.
    const activeMediaRef = useRef(mediaPlayer.activeMedia);
    useEffect(() => {
        activeMediaRef.current = mediaPlayer.activeMedia;
    }, [mediaPlayer.activeMedia]);

    // activeMedia and closePlayer are plain/stable fields off useMediaPlayer; setActiveMedia is
    // stable there too (useCallback []). Pull them out so the callbacks below can depend on
    // them directly instead of on the per-render mediaPlayer object.
    const { activeMedia, setActiveMedia, closePlayer } = mediaPlayer;

    const requestDeleteMedia = useCallback(
        (media: MediaRow): void => {
            if (isDeletingMedia) {
                return;
            }

            setMediaToDelete(media);
            setConfirmDeleteMediaOpen(true);
        },
        [isDeletingMedia]
    );

    const closeDeleteMediaModal = useCallback((): void => {
        if (isDeletingMedia) {
            return;
        }

        setConfirmDeleteMediaOpen(false);
        setMediaToDelete(null);
    }, [isDeletingMedia]);

    const closePlayerIfActive = useCallback(
        (mediaId: number): void => {
            if (activeMedia?.id === mediaId) {
                closePlayer();
            }
        },
        [activeMedia?.id, closePlayer]
    );

    const removeDeletedMediaFromMemory = useCallback(
        async (): Promise<void> => {
            const deletingId = mediaToDelete?.id ?? null;

            if (deletingId === null) {
                return;
            }

            setMediaItems((currentItems) =>
                currentItems.filter((item) => item.id !== deletingId)
            );
            onItemsRemoved(1);
        },
        [mediaToDelete?.id, onItemsRemoved, setMediaItems]
    );

    const confirmDeleteMedia = useCallback(async (): Promise<void> => {
        if (!mediaToDelete) {
            return;
        }

        await runDeleteAction(async () => {
            try {
                await executeDeleteMedia({
                    media: mediaToDelete,
                    reloadMedia: removeDeletedMediaFromMemory,
                    closePlayerIfActive,
                });

                setConfirmDeleteMediaOpen(false);
                setMediaToDelete(null);
            } catch (error) {
                logError("media-actions", "Failed to delete media.", error, {
                    mediaId: mediaToDelete.id,
                    libraryPath,
                });
                onError(resolveErrorMessage(error, "Failed to delete media."));
            }
        });
    }, [
        closePlayerIfActive,
        libraryPath,
        mediaToDelete,
        onError,
        removeDeletedMediaFromMemory,
        runDeleteAction,
    ]);

    const markAsWatched = useCallback(
        async (mediaId: number): Promise<void> => {
            await runWatchedActionFor(mediaId, async () => {
                try {
                    const watchedAt = await executeMarkMediaWatched({
                        mediaId,
                        updateMediaItems: setMediaItems,
                    });

                    const active = activeMediaRef.current;

                    if (active?.id === mediaId) {
                        // Reset progress together with watched_at, matching the media-list update
                        // and the backend (which zeroes progress_seconds when marking watched).
                        setActiveMedia({
                            ...active,
                            watched_at: watchedAt,
                            progress_seconds: 0,
                        });
                    }
                } catch (error) {
                    logError("media-actions", "Failed to update watched status.", error, {
                        mediaId,
                        nextState: "watched",
                    });
                    onError(resolveErrorMessage(error, "Failed to update watched status."));
                }
            });
        },
        [setActiveMedia, onError, runWatchedActionFor, setMediaItems]
    );

    const markAsUnwatched = useCallback(
        async (mediaId: number): Promise<void> => {
            await runWatchedActionFor(mediaId, async () => {
                try {
                    await executeMarkMediaUnwatched({
                        mediaId,
                        updateMediaItems: setMediaItems,
                    });

                    const active = activeMediaRef.current;

                    if (active?.id === mediaId) {
                        setActiveMedia({
                            ...active,
                            watched_at: null,
                        });
                    }
                } catch (error) {
                    logError("media-actions", "Failed to update watched status.", error, {
                        mediaId,
                        nextState: "unwatched",
                    });
                    onError(resolveErrorMessage(error, "Failed to update watched status."));
                }
            });
        },
        [setActiveMedia, onError, runWatchedActionFor, setMediaItems]
    );

    const refreshComments = useCallback(
        async (media: MediaRow): Promise<void> => {
            await runRefreshCommentsFor(media.id, async () => {
                try {
                    const result = await refreshMediaComments(
                        media.id,
                        media.youtube_video_id,
                        null
                    );

                    // The refresh returned no comments, so the saved comments were kept
                    // untouched. This is not a failure (a real extraction problem surfaces as
                    // a thrown error) - tell the user with a neutral notice and leave the
                    // stored counts alone.
                    if (!result.updated) {
                        onNotice(
                            "No comments were found for this media. Your saved comments were kept."
                        );
                        return;
                    }

                    setMediaItems((currentItems) =>
                        currentItems.map((item) =>
                            updateItemById(item, media.id, (currentItem) => ({
                                ...currentItem,
                                has_comments: result.totalComments > 0 ? 1 : 0,
                                comments_count: result.totalComments,
                            }))
                        )
                    );

                    const active = activeMediaRef.current;

                    if (active?.id === media.id) {
                        setActiveMedia({
                            ...active,
                            has_comments: result.totalComments > 0 ? 1 : 0,
                            comments_count: result.totalComments,
                        });
                    }
                } catch (error) {
                    logError("media-actions", "Failed to refresh comments.", error, {
                        mediaId: media.id,
                        youtubeVideoId: media.youtube_video_id,
                    });
                    onError(
                        resolveErrorMessage(
                            error,
                            "Failed to refresh comments. Existing saved comments were preserved."
                        )
                    );
                }
            });
        },
        [
            setActiveMedia,
            onError,
            onNotice,
            runRefreshCommentsFor,
            setMediaItems,
        ]
    );

    const cancelRefreshComments = useCallback(
        async (mediaId: number): Promise<void> => {
            // The comment backup was registered under this deterministic run id (see
            // media-service.refreshMediaComments), so cancelling it just signals that run. Best
            // effort: if it already finished, cancelMediaDownload rejects with INVALID_RUN_ID (the
            // registry no longer has this run), which is expected here and not surfaced to the
            // user. Any other failure means the cancel signal did not reach the still-running
            // backup - quietly logging that (the old behavior) left the user believing Cancel
            // worked while the download kept running, so it gets a non-blocking notice instead.
            try {
                await cancelMediaDownload(commentsRefreshRunId(mediaId));
            } catch (error) {
                if (parseAppError(error).code === INVALID_RUN_ID_ERROR_CODE) {
                    return;
                }

                logError("media-actions", "Failed to cancel the comment refresh.", error, {
                    mediaId,
                });
                onNotice(
                    "Could not confirm the comment refresh was cancelled. It may still be running in the background."
                );
            }
        },
        [onNotice]
    );

    const editTitle = useCallback(
        async (media: MediaRow, title: string): Promise<void> => {
            await runUpdateTitleAction(async () => {
                try {
                    const normalizedTitle = title.trim();

                    await updateMediaTitle(media.id, normalizedTitle);

                    setMediaItems((currentItems) =>
                        currentItems.map((item) =>
                            updateItemById(item, media.id, (currentItem) => ({
                                ...currentItem,
                                title: normalizedTitle,
                            }))
                        )
                    );

                    const active = activeMediaRef.current;

                    if (active?.id === media.id) {
                        setActiveMedia({
                            ...active,
                            title: normalizedTitle,
                        });
                    }
                } catch (error) {
                    logError("media-actions", "Failed to update media title.", error, {
                        mediaId: media.id,
                        title,
                    });
                    onError(resolveErrorMessage(error, "Failed to update media title."));
                }
            });
        },
        [setActiveMedia, onError, runUpdateTitleAction, setMediaItems]
    );

    const openMediaFileLocation = useCallback(
        async (media: MediaRow): Promise<void> => {
            try {
                await openFileLocation(media.file_path, libraryPath);
            } catch (error) {
                logError("media-actions", "Failed to open file location.", error, {
                    mediaId: media.id,
                    filePath: media.file_path,
                    libraryPath,
                });
                onError(resolveErrorMessage(error, "Failed to open file location."));
            }
        },
        [libraryPath, onError]
    );

    const openMediaSourceInYoutube = useCallback(
        async (media: MediaRow): Promise<void> => {
            const youtubeVideoId = media.youtube_video_id?.trim() ?? "";

            if (!youtubeVideoId) {
                onError("This media does not have a YouTube source.");
                return;
            }

            try {
                await openExternalUrl(buildYoutubeWatchUrl(youtubeVideoId));
            } catch (error) {
                logError("media-actions", "Failed to open media source on YouTube.", error, {
                    mediaId: media.id,
                    youtubeVideoId,
                });
                onError(resolveErrorMessage(error, "Failed to open source on YouTube."));
            }
        },
        [onError]
    );

    return useMemoObject({
        confirmDeleteMediaOpen,
        mediaToDelete,
        isDeletingMedia,
        commentsInFlight,
        watchedActionInFlight,
        isUpdatingTitle,
        requestDeleteMedia,
        confirmDeleteMedia,
        closeDeleteMediaModal,
        markAsWatched,
        markAsUnwatched,
        refreshComments,
        cancelRefreshComments,
        editTitle,
        openMediaFileLocation,
        openMediaSourceInYoutube,
    });
}