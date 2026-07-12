import { useCallback, useEffect, useRef } from "react";
import type { MediaRow } from "../types/media";

// timeupdate fires ~4x/second; persist at most this often so a crash, a force-close, or the
// updater relaunch never loses more than a few seconds of watch position. The exact position
// is also flushed on pause/seek/ended, when the window is hidden, and when the player closes.
export const PROGRESS_SAVE_THROTTLE_MS = 10_000;

// Persists the playback position of the media currently in `playerElement` back through
// `onSaveProgress`: throttled on `timeupdate`, flushed exactly on pause/seek/ended, when the
// window is hidden or the app is relaunching, and when the player unmounts. Extracted from
// MediaPlayerView so this timing-sensitive concern is isolated and testable on its own.
export function useMediaProgressPersistence(
    media: MediaRow | null,
    playerElement: HTMLMediaElement | null,
    onSaveProgress: (mediaId: number, progressSeconds: number) => void | Promise<void>
): void {
    // Latest media, so the event listeners below (which are wired once per element) always
    // persist against the media that is actually playing without re-subscribing on every
    // re-render.
    const mediaRef = useRef<MediaRow | null>(media);
    useEffect(() => {
        mediaRef.current = media;
    }, [media]);

    // Last position observed from the media element, kept outside React state so the
    // high-frequency timeupdate stream never triggers a re-render.
    const lastProgressRef = useRef(0);

    const persistProgress = useCallback((): void => {
        const currentMedia = mediaRef.current;

        // Watched media intentionally resets to 0 and must not be rewound by a late save.
        if (!currentMedia || currentMedia.watched_at) {
            return;
        }

        void onSaveProgress(currentMedia.id, lastProgressRef.current);
    }, [onSaveProgress]);

    // Seed the last-known position from the stored progress so an early close (before the
    // first timeupdate) re-saves the same value instead of overwriting it with 0.
    useEffect(() => {
        lastProgressRef.current = media?.watched_at ? 0 : (media?.progress_seconds ?? 0);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- seeded once per media; progress/watched are read intentionally at seed time
    }, [media?.id]);

    useEffect(() => {
        const element = playerElement;

        if (!element) {
            return;
        }

        // Negative infinity so the first timeupdate persists right away; later ones are
        // throttled relative to it.
        let lastSavedAt = Number.NEGATIVE_INFINITY;

        const remember = (): void => {
            lastProgressRef.current = element.currentTime || 0;
        };

        const handleTimeUpdate = (): void => {
            remember();

            const now = performance.now();

            if (now - lastSavedAt < PROGRESS_SAVE_THROTTLE_MS) {
                return;
            }

            lastSavedAt = now;
            persistProgress();
        };

        // Flush the exact position immediately on the discrete events, where a few seconds of
        // throttled drift would be noticeable.
        const handleFlush = (): void => {
            remember();
            persistProgress();
        };

        element.addEventListener("timeupdate", handleTimeUpdate);
        element.addEventListener("pause", handleFlush);
        element.addEventListener("ended", handleFlush);
        element.addEventListener("seeked", handleFlush);

        return () => {
            element.removeEventListener("timeupdate", handleTimeUpdate);
            element.removeEventListener("pause", handleFlush);
            element.removeEventListener("ended", handleFlush);
            element.removeEventListener("seeked", handleFlush);
        };
    }, [playerElement, persistProgress]);

    // Best-effort save when the window is hidden or the app is quitting/relaunching (e.g. the
    // updater's relaunch), neither of which runs the unmount cleanup below.
    useEffect(() => {
        const handleHide = (): void => {
            persistProgress();
        };

        const handleVisibilityChange = (): void => {
            if (document.visibilityState === "hidden") {
                persistProgress();
            }
        };

        window.addEventListener("pagehide", handleHide);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            window.removeEventListener("pagehide", handleHide);
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [persistProgress]);

    // Persist the final position when the player unmounts - the Back button, switching
    // channels from the sidebar, or the active media being deleted all land here.
    useEffect(() => {
        return () => {
            persistProgress();
        };
    }, [persistProgress]);
}
