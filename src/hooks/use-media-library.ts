import { useCallback, useEffect } from "react";
import type { MediaLibraryController } from "../types/controllers";
import type { MediaRow } from "../types/media";
import type { ImportMode } from "../types/settings";
import { useAddMediaWorkflow } from "./use-add-media-workflow";
import { useChannelMediaList } from "./use-channel-media-list";
import { useMediaActions } from "./use-media-actions";
import { useMediaPlayer } from "./use-media-player";
import { saveMediaProgress as persistMediaProgress } from "../services/media-service";

function updateProgressInMemory(
    item: MediaRow,
    mediaId: number,
    progressSeconds: number
): MediaRow {
    if (item.id !== mediaId) {
        return item;
    }

    return {
        ...item,
        progress_seconds: progressSeconds,
    };
}

type UseMediaLibraryOptions = {
    libraryPath: string;
    importMode: ImportMode;
    onError: (message: string) => void;
    selectedChannelId: number | null;
};

export function useMediaLibrary({
    libraryPath,
    importMode,
    onError,
    selectedChannelId,
}: UseMediaLibraryOptions): MediaLibraryController {
    const mediaPlayer = useMediaPlayer({
        libraryPath,
    });

    const mediaList = useChannelMediaList({
        selectedChannelId,
        onError,
    });

    const mediaActions = useMediaActions({
        libraryPath,
        setMediaItems: mediaList.setMediaItems,
        mediaPlayer,
        onError,
    });

    const addMediaWorkflow = useAddMediaWorkflow({
        selectedChannelId,
        importMode,
        libraryPath,
        onError,
        onReloadMedia: mediaList.loadMedia,
    });

    const saveMediaProgress = useCallback(
        async (mediaId: number, progressSeconds: number): Promise<void> => {
            await persistMediaProgress(mediaId, progressSeconds);

            const safeProgressSeconds = Math.max(0, Math.floor(progressSeconds));

            mediaList.setMediaItems((currentItems) =>
                currentItems.map((item) =>
                    updateProgressInMemory(item, mediaId, safeProgressSeconds)
                )
            );

            if (mediaPlayer.activeMedia?.id === mediaId) {
                mediaPlayer.setActiveMedia({
                    ...mediaPlayer.activeMedia,
                    progress_seconds: safeProgressSeconds,
                });
            }
        },
        [mediaList, mediaPlayer]
    );

    const clearMediaAndPlayer = useCallback((): void => {
        mediaList.clearMedia();
        mediaPlayer.closePlayer();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- dep is the stable memoized callback, not the whole per-render mediaList object
    }, [mediaList.clearMedia, mediaPlayer]);

    useEffect(() => {
        if (selectedChannelId === null) {
            mediaList.clearMedia();
            return;
        }

        void mediaList.loadMedia(selectedChannelId);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the stable memoized callbacks, not the whole per-render mediaList object
    }, [selectedChannelId, mediaList.clearMedia, mediaList.loadMedia]);

    return {
        mediaItems: mediaList.mediaItems,

        addMediaOpen: addMediaWorkflow.addMediaOpen,
        setAddMediaOpen: addMediaWorkflow.setAddMediaOpen,
        closeAddMediaModal: addMediaWorkflow.closeAddMediaModal,

        confirmDeleteMediaOpen: mediaActions.confirmDeleteMediaOpen,
        mediaToDelete: mediaActions.mediaToDelete,

        isLoadingMedia: mediaList.isLoadingMedia,
        isAddingMedia: addMediaWorkflow.isAddingMedia,
        isDeletingMedia: mediaActions.isDeletingMedia,
        isUpdatingWatched: mediaActions.isUpdatingWatched,
        isRefreshingComments: mediaActions.isRefreshingComments,
        isUpdatingTitle: mediaActions.isUpdatingTitle,
        isCancellingYtDlp: addMediaWorkflow.isCancellingYtDlp,

        ytDlpLogs: addMediaWorkflow.ytDlpLogs,
        isYtDlpRunning: addMediaWorkflow.isYtDlpRunning,

        addMediaForm: addMediaWorkflow.addMediaForm,
        mediaPlayer,

        loadMedia: mediaList.loadMedia,
        addMedia: addMediaWorkflow.addMedia,
        cancelYtDlpDownload: addMediaWorkflow.cancelYtDlpDownload,
        markAsWatched: mediaActions.markAsWatched,
        markAsUnwatched: mediaActions.markAsUnwatched,
        refreshComments: mediaActions.refreshComments,
        editTitle: mediaActions.editTitle,
        openMediaFileLocation: mediaActions.openMediaFileLocation,
        openMediaSourceInYoutube: mediaActions.openMediaSourceInYoutube,
        saveMediaProgress,

        requestDeleteMedia: mediaActions.requestDeleteMedia,
        confirmDeleteMedia: mediaActions.confirmDeleteMedia,
        closeDeleteMediaModal: mediaActions.closeDeleteMediaModal,

        clearMediaAndPlayer,
    };
}