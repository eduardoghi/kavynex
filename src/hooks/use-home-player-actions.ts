import { useCallback, useMemo, useState } from "react";
import {
    openFileLocation,
    refreshMediaComments,
} from "../services";
import { resolveErrorMessage } from "../utils/error-message";
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
    onNotice: (message: string) => void;
    onReloadMedia: (channelId?: number | null) => Promise<void>;
    libraryPath: string;
};

export function useHomePlayerActions({
    mediaPlayer,
    homeMediaActions,
    onError,
    onNotice,
    onReloadMedia,
    libraryPath,
}: UseHomePlayerActionsOptions): HomePlayerActionsController {
    const [isRefreshingComments, setIsRefreshingComments] = useState(false);

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

        const youtubeVideoId = activeMedia.youtube_video_id?.trim() ?? "";

        if (!youtubeVideoId) {
            onError("This media does not have a YouTube source for comment refresh.");
            return;
        }

        if (isRefreshingComments) {
            return;
        }

        setIsRefreshingComments(true);

        try {
            const result = await refreshMediaComments(
                activeMedia.id,
                youtubeVideoId,
                null
            );

            // The refresh returned no comments, so the backend kept the saved comments
            // untouched (a real extraction problem surfaces as a thrown error). This is not a
            // failure: leave the stored counts alone - overwriting them with 0 would hide
            // comments that are still on disk - and tell the user with a neutral notice.
            if (!result.updated) {
                onNotice(
                    "No comments were found for this media. Your saved comments were kept."
                );
                return;
            }

            const nextCommentsCount = result.totalComments;

            mediaPlayer.setActiveMedia({
                ...activeMedia,
                has_comments: nextCommentsCount > 0 ? 1 : 0,
                comments_count: nextCommentsCount,
            });

            await onReloadMedia(activeMedia.channel_id);
        } catch (error) {
            onError(
                resolveErrorMessage(
                    error,
                    "Failed to refresh comments. Existing saved comments were preserved."
                )
            );
        } finally {
            setIsRefreshingComments(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the specific fields read inside, not the whole per-render mediaPlayer object
    }, [
        isRefreshingComments,
        mediaPlayer.activeMedia,
        mediaPlayer.setActiveMedia,
        onError,
        onNotice,
        onReloadMedia,
    ]);

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