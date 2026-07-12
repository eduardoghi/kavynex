import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIEvent } from "react";
import { useGridScrollRestoration } from "./use-grid-scroll-restoration";

function scrollElementAt(scrollTop: number): HTMLDivElement {
    const element = document.createElement("div");
    Object.defineProperty(element, "scrollTop", {
        value: scrollTop,
        writable: true,
        configurable: true,
    });
    return element;
}

function scrollEvent(scrollTop: number): UIEvent<HTMLDivElement> {
    return { currentTarget: { scrollTop } } as unknown as UIEvent<HTMLDivElement>;
}

describe("useGridScrollRestoration", () => {
    beforeEach(() => {
        // Run both restore animation frames synchronously so the restore completes inside act().
        vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
            cb(0);
            return 1;
        });
        vi.stubGlobal("cancelAnimationFrame", () => {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("restores the saved scroll position when the grid becomes visible again", () => {
        const { result, rerender } = renderHook(
            ({ visible }: { visible: boolean }) => useGridScrollRestoration(visible),
            { initialProps: { visible: true } }
        );

        const element = scrollElementAt(120);
        result.current.scrollParentRef.current = element;

        // Hiding saves the current position.
        act(() => rerender({ visible: false }));

        // Something resets the scroll while hidden.
        element.scrollTop = 0;

        // Showing again restores the saved position.
        act(() => rerender({ visible: true }));

        expect(element.scrollTop).toBe(120);
    });

    it("ignores scroll events fired while hidden so they cannot corrupt the saved position", () => {
        const { result, rerender } = renderHook(
            ({ visible }: { visible: boolean }) => useGridScrollRestoration(visible),
            { initialProps: { visible: true } }
        );

        const element = scrollElementAt(120);
        result.current.scrollParentRef.current = element;

        act(() => rerender({ visible: false }));
        element.scrollTop = 0;

        // A stray scroll while hidden must not overwrite the saved position.
        act(() => {
            result.current.onScroll(scrollEvent(999));
        });

        act(() => rerender({ visible: true }));

        expect(element.scrollTop).toBe(120);
    });
});
