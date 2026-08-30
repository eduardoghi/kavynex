import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { useMediaProgressPersistence } from "./use-media-progress-persistence";
import { createMedia } from "../../test/factories/media";

type SaveProgress = (mediaId: number, progressSeconds: number) => void;

function videoElementAt(currentTime: number): HTMLMediaElement {
    const element = document.createElement("video");
    Object.defineProperty(element, "currentTime", {
        value: currentTime,
        writable: true,
        configurable: true,
    });
    return element;
}

describe("useMediaProgressPersistence", () => {
    let onSave: Mock<SaveProgress>;

    beforeEach(() => {
        onSave = vi.fn<SaveProgress>();
    });

    it("flushes the exact position on pause", () => {
        const element = videoElementAt(42);

        renderHook(() =>
            useMediaProgressPersistence(createMedia({ id: 7 }), element, onSave)
        );

        act(() => {
            element.dispatchEvent(new Event("pause"));
        });

        expect(onSave).toHaveBeenCalledWith(7, 42);
    });

    it("persists the seeded position when the player unmounts", () => {
        const element = videoElementAt(0);

        const { unmount } = renderHook(() =>
            useMediaProgressPersistence(
                createMedia({ id: 7, progress_seconds: 25 }),
                element,
                onSave
            )
        );

        onSave.mockClear();
        unmount();

        // No timeupdate happened, so the last-known position is the seeded stored progress.
        expect(onSave).toHaveBeenCalledWith(7, 25);
    });

    it("does not save when only the onSaveProgress callback identity changes", () => {
        const element = videoElementAt(30);

        const { rerender, unmount } = renderHook(
            ({ save }: { save: SaveProgress }) =>
                useMediaProgressPersistence(
                    createMedia({ id: 7, progress_seconds: 30 }),
                    element,
                    save
                ),
            { initialProps: { save: onSave } }
        );

        onSave.mockClear();

        // A fresh callback identity (the real hook chain rebuilds these) must not trigger the
        // unmount-only save. re-running that cleanup mid-session was the bug this guards against.
        const nextSave = vi.fn<SaveProgress>();
        rerender({ save: nextSave });

        expect(onSave).not.toHaveBeenCalled();
        expect(nextSave).not.toHaveBeenCalled();

        // The real unmount still flushes exactly once, through the latest callback.
        unmount();
        expect(nextSave).toHaveBeenCalledTimes(1);
        expect(nextSave).toHaveBeenCalledWith(7, 30);
    });

    it("never persists progress for watched media", () => {
        const element = videoElementAt(99);

        const { unmount } = renderHook(() =>
            useMediaProgressPersistence(
                createMedia({ id: 7, watched_at: "2026-01-01T00:00:00.000Z" }),
                element,
                onSave
            )
        );

        act(() => {
            element.dispatchEvent(new Event("pause"));
            element.dispatchEvent(new Event("seeked"));
        });
        unmount();

        expect(onSave).not.toHaveBeenCalled();
    });

    it("reports completion instead of the position when playback ends", () => {
        const element = videoElementAt(600);
        const onCompleted = vi.fn();

        renderHook(() =>
            useMediaProgressPersistence(createMedia({ id: 7 }), element, onSave, onCompleted)
        );

        act(() => {
            element.dispatchEvent(new Event("ended"));
        });

        expect(onCompleted).toHaveBeenCalledTimes(1);
        // Saving here would race the write that zeroes progress_seconds for the watched row, and
        // could put the end position back on it.
        expect(onSave).not.toHaveBeenCalled();
    });

    it("reports completion once per media, however often the end is reached", () => {
        const element = videoElementAt(600);
        const onCompleted = vi.fn();

        // The media prop keeps its unwatched value, standing in for the window before the write
        // lands and re-renders. The guard cannot rely on watched_at alone.
        renderHook(() =>
            useMediaProgressPersistence(createMedia({ id: 7 }), element, onSave, onCompleted)
        );

        act(() => {
            element.dispatchEvent(new Event("ended"));
            element.dispatchEvent(new Event("ended"));
        });

        expect(onCompleted).toHaveBeenCalledTimes(1);
    });

    it("falls back to flushing the position when there is no completion to report", () => {
        const watched = videoElementAt(600);
        const onCompleted = vi.fn();

        // Already watched. Nothing to mark, and persistProgress drops the save on its own.
        const { unmount } = renderHook(() =>
            useMediaProgressPersistence(
                createMedia({ id: 7, watched_at: "2026-01-01T00:00:00.000Z" }),
                watched,
                onSave,
                onCompleted
            )
        );

        act(() => {
            watched.dispatchEvent(new Event("ended"));
        });

        expect(onCompleted).not.toHaveBeenCalled();
        unmount();

        // No callback at all. Ending still has to persist the position, which is what every
        // caller that does not pass one relies on.
        const element = videoElementAt(600);

        renderHook(() =>
            useMediaProgressPersistence(createMedia({ id: 9 }), element, onSave)
        );

        act(() => {
            element.dispatchEvent(new Event("ended"));
        });

        expect(onSave).toHaveBeenCalledWith(9, 600);
    });
});
