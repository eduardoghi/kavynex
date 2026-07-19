import { useCallback, useEffect, useRef } from "react";
import type { MediaLibraryController } from "../types/controllers";
import type { MediaRow } from "../types/media";
import type { ImportMode } from "../types/settings";
import { useAddMediaWorkflow } from "./use-add-media-workflow";
import { useChannelMediaList } from "./use-channel-media-list";
import { useMediaActions } from "./use-media-actions";
import { useMediaPlayer } from "./use-media-player";
import { saveMediaProgress as persistMediaProgress } from "../services/media-service";
import { useMemoObject } from "./use-memo-object";

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
    const { clearMedia, setMediaItems } = mediaList;
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
        onItemsRemoved: mediaList.handleItemsRemoved,
        mediaPlayer,
        onError,
        onNotice,
    });

    const addMediaWorkflow = useAddMediaWorkflow({
        selectedChannelId,
        importMode,
        libraryPath,
        onError,
        onNotice,
        onReloadMedia: mediaList.reloadMedia,
    });

    // Latest progress saved for the media currently playing, reconciled into the in-memory list
    // in one pass when the player closes rather than on every periodic save (see below).
    const pendingProgressRef = useRef<Map<number, number>>(new Map());

    const applyProgressToList = useCallback(
        (mediaId: number, safeProgressSeconds: number): void => {
            setMediaItems((currentItems) =>
                currentItems.map((item) =>
                    updateProgressInMemory(item, mediaId, safeProgressSeconds)
                )
            );
        },
        [setMediaItems]
    );

    const saveMediaProgress = useCallback(
        async (mediaId: number, progressSeconds: number): Promise<void> => {
            await persistMediaProgress(mediaId, progressSeconds);

            const safeProgressSeconds = Math.max(0, Math.floor(progressSeconds));
            const active = activeMediaRef.current;

            if (active?.id === mediaId) {
                // The player is watching this media. Keep the active media in sync (its progress
                // is read when the player reopens), but do not rebuild the media-list array on
                // every ~10s save - that changed its identity and re-ran the (hidden) library
                // grid's O(n log n) filter+sort every few seconds during playback. The latest
                // position is stashed and reconciled into the list once the player closes (the
                // effect below); the database is written on every save above, so nothing is lost
                // if the app quits mid-playback.
                setActiveMedia({
                    ...active,
                    progress_seconds: safeProgressSeconds,
                });
                pendingProgressRef.current.set(mediaId, safeProgressSeconds);
                return;
            }

            // A save for media that is not the one playing (e.g. no player open) carries no
            // hidden hot-path cost, so it updates the list immediately.
            applyProgressToList(mediaId, safeProgressSeconds);
        },
        [applyProgressToList, setActiveMedia]
    );

    // Reconcile the progress stashed during playback into the media list once the player closes
    // (activeMedia clears): one array rebuild on close instead of one per periodic save. A
    // watched item is skipped so a late flush never undoes the zeroed position marking-watched
    // applied.
    useEffect(() => {
        if (mediaPlayer.activeMedia !== null) {
            return;
        }

        const pending = pendingProgressRef.current;

        if (pending.size === 0) {
            return;
        }

        const overrides = new Map(pending);
        pending.clear();

        setMediaItems((currentItems) =>
            currentItems.map((item) => {
                const nextProgress = overrides.get(item.id);

                if (nextProgress === undefined || item.watched_at) {
                    return item;
                }

                return updateProgressInMemory(item, item.id, nextProgress);
            })
        );
    }, [mediaPlayer.activeMedia, setMediaItems]);

    const clearMediaAndPlayer = useCallback((): void => {
        clearMedia();
        mediaPlayer.closePlayer();
    }, [clearMedia, mediaPlayer]);

    // The channel's first page (and every filter/sort change) is loaded by the library section
    // via applyMediaQuery, which is why there is no load-on-channel-change effect here anymore.
    // useChannelMediaList clears itself when no channel is selected.

    // Memoized so consumers depending on the whole object identity don't re-render unnecessarily.
    return useMemoObject({
        mediaItems: mediaList.mediaItems,
        mediaTotal: mediaList.total,
        channelMediaTotal: mediaList.channelTotal,
        hasMoreMedia: mediaList.hasMore,
        isLoadingMoreMedia: mediaList.isLoadingMore,

        addMediaOpen: addMediaWorkflow.addMediaOpen,
        setAddMediaOpen: addMediaWorkflow.setAddMediaOpen,
        closeAddMediaModal: addMediaWorkflow.closeAddMediaModal,

        confirmDeleteMediaOpen: mediaActions.confirmDeleteMediaOpen,
        mediaToDelete: mediaActions.mediaToDelete,

        isLoadingMedia: mediaList.isLoadingMedia,
        isAddingMedia: addMediaWorkflow.isAddingMedia,
        isDeletingMedia: mediaActions.isDeletingMedia,
        commentsInFlight: mediaActions.commentsInFlight,
        isUpdatingTitle: mediaActions.isUpdatingTitle,
        isCancellingYtDlp: addMediaWorkflow.isCancellingYtDlp,

        ytDlpLogs: addMediaWorkflow.ytDlpLogs,
        isYtDlpRunning: addMediaWorkflow.isYtDlpRunning,

        addMediaForm: addMediaWorkflow.addMediaForm,
        mediaPlayer,

        applyMediaQuery: mediaList.applyQuery,
        loadMoreMedia: mediaList.loadMore,
        reloadMedia: mediaList.reloadMedia,
        addMedia: addMediaWorkflow.addMedia,
        cancelYtDlpDownload: addMediaWorkflow.cancelYtDlpDownload,
        markAsWatched: mediaActions.markAsWatched,
        markAsUnwatched: mediaActions.markAsUnwatched,
        refreshComments: mediaActions.refreshComments,
        cancelRefreshComments: mediaActions.cancelRefreshComments,
        editTitle: mediaActions.editTitle,
        openMediaFileLocation: mediaActions.openMediaFileLocation,
        openMediaSourceInYoutube: mediaActions.openMediaSourceInYoutube,
        saveMediaProgress,

        requestDeleteMedia: mediaActions.requestDeleteMedia,
        confirmDeleteMedia: mediaActions.confirmDeleteMedia,
        closeDeleteMediaModal: mediaActions.closeDeleteMediaModal,

        clearMediaAndPlayer,
    });
}