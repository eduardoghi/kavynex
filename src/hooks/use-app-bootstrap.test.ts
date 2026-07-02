import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppBootstrap } from "./use-app-bootstrap";

vi.mock("../services/database-service", () => ({
    ensureDatabaseReady: vi.fn(),
}));

vi.mock("../utils/error-message", () => ({
    resolveErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

import { ensureDatabaseReady } from "../services/database-service";

describe("useAppBootstrap", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("initializes the database on mount", async () => {
        vi.mocked(ensureDatabaseReady).mockResolvedValueOnce(undefined);

        const onError = vi.fn();

        renderHook(() =>
            useAppBootstrap({
                onError,
            })
        );

        await waitFor(() => {
            expect(ensureDatabaseReady).toHaveBeenCalledTimes(1);
        });

        expect(onError).not.toHaveBeenCalled();
    });

    it("reports initialization error", async () => {
        vi.mocked(ensureDatabaseReady).mockRejectedValueOnce(new Error("boom"));
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
        let rejectReady: ((reason?: unknown) => void) | undefined;

        vi.mocked(ensureDatabaseReady).mockImplementationOnce(
            () =>
                new Promise<void>((_, reject) => {
                    rejectReady = reject;
                })
        );

        const onError = vi.fn();

        const { unmount } = renderHook(() =>
            useAppBootstrap({
                onError,
            })
        );

        unmount();

        rejectReady?.(new Error("late failure"));

        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(onError).not.toHaveBeenCalled();
    });
});
