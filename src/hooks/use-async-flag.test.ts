import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAsyncFlag } from "./use-async-flag";

describe("useAsyncFlag", () => {
    it("starts idle", () => {
        const { result } = renderHook(() => useAsyncFlag());

        expect(result.current.isRunning).toBe(false);
    });

    it("sets running during async execution and resets after finish", async () => {
        let resolveTask: (() => void) | null = null;

        const task = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveTask = resolve;
                })
        );

        const { result } = renderHook(() => useAsyncFlag());

        let pendingPromise: Promise<void | undefined> | undefined;

        await act(async () => {
            pendingPromise = result.current.runWithFlag(task);
        });

        expect(result.current.isRunning).toBe(true);
        expect(task).toHaveBeenCalledTimes(1);

        await act(async () => {
            resolveTask?.();
            await pendingPromise;
        });

        expect(result.current.isRunning).toBe(false);
    });

    it("returns undefined when already running", async () => {
        let resolveTask: (() => void) | null = null;

        const firstTask = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveTask = resolve;
                })
        );

        const secondTask = vi.fn(async () => {});

        const { result } = renderHook(() => useAsyncFlag());

        let firstPromise: Promise<void | undefined> | undefined;
        let secondResult: void | undefined;

        await act(async () => {
            firstPromise = result.current.runWithFlag(firstTask);
        });

        expect(result.current.isRunning).toBe(true);

        await act(async () => {
            secondResult = await result.current.runWithFlag(secondTask);
        });

        expect(secondTask).not.toHaveBeenCalled();
        expect(secondResult).toBeUndefined();

        await act(async () => {
            resolveTask?.();
            await firstPromise;
        });

        expect(result.current.isRunning).toBe(false);
    });

    it("resets running flag after failure", async () => {
        const { result } = renderHook(() => useAsyncFlag());

        await expect(
            act(async () => {
                await result.current.runWithFlag(async () => {
                    throw new Error("boom");
                });
            })
        ).rejects.toThrow("boom");

        expect(result.current.isRunning).toBe(false);
    });

    it("allows external reset", async () => {
        const { result } = renderHook(() => useAsyncFlag());

        await act(async () => {
            result.current.resetFlag();
        });

        expect(result.current.isRunning).toBe(false);
    });

    it("allows a new call to run immediately after resetting while a task is still pending", async () => {
        let resolveTask: () => void = () => {};

        const firstTask = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveTask = resolve;
                })
        );

        const secondTask = vi.fn(async () => {});

        const { result } = renderHook(() => useAsyncFlag());

        await act(async () => {
            void result.current.runWithFlag(firstTask);
        });

        expect(result.current.isRunning).toBe(true);

        await act(async () => {
            result.current.resetFlag();
        });

        expect(result.current.isRunning).toBe(false);

        await act(async () => {
            await result.current.runWithFlag(secondTask);
        });

        expect(secondTask).toHaveBeenCalledTimes(1);

        resolveTask();
    });

    it("allows a second sequential call to run the task once the first one has finished", async () => {
        const firstTask = vi.fn(async () => {});
        const secondTask = vi.fn(async () => {});

        const { result } = renderHook(() => useAsyncFlag());

        await act(async () => {
            await result.current.runWithFlag(firstTask);
        });

        expect(firstTask).toHaveBeenCalledTimes(1);
        expect(result.current.isRunning).toBe(false);

        await act(async () => {
            await result.current.runWithFlag(secondTask);
        });

        expect(secondTask).toHaveBeenCalledTimes(1);
    });

    it("keeps stable references for runWithFlag and resetFlag across rerenders", () => {
        const { result, rerender } = renderHook(() => useAsyncFlag());

        const firstRunWithFlag = result.current.runWithFlag;
        const firstResetFlag = result.current.resetFlag;

        rerender();

        expect(result.current.runWithFlag).toBe(firstRunWithFlag);
        expect(result.current.resetFlag).toBe(firstResetFlag);
    });
});