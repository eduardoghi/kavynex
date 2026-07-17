import { useCallback } from "react";
import { openFileLocation } from "../services";
import { resolveErrorMessage } from "../utils/error-message";
import type { MediaRow } from "../types/media";
import type {
    HomePlayerActionsController,
    HomeMediaActionsController,
    MediaPlayerController,
} from "../types/controllers";
import { useMemoObject } from "./use-memo-object";

type UseHomePlayerActionsOptions = {
    mediaPlayer: Pick<
        MediaPlayerController,
        "activeMedia" | "openInYoutube" | "closePlayer"
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
    // The ids being refreshed, not a shared "something is refreshing" flag: the player resolves it
    // against the media it is showing, so a refresh left running on a media the user navigated away
    // from cannot mark this one busy. That matters beyond the label - the button renders `loading`
    // from it, and Mantine disables a loading button, so a shared flag would block the refresh of
    // the media actually on screen.
    commentsInFlight: ReadonlySet<number>;
    libraryPath: string;
};

export function useHomePlayerActions({
    mediaPlayer,
    homeMediaActions,
    onError,
    refreshComments,
    commentsInFlight,
    libraryPath,
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
            await openFileLocation(filePath, libraryPath);
        } catch (error) {
            onError(resolveErrorMessage(error, "Failed to open file location."));
        }
    }, [libraryPath, activeMedia, onError]);

    const refreshActiveComments = useCallback(async (): Promise<void> => {
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
    }, [activeMedia, onError, refreshComments]);

    const markActiveAsWatched = useCallback(async (): Promise<void> => {
        const activeId = activeMedia?.id;

        // Explicit undefined check, not truthiness: a media id of 0 is a valid row id and must
        // not be treated as "no active media".
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

        // Explicit undefined check, not truthiness: a media id of 0 is a valid row id and must
        // not be treated as "no active media".
        if (activeId === undefined) {
            return;
        }

        // markAsUnwatchedAction already clears watched_at on the media list and the active
        // media; no second, stale-closure update is needed here.
        await markAsUnwatchedAction(activeId);
    }, [markAsUnwatchedAction, activeMedia?.id]);

    const saveProgress = useCallback(
        async (mediaId: number, progressSeconds: number): Promise<void> => {
            await saveMediaProgress(mediaId, progressSeconds);
        },
        [saveMediaProgress]
    );

    const closePlayer = useCallback(
        async (progressSeconds?: number): Promise<void> => {
            // Only persist when a concrete position was supplied - the Back button reads it
            // from the media element and passes it here. Navigation-only closes (switching
            // channels from the sidebar, deleting the active media) call this with no argument
            // and must not overwrite the saved position with 0. The player view persists
            // progress on its own (periodically and on unmount), so those paths still keep the
            // latest position.
            if (progressSeconds !== undefined && activeMedia && !activeMedia.watched_at) {
                await saveMediaProgress(activeMedia.id, progressSeconds);
            }

            closePlayerAction();
        },
        [saveMediaProgress, activeMedia, closePlayerAction]
    );

    return useMemoObject({
        openInYoutube,
        openFileLocation: openCurrentFileLocation,
        refreshComments: refreshActiveComments,
        // Resolved against the media on screen, so a refresh still running on one the user
        // navigated away from does not report this one as busy.
        isRefreshingComments: activeMedia ? commentsInFlight.has(activeMedia.id) : false,
        markActiveAsWatched,
        markActiveAsUnwatched,
        saveProgress,
        closePlayer,
    });
}