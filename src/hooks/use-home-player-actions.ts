import { useCallback, useState } from "react";
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
    onReloadMedia: (channelId?: number | null) => Promise<void>;
    libraryPath: string;
};

export function useHomePlayerActions({
    mediaPlayer,
    homeMediaActions,
    onError,
    onReloadMedia,
    libraryPath,
}: UseHomePlayerActionsOptions): HomePlayerActionsController {
    const [isRefreshingComments, setIsRefreshingComments] = useState(false);

    const openInYoutube = useCallback(async (): Promise<void> => {
        await mediaPlayer.openInYoutube();
    }, [mediaPlayer]);

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
    }, [isRefreshingComments, mediaPlayer, onError, onReloadMedia]);

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
    }, [homeMediaActions, mediaPlayer]);

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
    }, [homeMediaActions, mediaPlayer]);

    const closePlayer = useCallback(
        async (progressSeconds = 0): Promise<void> => {
            const activeMedia = mediaPlayer.activeMedia;

            if (activeMedia && !activeMedia.watched_at) {
                await homeMediaActions.saveMediaProgress(activeMedia.id, progressSeconds);
            }

            mediaPlayer.closePlayer();
        },
        [homeMediaActions, mediaPlayer]
    );

    return {
        openInYoutube,
        openFileLocation: openCurrentFileLocation,
        refreshComments: refreshActiveComments,
        isRefreshingComments,
        markActiveAsWatched,
        markActiveAsUnwatched,
        closePlayer,
    };
}