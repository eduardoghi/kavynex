import { useCallback, useMemo, useState } from "react";
import type { MediaPlayerController } from "../types/controllers";
import type { MediaRow } from "../types/media";
import { resolveStoredPath, fileSrcFromAbsolutePath } from "../utils/media-utils";
import { buildYoutubeWatchUrl } from "../utils/youtube";
import { openExternalUrl } from "../services/library-service";
import { logError } from "../utils/app-logger";

type UseMediaPlayerOptions = {
    libraryPath: string;
};

export function useMediaPlayer({
    libraryPath,
}: UseMediaPlayerOptions): MediaPlayerController {
    const [viewMode, setViewMode] = useState<"library" | "player">("library");
    const [activeMedia, setActiveMediaState] = useState<MediaRow | null>(null);

    const activeIsAudio = useMemo(() => {
        if (!activeMedia) {
            return false;
        }

        return activeMedia.media_type === "audio";
    }, [activeMedia]);

    const activeSrc = useMemo(() => {
        const absolutePath = resolveStoredPath(activeMedia?.file_path ?? null, libraryPath);
        return fileSrcFromAbsolutePath(absolutePath);
    }, [activeMedia, libraryPath]);

    const activeThumbSrc = useMemo(() => {
        const absolutePath = resolveStoredPath(activeMedia?.thumbnail_path ?? null, libraryPath);
        return fileSrcFromAbsolutePath(absolutePath);
    }, [activeMedia, libraryPath]);

    const activeYoutubeUrl = useMemo(
        () => buildYoutubeWatchUrl(activeMedia?.youtube_video_id ?? ""),
        [activeMedia]
    );

    const canOpenInYoutube = activeYoutubeUrl !== "";
    const activeIsWatched = Boolean(activeMedia?.watched_at?.trim());

    const openPlayer = useCallback((media: MediaRow): void => {
        setActiveMediaState(media);
        setViewMode("player");
    }, []);

    const setActiveMedia = useCallback((media: MediaRow | null): void => {
        setActiveMediaState(media);
    }, []);

    const closePlayer = useCallback((): void => {
        setViewMode("library");
        setActiveMediaState(null);
    }, []);

    const openInYoutube = useCallback(async (): Promise<void> => {
        if (!activeYoutubeUrl) {
            return;
        }

        try {
            await openExternalUrl(activeYoutubeUrl);
        } catch (error) {
            logError("media-player", "Failed to open media source on YouTube.", error, {
                mediaId: activeMedia?.id ?? null,
                url: activeYoutubeUrl,
            });
        }
    }, [activeMedia?.id, activeYoutubeUrl]);

    return useMemo(
        () => ({
            viewMode,
            activeMedia,
            activeIsAudio,
            activeSrc,
            activeThumbSrc,
            activeYoutubeUrl,
            canOpenInYoutube,
            activeIsWatched,
            openPlayer,
            setActiveMedia,
            closePlayer,
            openInYoutube,
        }),
        [
            viewMode,
            activeMedia,
            activeIsAudio,
            activeSrc,
            activeThumbSrc,
            activeYoutubeUrl,
            canOpenInYoutube,
            activeIsWatched,
            openPlayer,
            setActiveMedia,
            closePlayer,
            openInYoutube,
        ]
    );
}