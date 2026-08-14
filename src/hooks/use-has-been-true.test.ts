import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useHasBeenTrue } from "./use-has-been-true";

describe("useHasBeenTrue", () => {
    it("is false until the value is first true", () => {
        const { result, rerender } = renderHook(({ value }) => useHasBeenTrue(value), {
            initialProps: { value: false },
        });

        expect(result.current).toBe(false);

        rerender({ value: false });

        expect(result.current).toBe(false);
    });

    it("turns true on the render where the value is true", () => {
        // Not on the render after it: the render that opens a modal is the one that has to mount
        // it, so a latch that lagged by one commit would leave the first open showing nothing.
        const { result } = renderHook(({ value }) => useHasBeenTrue(value), {
            initialProps: { value: true },
        });

        expect(result.current).toBe(true);
    });

    it("stays true after the value goes false again", () => {
        // The whole reason this is not `{opened && ...}`. Closing a modal must not unmount it:
        // that cuts its own exit transition, so it vanishes instead of fading, and discards a
        // chunk that is already loaded.
        const { result, rerender } = renderHook(({ value }) => useHasBeenTrue(value), {
            initialProps: { value: false },
        });

        rerender({ value: true });
        expect(result.current).toBe(true);

        rerender({ value: false });
        expect(result.current).toBe(true);

        rerender({ value: false });
        expect(result.current).toBe(true);
    });

    it("latches per hook instance rather than across them", () => {
        // A ref, not module state, two modals must not mount each other. Worth pinning because the
        // failure would be invisible in the app (mounting one modal early is not observable) and
        // would silently undo the split for whichever one opened second.
        const first = renderHook(({ value }) => useHasBeenTrue(value), {
            initialProps: { value: true },
        });
        const second = renderHook(({ value }) => useHasBeenTrue(value), {
            initialProps: { value: false },
        });

        expect(first.result.current).toBe(true);
        expect(second.result.current).toBe(false);
    });
});
