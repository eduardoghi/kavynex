import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePerIdAsyncFlag } from "./use-per-id-async-flag";

// A task whose resolution the test controls, so an id can be held in flight across assertions.
function deferredTask(): { task: () => Promise<void>; resolve: () => void } {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });

    return { task: () => promise, resolve };
}

describe("usePerIdAsyncFlag", () => {
    it("starts with nothing in flight", () => {
        const { result } = renderHook(() => usePerIdAsyncFlag());

        expect(result.current.inFlight.size).toBe(0);
        expect(result.current.isRunning).toBe(false);
    });

    it("marks only the id it was given as in flight", async () => {
        const first = deferredTask();

        const { result } = renderHook(() => usePerIdAsyncFlag());

        await act(async () => {
            void result.current.runFor(7, first.task);
        });

        expect(result.current.inFlight.has(7)).toBe(true);
        expect(result.current.inFlight.has(8)).toBe(false);
        expect(result.current.isRunning).toBe(true);

        await act(async () => {
            first.resolve();
        });

        expect(result.current.inFlight.size).toBe(0);
        expect(result.current.isRunning).toBe(false);
    });

    it("lets a different id run while one is still in flight", async () => {
        // This is the whole reason the hook exists rather than reusing `useAsyncFlag`: a shared
        // boolean would swallow the second row's action, and the user cannot tell a swallowed
        // action apart from one that worked.
        const held = deferredTask();
        const other = vi.fn(async () => {});

        const { result } = renderHook(() => usePerIdAsyncFlag());

        await act(async () => {
            void result.current.runFor(1, held.task);
        });

        await act(async () => {
            await result.current.runFor(2, other);
        });

        expect(other).toHaveBeenCalledTimes(1);
        expect(result.current.inFlight.has(1)).toBe(true);

        await act(async () => {
            held.resolve();
        });

        expect(result.current.inFlight.size).toBe(0);
    });

    it("ignores a second call for an id that is already in flight", async () => {
        // The guard reads a ref rather than the state for exactly this: two calls landing in the
        // same tick would both see the pre-update state and both get through.
        const held = deferredTask();
        const duplicate = vi.fn(async () => {});

        const { result } = renderHook(() => usePerIdAsyncFlag());

        await act(async () => {
            void result.current.runFor(5, held.task);
        });

        await act(async () => {
            await result.current.runFor(5, duplicate);
        });

        expect(duplicate).not.toHaveBeenCalled();

        await act(async () => {
            held.resolve();
        });
    });

    it("refuses a duplicate started in the same tick, before any state has been committed", async () => {
        // The stronger form of the case above, and the one a state-based guard fails: both calls are
        // made synchronously, so no render has run in between and the state set is still empty when
        // the second one checks.
        const first = vi.fn(async () => {});
        const second = vi.fn(async () => {});

        const { result } = renderHook(() => usePerIdAsyncFlag());

        await act(async () => {
            await Promise.all([result.current.runFor(3, first), result.current.runFor(3, second)]);
        });

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();
    });

    it("clears the id when the task rejects, and lets it be retried", async () => {
        // A failing action has to free its row. Without the `finally`, one failed delete would leave
        // that row permanently disabled with no way back short of a reload.
        const { result } = renderHook(() => usePerIdAsyncFlag());

        await expect(
            act(async () => {
                await result.current.runFor(9, async () => {
                    throw new Error("boom");
                });
            })
        ).rejects.toThrow("boom");

        expect(result.current.inFlight.has(9)).toBe(false);

        const retry = vi.fn(async () => {});

        await act(async () => {
            await result.current.runFor(9, retry);
        });

        expect(retry).toHaveBeenCalledTimes(1);
    });

    it("keeps runFor stable across rerenders", () => {
        // Consumers thread this into memoized rows; a new identity per render would re-render the
        // virtualized grid this hook is used from.
        const { result, rerender } = renderHook(() => usePerIdAsyncFlag());

        const firstRunFor = result.current.runFor;

        rerender();

        expect(result.current.runFor).toBe(firstRunFor);
    });

    it("exposes a new set identity per change, so a consumer re-renders on it", async () => {
        // The state set is copied on every mutation rather than mutated in place. A consumer
        // comparing it by reference (which `memo` does) would otherwise never see a row go busy.
        const held = deferredTask();

        const { result } = renderHook(() => usePerIdAsyncFlag());

        const empty = result.current.inFlight;

        await act(async () => {
            void result.current.runFor(4, held.task);
        });

        expect(result.current.inFlight).not.toBe(empty);

        await act(async () => {
            held.resolve();
        });
    });
});
