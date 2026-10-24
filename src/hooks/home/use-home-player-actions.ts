import { useCallback, useEffect, useRef } from "react";
import { openFileLocation } from "../../services/library-service";
import { resolveErrorMessage } from "../../utils/error-message";
import { logError } from "../../utils/app-logger";
import { isMediaWatched } from "../../utils/media-utils";
import type { MediaRow } from "../../types/media";
import type { MediaPlayerController } from "../media/use-media-player";
import type { HomeMediaActionsController } from "./use-home-media-actions";
import { useMemoObject } from "../use-memo-object";

export type HomePlayerActionsController = {
    openInYoutube: () => Promise<void>;
    markActiveAsWatched: () => Promise<void>;
    markActiveAsUnwatched: () => Promise<void>;
    saveProgress: (mediaId: number, progressSeconds: number) => Promise<void>;
    closePlayer: (progressSeconds?: number) => Promise<void>;
    openFileLocation: () => Promise<void>;
    refreshComments: () => Promise<void>;
    cancelRefreshComments: () => Promise<void>;
    isRefreshingComments: boolean;
    // Resolved against the media on screen (like isRefreshingComments), true while a
    // markActiveAsWatched/markActiveAsUnwatched call for it is in flight.
    isUpdatingWatchedStatus: boolean;
};

type UseHomePlayerActionsOptions = {
    mediaPlayer: Pick<
        MediaPlayerController,
        "activeMedia" | "openInYoutube" | "closePlayer"
    >;
    homeMediaActions: Pick<
        HomeMediaActionsController,
        | "markAsWatched"
        | "markAsUnwatched"
        | "watchedActionInFlight"
        | "saveMediaProgress"
    >;
    onError: (message: string) => void;
    // The single implementation of the comment-refresh rule (result handling, the neutral
    // notice, and the media-list/active-media updates) lives in the media-library action;
    // the player only adapts it to the active media, so the two cannot apply different rules.
    refreshComments: (media: MediaRow) => Promise<void>;
    // Cancels an in-flight comment backup for a media id (see use-media-actions). The player adapts
    // it to the active media so the header's Cancel targets the media on screen.
    cancelRefreshComments: (mediaId: number) => Promise<void>;
    // The ids being refreshed, not a shared "something is refreshing" flag. The player resolves it
    // against the media it is showing, so a refresh left running on a media the user navigated away
    // from cannot mark this one busy. That matters beyond the label. The button renders `loading`
    // from it, and Mantine disables a loading button, so a shared flag would block the refresh of
    // the media actually on screen.
    commentsInFlight: ReadonlySet<number>;
};

