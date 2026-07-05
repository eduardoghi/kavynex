import { useCallback, useState } from "react";
import type { MediaRow } from "../types/media";
import { resolveErrorMessage } from "../utils/error-message";
import { executeDeleteMedia } from "../use-cases/delete-media";
import { executeMarkMediaWatched } from "../use-cases/mark-media-watched";
import { executeMarkMediaUnwatched } from "../use-cases/mark-media-unwatched";
import { useAsyncFlag } from "./use-async-flag";
import { logError } from "../utils/app-logger";
import { openExternalUrl, openFileLocation } from "../services/library-service";
import { refreshMediaComments, updateMediaTitle } from "../services/media-service";

type UseMediaActionsOptions = {
    libraryPath: string;
    setMediaItems: React.Dispatch<React.SetStateAction<MediaRow[]>>;
    mediaPlayer: {
        activeMedia: MediaRow | null;
        setActiveMedia: (media: MediaRow | null) => void;
        closePlayer: () => void;
    };
    onError: (message: string) => void;
};

type UseMediaActionsReturn = {
    confirmDeleteMediaOpen: boolean;
    mediaToDelete: MediaRow | null;
    isDeletingMedia: boolean;
    isUpdatingWatched: boolean;
    isRefreshingComments: boolean;
    isUpdatingTitle: boolean;
    requestDeleteMedia: (media: MediaRow) => void;
    confirmDeleteMedia: () => Promise<void>;
    closeDeleteMediaModal: () => void;
    markAsWatched: (mediaId: number) => Promise<void>;
    markAsUnwatched: (mediaId: number) => Promise<void>;
    refreshComments: (media: MediaRow) => Promise<void>;
    editTitle: (media: MediaRow, title: string) => Promise<void>;
    openMediaFileLocation: (media: MediaRow) => Promise<void>;
    openMediaSourceInYoutube: (media: MediaRow) => Promise<void>;
};

function updateMediaItem(
    item: MediaRow,
    mediaId: number,
    updater: (item: MediaRow) => MediaRow
): MediaRow {
    if (item.id !== mediaId) {
        return item;
    }

    return updater(item);
}

export function useMediaActions({
    libraryPath,
    setMediaItems,
    mediaPlayer,
    onError,
}: UseMediaActionsOptions): UseMediaActionsReturn {
    const [confirmDeleteMediaOpen, setConfirmDeleteMediaOpen] = useState(false);
    const [mediaToDelete, setMediaToDelete] = useState<MediaRow | null>(null);

    const { isRunning: isDeletingMedia, runWithFlag: runDeleteAction } = useAsyncFlag();
    const { isRunning: isUpdatingWatched, runWithFlag: runWatchedAction } = useAsyncFlag();
    const { isRunning: isRefreshingComments, runWithFlag: runRefreshCommentsAction } =
        useAsyncFlag();
    const { isRunning: isUpdatingTitle, runWithFlag: runUpdateTitleAction } = useAsyncFlag();

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
            if (mediaPlayer.activeMedia?.id === mediaId) {
                mediaPlayer.closePlayer();
            }
        },
        [mediaPlayer]
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
        },
        [mediaToDelete?.id, setMediaItems]
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
            await runWatchedAction(async () => {
                try {
                    const watchedAt = await executeMarkMediaWatched({
                        mediaId,
                        updateMediaItems: setMediaItems,
                    });

                    if (mediaPlayer.activeMedia?.id === mediaId) {
                        mediaPlayer.setActiveMedia({
                            ...mediaPlayer.activeMedia,
                            watched_at: watchedAt,
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
        [mediaPlayer, onError, runWatchedAction, setMediaItems]
    );

    const markAsUnwatched = useCallback(
        async (mediaId: number): Promise<void> => {
            await runWatchedAction(async () => {
                try {
                    await executeMarkMediaUnwatched({
                        mediaId,
                        updateMediaItems: setMediaItems,
                    });

                    if (mediaPlayer.activeMedia?.id === mediaId) {
                        mediaPlayer.setActiveMedia({
                            ...mediaPlayer.activeMedia,
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
        [mediaPlayer, onError, runWatchedAction, setMediaItems]
    );

    const refreshComments = useCallback(
        async (media: MediaRow): Promise<void> => {
            await runRefreshCommentsAction(async () => {
                try {
                    const result = await refreshMediaComments(
                        media.id,
                        media.youtube_video_id,
                        null
                    );

                    setMediaItems((currentItems) =>
                        currentItems.map((item) =>
                            updateMediaItem(item, media.id, (currentItem) => ({
                                ...currentItem,
                                has_comments: result.totalComments > 0 ? 1 : 0,
                                comments_count: result.totalComments,
                            }))
                        )
                    );

                    if (mediaPlayer.activeMedia?.id === media.id) {
                        mediaPlayer.setActiveMedia({
                            ...mediaPlayer.activeMedia,
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
        [mediaPlayer, onError, runRefreshCommentsAction, setMediaItems]
    );

    const editTitle = useCallback(
        async (media: MediaRow, title: string): Promise<void> => {
            await runUpdateTitleAction(async () => {
                try {
                    const normalizedTitle = title.trim();

                    await updateMediaTitle(media.id, normalizedTitle);

                    setMediaItems((currentItems) =>
                        currentItems.map((item) =>
                            updateMediaItem(item, media.id, (currentItem) => ({
                                ...currentItem,
                                title: normalizedTitle,
                            }))
                        )
                    );

                    if (mediaPlayer.activeMedia?.id === media.id) {
                        mediaPlayer.setActiveMedia({
                            ...mediaPlayer.activeMedia,
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
        [mediaPlayer, onError, runUpdateTitleAction, setMediaItems]
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
                await openExternalUrl(
                    `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeVideoId)}`
                );
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

    return {
        confirmDeleteMediaOpen,
        mediaToDelete,
        isDeletingMedia,
        isUpdatingWatched,
        isRefreshingComments,
        isUpdatingTitle,
        requestDeleteMedia,
        confirmDeleteMedia,
        closeDeleteMediaModal,
        markAsWatched,
        markAsUnwatched,
        refreshComments,
        editTitle,
        openMediaFileLocation,
        openMediaSourceInYoutube,
    };
}