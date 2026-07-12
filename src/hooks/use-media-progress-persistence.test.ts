import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { useMediaProgressPersistence } from "./use-media-progress-persistence";
import { createMedia } from "../test/factories/media";

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
});
