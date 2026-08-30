import type { SyntheticEvent } from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useMediaPlaybackHandlers } from "./use-media-playback-handlers";

function mediaEvent(
    element: Partial<HTMLMediaElement>
): SyntheticEvent<HTMLMediaElement> {
    return { currentTarget: element } as SyntheticEvent<HTMLMediaElement>;
}

describe("useMediaPlaybackHandlers", () => {
    it("seeks to the saved progress once metadata loads", () => {
        const { result } = renderHook(() =>
            useMediaPlaybackHandlers({ progressSeconds: 42 })
        );

        const element: Partial<HTMLMediaElement> = { duration: 120, currentTime: 0 };
        result.current.handleLoadedMetadata(mediaEvent(element));

        expect(element.currentTime).toBe(42);
    });

    it("starts from the beginning when the saved position is at or past the end", () => {
        // A position saved past the end (a duration that shrank, or a row written before finishing
        // a media marked it watched) must not resume there. The media would play for an instant
        // and end again, which reads as a broken file.
        const { result } = renderHook(() =>
            useMediaPlaybackHandlers({ progressSeconds: 500 })
        );

        const pastTheEnd: Partial<HTMLMediaElement> = { duration: 100, currentTime: 0 };
        result.current.handleLoadedMetadata(mediaEvent(pastTheEnd));
        expect(pastTheEnd.currentTime).toBe(0);

        const { result: atTheEnd } = renderHook(() =>
            useMediaPlaybackHandlers({ progressSeconds: 99 })
        );

        const finished: Partial<HTMLMediaElement> = { duration: 100, currentTime: 0 };
        atTheEnd.current.handleLoadedMetadata(mediaEvent(finished));
        expect(finished.currentTime).toBe(0);
    });

    it("does not seek when there is no saved progress or the duration is unknown", () => {
        const { result } = renderHook(() =>
            useMediaPlaybackHandlers({ progressSeconds: 0 })
        );

        const noProgress: Partial<HTMLMediaElement> = { duration: 100, currentTime: 7 };
        result.current.handleLoadedMetadata(mediaEvent(noProgress));
        expect(noProgress.currentTime).toBe(7);

        const { result: withProgress } = renderHook(() =>
            useMediaPlaybackHandlers({ progressSeconds: 30 })
        );
        const unknownDuration: Partial<HTMLMediaElement> = { duration: NaN, currentTime: 3 };
        withProgress.current.handleLoadedMetadata(mediaEvent(unknownDuration));
        expect(unknownDuration.currentTime).toBe(3);
    });

    it("forwards the media error and recovery to the callbacks", () => {
        const onPlaybackError = vi.fn();
        const onPlaybackRecovered = vi.fn();

        const { result } = renderHook(() =>
            useMediaPlaybackHandlers({
                progressSeconds: 0,
                onPlaybackError,
                onPlaybackRecovered,
            })
        );

        const error = { code: 4 } as MediaError;
        result.current.handleError(mediaEvent({ error }));
        expect(onPlaybackError).toHaveBeenCalledWith(error);

        result.current.handleCanPlay();
        expect(onPlaybackRecovered).toHaveBeenCalledTimes(1);
    });
});
