import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppBootstrap } from "./use-app-bootstrap";

vi.mock("../lib/db", () => ({
    getDb: vi.fn(),
}));

vi.mock("../utils/error-message", () => ({
    resolveErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

import { getDb } from "../lib/db";

describe("useAppBootstrap", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("initializes db on mount", async () => {
        vi.mocked(getDb).mockResolvedValueOnce({} as Awaited<ReturnType<typeof getDb>>);

        const onError = vi.fn();

        renderHook(() =>
            useAppBootstrap({
                onError,
            })
        );

        await waitFor(() => {
            expect(getDb).toHaveBeenCalledTimes(1);
        });

        expect(onError).not.toHaveBeenCalled();
    });

    it("reports initialization error", async () => {
        vi.mocked(getDb).mockRejectedValueOnce(new Error("boom"));
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        const onError = vi.fn();

        renderHook(() =>
            useAppBootstrap({
                onError,
            })
        );

        await waitFor(() => {
            expect(onError).toHaveBeenCalledWith("Failed to initialize app.");
        });

        expect(consoleErrorSpy).toHaveBeenCalled();
        consoleErrorSpy.mockRestore();
    });

    it("does not call onError after unmount", async () => {
        let rejectDb: ((reason?: unknown) => void) | undefined;

        vi.mocked(getDb).mockImplementationOnce(
            () =>
                new Promise<Awaited<ReturnType<typeof getDb>>>((_, reject) => {
                    rejectDb = reject;
                })
        );

        const onError = vi.fn();

        const { unmount } = renderHook(() =>
            useAppBootstrap({
                onError,
            })
        );

        unmount();

        rejectDb?.(new Error("late failure"));

        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(onError).not.toHaveBeenCalled();
    });
});