import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppBootstrap } from "./use-app-bootstrap";

vi.mock("../services/database-service", () => ({
    ensureDatabaseReady: vi.fn(),
    getDatabaseBackupStatus: vi.fn(),
    restoreDatabaseFromBackup: vi.fn(),
}));

vi.mock("../utils/error-message", () => ({
    resolveErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import {
    ensureDatabaseReady,
    getDatabaseBackupStatus,
    restoreDatabaseFromBackup,
} from "../services/database-service";

describe("useAppBootstrap", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: no backup available, so failures surface as errors unless a test says
        // otherwise.
        vi.mocked(getDatabaseBackupStatus).mockResolvedValue({
            available: false,
            backedUpAtMs: null,
        });
    });

    it("initializes the database on mount", async () => {
        vi.mocked(ensureDatabaseReady).mockResolvedValueOnce(undefined);

        const onError = vi.fn();

        const { result } = renderHook(() => useAppBootstrap({ onError }));

        await waitFor(() => {
            expect(ensureDatabaseReady).toHaveBeenCalledTimes(1);
        });

        expect(onError).not.toHaveBeenCalled();
        expect(result.current.open).toBe(false);
    });

    it("reports the initialization error when no backup is available", async () => {
        vi.mocked(ensureDatabaseReady).mockRejectedValueOnce(new Error("boom"));

        const onError = vi.fn();

        renderHook(() => useAppBootstrap({ onError }));

        await waitFor(() => {
            expect(onError).toHaveBeenCalledWith("Failed to initialize app.");
        });
    });

    it("offers recovery instead of an error when a backup exists", async () => {
        vi.mocked(ensureDatabaseReady).mockRejectedValueOnce(new Error("corrupt"));
        vi.mocked(getDatabaseBackupStatus).mockResolvedValueOnce({
            available: true,
            backedUpAtMs: 1_700_000_000_000,
        });

        const onError = vi.fn();

        const { result } = renderHook(() => useAppBootstrap({ onError }));

        await waitFor(() => {
            expect(result.current.open).toBe(true);
        });

        expect(result.current.backedUpAtMs).toBe(1_700_000_000_000);
        expect(onError).not.toHaveBeenCalled();
    });

    it("restores from backup and reloads on confirmation", async () => {
        vi.mocked(ensureDatabaseReady).mockRejectedValueOnce(new Error("corrupt"));
        vi.mocked(getDatabaseBackupStatus).mockResolvedValueOnce({
            available: true,
            backedUpAtMs: 1_700_000_000_000,
        });
        vi.mocked(restoreDatabaseFromBackup).mockResolvedValueOnce(undefined);

        const reloadSpy = vi.fn();
        Object.defineProperty(window, "location", {
            configurable: true,
            value: { ...window.location, reload: reloadSpy },
        });

        const onError = vi.fn();

        const { result } = renderHook(() => useAppBootstrap({ onError }));

        await waitFor(() => {
            expect(result.current.open).toBe(true);
        });

        await act(async () => {
            await result.current.restoreFromBackup();
        });

        expect(restoreDatabaseFromBackup).toHaveBeenCalledTimes(1);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    it("reports an error when the restore fails", async () => {
        vi.mocked(ensureDatabaseReady).mockRejectedValueOnce(new Error("corrupt"));
        vi.mocked(getDatabaseBackupStatus).mockResolvedValueOnce({
            available: true,
            backedUpAtMs: null,
        });
        vi.mocked(restoreDatabaseFromBackup).mockRejectedValueOnce(
            new Error("restore failed")
        );

        const onError = vi.fn();

        const { result } = renderHook(() => useAppBootstrap({ onError }));

        await waitFor(() => {
            expect(result.current.open).toBe(true);
        });

        await act(async () => {
            await result.current.restoreFromBackup();
        });

        expect(onError).toHaveBeenCalledWith(
            "Failed to restore the database from backup."
        );
        expect(result.current.open).toBe(false);
        expect(result.current.isRestoring).toBe(false);
    });

    it("does not open recovery after unmount", async () => {
        let rejectReady: ((reason?: unknown) => void) | undefined;

        vi.mocked(ensureDatabaseReady).mockImplementationOnce(
            () =>
                new Promise<void>((_, reject) => {
                    rejectReady = reject;
                })
        );

        const onError = vi.fn();

        const { unmount } = renderHook(() => useAppBootstrap({ onError }));

        unmount();

        rejectReady?.(new Error("late failure"));

        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(onError).not.toHaveBeenCalled();
    });
});