export function useHomePlayerActions({
    mediaPlayer,
    homeMediaActions,
    onError,
    refreshComments,
    cancelRefreshComments,
    commentsInFlight,
}: UseHomePlayerActionsOptions): HomePlayerActionsController {
    // Destructure the stable fields off the per-render mediaPlayer/homeMediaActions controller
    // objects so the callbacks below can depend on them directly. This keeps the dependency
    // arrays honest (no eslint-disable) while still not depending on the whole objects, whose
    // identity changes every render.
    const {
        activeMedia,
        openInYoutube: openInYoutubeAction,
        closePlayer: closePlayerAction,
    } = mediaPlayer;
    const {
        markAsWatched: markAsWatchedAction,
        markAsUnwatched: markAsUnwatchedAction,
        watchedActionInFlight,
        saveMediaProgress,
    } = homeMediaActions;

    const openInYoutube = useCallback(async (): Promise<void> => {
        await openInYoutubeAction();
    }, [openInYoutubeAction]);

    const openCurrentFileLocation = useCallback(async (): Promise<void> => {
        const filePath = activeMedia?.file_path?.trim() ?? "";

        if (!filePath) {
            onError("This media does not have a valid file path.");
            return;
        }

        try {
            await openFileLocation(filePath);
        } catch (error) {
            onError(resolveErrorMessage(error, "Failed to open file location."));
        }
    }, [activeMedia, onError]);

    const refreshActiveComments = useCallback(async (): Promise<void> => {
        if (!activeMedia) {
            return;
        }

        // The button is shown for every media, but only YouTube-sourced media can refresh
        // comments. Guard here with a clear message. Everything else (result handling, the
        // neutral "kept your comments" notice, the concurrency flag, and the media-list and
        // active-media updates) is delegated to the media-library action so that rule has a
        // single implementation.
        if (!activeMedia.youtube_video_id?.trim()) {
            onError("This media does not have a YouTube source for comment refresh.");
            return;
        }

        await refreshComments(activeMedia);
    }, [activeMedia, onError, refreshComments]);

    const cancelActiveComments = useCallback(async (): Promise<void> => {
        const activeId = activeMedia?.id;

        // An explicit undefined check rather than truthiness, so it says what it tests for.
        if (activeId === undefined) {
            return;
        }

        await cancelRefreshComments(activeId);
    }, [activeMedia?.id, cancelRefreshComments]);

    const markActiveAsWatched = useCallback(async (): Promise<void> => {
        const activeId = activeMedia?.id;

        // An explicit undefined check rather than truthiness, so it says what it tests for.
        if (activeId === undefined) {
            return;
        }

        // markAsWatchedAction already updates the media list and the active media with the
        // timestamp the database persisted. Doing a second setActiveMedia here (from the
        // activeMedia captured before the await, with a freshly fabricated timestamp) both
        // raced with concurrent updates and diverged from the stored value, so it is gone.
        await markAsWatchedAction(activeId);
    }, [markAsWatchedAction, activeMedia?.id]);

    const markActiveAsUnwatched = useCallback(async (): Promise<void> => {
        const activeId = activeMedia?.id;

        // An explicit undefined check rather than truthiness, so it says what it tests for.
        if (activeId === undefined) {
            return;
        }

        // markAsUnwatchedAction already clears watched_at on the media list and the active
        // media. No second, stale-closure update is needed here.
        await markAsUnwatchedAction(activeId);
    }, [markAsUnwatchedAction, activeMedia?.id]);

    const saveProgress = useCallback(
        async (mediaId: number, progressSeconds: number): Promise<void> => {
            await saveMediaProgress(mediaId, progressSeconds);
        },
        [saveMediaProgress]
    );

    // Read through a ref so closePlayer keeps one identity for the player's lifetime. activeMedia
    // changes on every progress sync (about every ten seconds while playing), and closePlayer reaches
    // every channel row in the sidebar, so depending on it re-rendered the whole list each time.
    const activeMediaRef = useRef(activeMedia);
    useEffect(() => {
        activeMediaRef.current = activeMedia;
    }, [activeMedia]);

    const closePlayer = useCallback(
        async (progressSeconds?: number): Promise<void> => {
            const current = activeMediaRef.current;

            // Only persist when a concrete position was supplied. The Back button reads it
            // from the media element and passes it here. Navigation-only closes (switching
            // channels from the sidebar, deleting the active media) call this with no argument
            // and must not overwrite the saved position with 0. The player view persists
            // progress on its own (periodically and on unmount), so those paths still keep the
            // latest position.
            if (progressSeconds !== undefined && current && !isMediaWatched(current)) {
                // A save that fails must not keep the player open. The position is lost either
                // way, and a Back button that does nothing is the worse of the two.
                try {
                    await saveMediaProgress(current.id, progressSeconds);
                } catch (error) {
                    logError("player", "Failed to save the position when closing the player.", error, {
                        mediaId: current.id,
                    });
                }
            }

            closePlayerAction();
        },
        [saveMediaProgress, closePlayerAction]
    );

    return useMemoObject({
        openInYoutube,
        openFileLocation: openCurrentFileLocation,
        refreshComments: refreshActiveComments,
        cancelRefreshComments: cancelActiveComments,
        // Resolved against the media on screen, so a refresh still running on one the user
        // navigated away from does not report this one as busy.
        isRefreshingComments: activeMedia ? commentsInFlight.has(activeMedia.id) : false,
        // Same resolution as isRefreshingComments. A watched/unwatched toggle left running on a
        // media the user navigated away from must not mark the one on screen busy.
        isUpdatingWatchedStatus: activeMedia
            ? watchedActionInFlight.has(activeMedia.id)
            : false,
        markActiveAsWatched,
        markActiveAsUnwatched,
        saveProgress,
        closePlayer,
    });
}