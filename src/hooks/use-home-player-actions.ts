import { useCallback, useMemo } from "react";
import { openFileLocation } from "../services";
import { resolveErrorMessage } from "../utils/error-message";
import type { MediaRow } from "../types/media";
import type {
    HomePlayerActionsController,
    HomeMediaActionsController,
    MediaPlayerController,
} from "../types/controllers";

type UseHomePlayerActionsOptions = {
    mediaPlayer: Pick<
        MediaPlayerController,
        "activeMedia" | "openInYoutube" | "closePlayer" | "setActiveMedia"
    >;
    homeMediaActions: Pick<
        HomeMediaActionsController,
        "markAsWatched" | "markAsUnwatched" | "saveMediaProgress"
    >;
    onError: (message: string) => void;
    // The single implementation of the comment-refresh rule (result handling, the neutral
    // notice, and the media-list/active-media updates) lives in the media-library action;
    // the player only adapts it to the active media, so both share one source of truth.
    refreshComments: (media: MediaRow) => Promise<void>;
    isRefreshingComments: boolean;
    libraryPath: string;
};

export function useHomePlayerActions({
    mediaPlayer,
    homeMediaActions,
    onError,
    refreshComments,
    isRefreshingComments,
    libraryPath,
}: UseHomePlayerActionsOptions): HomePlayerActionsController {
    const openInYoutube = useCallback(async (): Promise<void> => {
        await mediaPlayer.openInYoutube();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- dep is the specific stable callback read inside, not the whole per-render mediaPlayer object
    }, [mediaPlayer.openInYoutube]);

    const openCurrentFileLocation = useCallback(async (): Promise<void> => {
        const activeMedia = mediaPlayer.activeMedia;
        const filePath = activeMedia?.file_path?.trim() ?? "";

        if (!filePath) {
            onError("This media does not have a valid file path.");
            return;
        }

        try {
            await openFileLocation(filePath, libraryPath);
        } catch (error) {
            onError(resolveErrorMessage(error, "Failed to open file location."));
        }
    }, [libraryPath, mediaPlayer.activeMedia, onError]);

    const refreshActiveComments = useCallback(async (): Promise<void> => {
        const activeMedia = mediaPlayer.activeMedia;

        if (!activeMedia) {
            return;
        }

        // The button is shown for every media, but only YouTube-sourced media can refresh
        // comments; guard here with a clear message. Everything else - result handling, the
        // neutral "kept your comments" notice, the concurrency flag, and the media-list and
        // active-media updates - is delegated to the media-library action so that rule has a
        // single implementation.
        if (!activeMedia.youtube_video_id?.trim()) {
            onError("This media does not have a YouTube source for comment refresh.");
            return;
        }

        await refreshComments(activeMedia);
    }, [mediaPlayer.activeMedia, onError, refreshComments]);

    const markActiveAsWatched = useCallback(async (): Promise<void> => {
        const activeMedia = mediaPlayer.activeMedia;
        const activeId = activeMedia?.id;

        if (!activeId || !activeMedia) {
            return;
        }

        await homeMediaActions.markAsWatched(activeId);

        mediaPlayer.setActiveMedia({
            ...activeMedia,
            watched_at: new Date().toISOString(),
            progress_seconds: 0,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the specific fields read inside, not the whole per-render homeMediaActions/mediaPlayer objects
    }, [homeMediaActions.markAsWatched, mediaPlayer.activeMedia, mediaPlayer.setActiveMedia]);

    const markActiveAsUnwatched = useCallback(async (): Promise<void> => {
        const activeMedia = mediaPlayer.activeMedia;
        const activeId = activeMedia?.id;

        if (!activeId || !activeMedia) {
            return;
        }

        await homeMediaActions.markAsUnwatched(activeId);

        mediaPlayer.setActiveMedia({
            ...activeMedia,
            watched_at: null,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the specific fields read inside, not the whole per-render homeMediaActions/mediaPlayer objects
    }, [homeMediaActions.markAsUnwatched, mediaPlayer.activeMedia, mediaPlayer.setActiveMedia]);

    const saveProgress = useCallback(
        async (mediaId: number, progressSeconds: number): Promise<void> => {
            await homeMediaActions.saveMediaProgress(mediaId, progressSeconds);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- dep is the specific stable callback read inside, not the whole per-render homeMediaActions object
        [homeMediaActions.saveMediaProgress]
    );

    const closePlayer = useCallback(
        async (progressSeconds?: number): Promise<void> => {
            const activeMedia = mediaPlayer.activeMedia;

            // Only persist when a concrete position was supplied - the Back button reads it
            // from the media element and passes it here. Navigation-only closes (switching
            // channels from the sidebar, deleting the active media) call this with no argument
            // and must not overwrite the saved position with 0. The player view persists
            // progress on its own (periodically and on unmount), so those paths still keep the
            // latest position.
            if (progressSeconds !== undefined && activeMedia && !activeMedia.watched_at) {
                await homeMediaActions.saveMediaProgress(activeMedia.id, progressSeconds);
            }

            mediaPlayer.closePlayer();
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the specific fields read inside, not the whole per-render homeMediaActions/mediaPlayer objects
        [homeMediaActions.saveMediaProgress, mediaPlayer.activeMedia, mediaPlayer.closePlayer]
    );

    return useMemo(
        () => ({
            openInYoutube,
            openFileLocation: openCurrentFileLocation,
            refreshComments: refreshActiveComments,
            isRefreshingComments,
            markActiveAsWatched,
            markActiveAsUnwatched,
            saveProgress,
            closePlayer,
        }),
        [
            openInYoutube,
            openCurrentFileLocation,
            refreshActiveComments,
            isRefreshingComments,
            markActiveAsWatched,
            markActiveAsUnwatched,
            saveProgress,
            closePlayer,
        ]
    );
}