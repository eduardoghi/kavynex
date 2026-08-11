import { useCallback, useState } from "react";
import type { MediaPlayerController } from "../../types/controllers";
import type { MediaRow } from "../../types/media";
import { resolveStoredPath, fileSrcFromAbsolutePath, isMediaWatched } from "../../utils/media-utils";
import { buildYoutubeWatchUrl } from "../../utils/youtube";
import { openExternalUrl } from "../../services/library-service";
import { logError } from "../../utils/app-logger";
import { useMemoObject } from "../use-memo-object";

type UseMediaPlayerOptions = {
    libraryPath: string;
};

export function useMediaPlayer({
    libraryPath,
}: UseMediaPlayerOptions): MediaPlayerController {
    const [viewMode, setViewMode] = useState<"library" | "player">("library");
    const [activeMedia, setActiveMediaState] = useState<MediaRow | null>(null);

    // Every field below is a pure, cheap derivation off activeMedia/libraryPath, computed plainly
    // rather than each wrapped in its own useMemo. The whole returned object goes through
    // useMemoObject below, which keeps a stable controller identity as long as every field is
    // shallow-equal to the previous render - and these are all primitives (strings/booleans),
    // compared by value, so recomputing one to the same value on an unrelated re-render leaves that
    // identity unchanged. Per-field memoization of a primitive would only cache the compute, not
    // affect what any consumer observes, so it is left out to keep the derivations uniform.
    const activeIsAudio = activeMedia?.media_type === "audio";
    const activeSrc = fileSrcFromAbsolutePath(
        resolveStoredPath(activeMedia?.file_path ?? null, libraryPath)
    );
    const activeThumbSrc = fileSrcFromAbsolutePath(
        resolveStoredPath(activeMedia?.thumbnail_path ?? null, libraryPath)
    );
    const activeYoutubeUrl = buildYoutubeWatchUrl(activeMedia?.youtube_video_id ?? "");
    const canOpenInYoutube = activeYoutubeUrl !== "";
    const activeIsWatched = isMediaWatched(activeMedia);

    const openPlayer = useCallback((media: MediaRow): void => {
        setActiveMediaState(media);
        setViewMode("player");
    }, []);

    const setActiveMedia = useCallback((media: MediaRow | null): void => {
        setActiveMediaState(media);
    }, []);

    // Sync the active media's watch position through a functional update so it no-ops when the media
    // is no longer active. A final progress save fired as the player unmounts (the Back button) can
    // run before the mirrored activeMediaRef in use-media-library sees the close, so a ref-based
    // guard there would still re-set the (just-cleared) active media - re-highlighting its card in
    // the grid. Reading the live state here closes that race.
    const syncActiveMediaProgress = useCallback(
        (mediaId: number, progressSeconds: number): void => {
            setActiveMediaState((prev) =>
                prev && prev.id === mediaId
                    ? { ...prev, progress_seconds: progressSeconds }
                    : prev
            );
        },
        []
    );

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

    return useMemoObject({
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
        syncActiveMediaProgress,
        closePlayer,
        openInYoutube,
    });
}