import { useCallback, useEffect, useRef } from "react";
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
    onNotice: (message: string) => void;
    selectedChannelId: number | null;
};

export function useMediaLibrary({
    libraryPath,
    importMode,
    onError,
    onNotice,
    selectedChannelId,
}: UseMediaLibraryOptions): MediaLibraryController {
    const mediaPlayer = useMediaPlayer({
        libraryPath,
    });

    const mediaList = useChannelMediaList({
        selectedChannelId,
        onError,
    });

    // Destructure the stable fields off the mediaList/mediaPlayer controller objects so the
    // callbacks and effects below can depend on them directly rather than on the whole objects
    // (whose identity changes when their contents do). setMediaItems (useState) and
    // setActiveMedia (useCallback []) are stable, so a callback depending only on them is
    // itself stable.
    const { clearMedia, loadMedia, setMediaItems } = mediaList;
    const { setActiveMedia } = mediaPlayer;

    // Track the active media in a ref so saveMediaProgress can read the current value without
    // listing mediaPlayer.activeMedia as a dependency. Depending on activeMedia would recreate
    // saveMediaProgress on every progress update - and that cascade is what made the player
    // re-attach its timeupdate listener and reset the 10s save throttle on every save, turning
    // one write per 10s into several writes per second.
    const activeMediaRef = useRef<MediaRow | null>(mediaPlayer.activeMedia);

    useEffect(() => {
        activeMediaRef.current = mediaPlayer.activeMedia;
    }, [mediaPlayer.activeMedia]);

    const mediaActions = useMediaActions({
        libraryPath,
        setMediaItems,
        mediaPlayer,
        onError,
        onNotice,
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

            setMediaItems((currentItems) =>
                currentItems.map((item) =>
                    updateProgressInMemory(item, mediaId, safeProgressSeconds)
                )
            );

            const active = activeMediaRef.current;

            if (active?.id === mediaId) {
                setActiveMedia({
                    ...active,
                    progress_seconds: safeProgressSeconds,
                });
            }
        },
        [setMediaItems, setActiveMedia]
    );

    const clearMediaAndPlayer = useCallback((): void => {
        clearMedia();
        mediaPlayer.closePlayer();
    }, [clearMedia, mediaPlayer]);

    useEffect(() => {
        if (selectedChannelId === null) {
            clearMedia();
            return;
        }

        void loadMedia(selectedChannelId);
    }, [selectedChannelId, clearMedia, loadMedia]);

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