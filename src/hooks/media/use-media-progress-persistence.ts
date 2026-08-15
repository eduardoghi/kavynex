import { useCallback, useEffect, useRef } from "react";
import type { MediaRow } from "../../types/media";
import { isMediaWatched } from "../../utils/media-utils";

// timeupdate fires ~4x/second; persist at most this often so a crash, a force-close, or the
// updater relaunch never loses more than a few seconds of watch position. The exact position
// is also flushed on pause/seek/ended, when the window is hidden, and when the player closes.
export const PROGRESS_SAVE_THROTTLE_MS = 10_000;

// Persists how much of the media in `playerElement` the user has seen: the position through
// `onSaveProgress` (throttled on `timeupdate`, flushed exactly on pause/seek, when the window is
// hidden or the app is relaunching, and when the player unmounts), and reaching the end through
// `onPlaybackCompleted`. Both are the same concern in two shapes, which is why one hook owns them:
// only the code watching the position knows when there is no longer a position to remember.
// Extracted from MediaPlayerView so this timing-sensitive concern is isolated and testable on its
// own.
export function useMediaProgressPersistence(
    media: MediaRow | null,
    playerElement: HTMLMediaElement | null,
    onSaveProgress: (mediaId: number, progressSeconds: number) => void | Promise<void>,
    onPlaybackCompleted?: () => void | Promise<void>
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
        if (!currentMedia || isMediaWatched(currentMedia)) {
            return;
        }

        void onSaveProgress(currentMedia.id, lastProgressRef.current);
    }, [onSaveProgress]);

    // Latest persistProgress, so the unmount-only effect below can call it without listing it as a
    // dependency, which would re-run that effect's cleanup (an extra save) on every identity change
    // of persistProgress rather than only on a true unmount.
    const persistProgressRef = useRef(persistProgress);
    useEffect(() => {
        persistProgressRef.current = persistProgress;
    }, [persistProgress]);

    // Same reasoning as persistProgressRef: the listeners are wired once per element and must see
    // the current callback without re-subscribing.
    const onPlaybackCompletedRef = useRef(onPlaybackCompleted);
    useEffect(() => {
        onPlaybackCompletedRef.current = onPlaybackCompleted;
    }, [onPlaybackCompleted]);

    // The media whose completion was already reported. `ended` fires again whenever the user
    // replays or seeks back and reaches the end a second time, and the watched flag on `media`
    // only catches that once the write has landed and re-rendered.
    const completedMediaIdRef = useRef<number | null>(null);

    // Seed the last-known position from the stored progress so an early close (before the
    // first timeupdate) re-saves the same value instead of overwriting it with 0.
    useEffect(() => {
        lastProgressRef.current = isMediaWatched(media) ? 0 : (media?.progress_seconds ?? 0);
        completedMediaIdRef.current = null;
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

        // Reaching the end is reported as completion instead of as a position, and the two are
        // exclusive on purpose: marking the row watched zeroes progress_seconds in the backend, so
        // a save racing that write would put the end position back on a watched row. Anything with
        // no completion to report (no callback, already watched, already reported for this media)
        // falls through to the ordinary flush.
        const handleEnded = (): void => {
            remember();

            const currentMedia = mediaRef.current;
            const reportCompleted = onPlaybackCompletedRef.current;
            const isNewCompletion =
                currentMedia !== null &&
                !isMediaWatched(currentMedia) &&
                completedMediaIdRef.current !== currentMedia.id;

            if (reportCompleted && isNewCompletion) {
                completedMediaIdRef.current = currentMedia.id;
                void reportCompleted();
                return;
            }

            persistProgress();
        };

        element.addEventListener("timeupdate", handleTimeUpdate);
        element.addEventListener("pause", handleFlush);
        element.addEventListener("ended", handleEnded);
        element.addEventListener("seeked", handleFlush);

        return () => {
            element.removeEventListener("timeupdate", handleTimeUpdate);
            element.removeEventListener("pause", handleFlush);
            element.removeEventListener("ended", handleEnded);
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

    // Persist the final position when the player unmounts. The Back button, switching
    // channels from the sidebar, or the active media being deleted all land here. Empty deps so the
    // cleanup fires exactly once, on the real unmount, and never mid-session when persistProgress
    // changes identity; it reads the latest persistProgress through the ref above.
    useEffect(() => {
        return () => {
            persistProgressRef.current();
        };
    }, []);
}
