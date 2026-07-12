import { useCallback } from "react";
import type { SyntheticEvent } from "react";

type UseMediaPlaybackHandlersOptions = {
    progressSeconds: number;
    onPlaybackError?: (error: MediaError | null) => void;
    onPlaybackRecovered?: () => void;
};

type MediaPlaybackHandlers<T extends HTMLMediaElement> = {
    handleLoadedMetadata: (event: SyntheticEvent<T>) => void;
    handleError: (event: SyntheticEvent<T>) => void;
    handleCanPlay: () => void;
};

// Shared <video>/<audio> event handlers: seek to the saved progress once metadata loads, and
// surface playback errors and recovery to the caller. Generic over the media element so each
// surface keeps its precise event type - both HTMLVideoElement and HTMLAudioElement extend
// HTMLMediaElement, and the previous per-surface copies were identical apart from that type.
export function useMediaPlaybackHandlers<T extends HTMLMediaElement = HTMLMediaElement>({
    progressSeconds,
    onPlaybackError,
    onPlaybackRecovered,
}: UseMediaPlaybackHandlersOptions): MediaPlaybackHandlers<T> {
    const handleLoadedMetadata = useCallback(
        (event: SyntheticEvent<T>): void => {
            const element = event.currentTarget;

            if (progressSeconds > 0 && Number.isFinite(element.duration)) {
                const safeProgress = Math.min(progressSeconds, Math.max(0, element.duration - 1));
                element.currentTime = Math.max(0, safeProgress);
            }
        },
        [progressSeconds]
    );

    const handleError = useCallback(
        (event: SyntheticEvent<T>): void => {
            onPlaybackError?.(event.currentTarget.error);
        },
        [onPlaybackError]
    );

    const handleCanPlay = useCallback((): void => {
        onPlaybackRecovered?.();
    }, [onPlaybackRecovered]);

    return { handleLoadedMetadata, handleError, handleCanPlay };
}
