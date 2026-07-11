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
import { logError } from "../utils/app-logger";

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

        expect(result.current.isRestoring).toBe(false);

        await waitFor(() => {
            expect(ensureDatabaseReady).toHaveBeenCalledTimes(1);
        });

        expect(onError).not.toHaveBeenCalled();
        expect(result.current.open).toBe(false);
    });

    it("reports the initialization error when no backup is available", async () => {
        const error = new Error("boom");
        vi.mocked(ensureDatabaseReady).mockRejectedValueOnce(error);

        const onError = vi.fn();

        renderHook(() => useAppBootstrap({ onError }));

        await waitFor(() => {
            expect(onError).toHaveBeenCalledWith("Failed to initialize app.");
        });

        expect(logError).toHaveBeenCalledWith(
            "bootstrap",
            "Failed to initialize app.",
            error
        );
    });

    it("advises updating instead of offering recovery when the schema is too new", async () => {
        // A database created by a newer build fails to open but is not corrupt: the recovery
        // flow (which would restore an older backup) must be skipped in favor of a clear message.
        vi.mocked(ensureDatabaseReady).mockRejectedValueOnce({
            code: "DATABASE_SCHEMA_TOO_NEW",
            message: "database was created by a newer version of the app",
        });

        const onError = vi.fn();

        const { result } = renderHook(() => useAppBootstrap({ onError }));

        await waitFor(() => {
            expect(onError).toHaveBeenCalledWith(
                "This library was created by a newer version of Kavynex. Update Kavynex to open it."
            );
        });

        // No backup restore is offered for a version mismatch.
        expect(getDatabaseBackupStatus).not.toHaveBeenCalled();
        expect(result.current.open).toBe(false);
    });

    it("logs and swallows the error when the backup status check itself fails", async () => {
        const readyError = new Error("boom");
        const statusError = new Error("status check failed");

        vi.mocked(ensureDatabaseReady).mockRejectedValueOnce(readyError);
        vi.mocked(getDatabaseBackupStatus).mockRejectedValueOnce(statusError);

        const onError = vi.fn();

        renderHook(() => useAppBootstrap({ onError }));

        await waitFor(() => {
            expect(onError).toHaveBeenCalledWith("Failed to initialize app.");
        });

        expect(logError).toHaveBeenCalledWith(
            "bootstrap",
            "Failed to read database backup status.",
            statusError
        );
    });

    it("reinitializes the database when the onError callback changes", async () => {
        vi.mocked(ensureDatabaseReady).mockResolvedValue(undefined);

        const onError1 = vi.fn();

        const { rerender } = renderHook(
            (props: { onError: (message: string) => void }) => useAppBootstrap(props),
            { initialProps: { onError: onError1 } }
        );

        await waitFor(() => {
            expect(ensureDatabaseReady).toHaveBeenCalledTimes(1);
        });

        const onError2 = vi.fn();
        rerender({ onError: onError2 });

        await waitFor(() => {
            expect(ensureDatabaseReady).toHaveBeenCalledTimes(2);
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
        const restoreError = new Error("restore failed");
        vi.mocked(restoreDatabaseFromBackup).mockRejectedValueOnce(restoreError);

        const onError = vi.fn();

        const { result } = renderHook(() => useAppBootstrap({ onError }));

        await waitFor(() => {
            expect(result.current.open).toBe(true);
        });

        await act(async () => {
            await result.current.restoreFromBackup();
        });

        expect(logError).toHaveBeenCalledWith(
            "bootstrap",
            "Failed to restore database from backup.",
            restoreError
        );
        expect(onError).toHaveBeenCalledWith(
            "Failed to restore the database from backup."
        );
        expect(result.current.open).toBe(false);
        expect(result.current.isRestoring).toBe(false);
    });

    it("marks isRestoring while the restore is in flight", async () => {
        vi.mocked(ensureDatabaseReady).mockRejectedValueOnce(new Error("corrupt"));
        vi.mocked(getDatabaseBackupStatus).mockResolvedValueOnce({
            available: true,
            backedUpAtMs: 1_700_000_000_000,
        });

        let resolveRestore: (() => void) | undefined;
        vi.mocked(restoreDatabaseFromBackup).mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveRestore = resolve;
                })
        );

        const onError = vi.fn();

        const { result } = renderHook(() => useAppBootstrap({ onError }));

        await waitFor(() => {
            expect(result.current.open).toBe(true);
        });

        act(() => {
            void result.current.restoreFromBackup();
        });

        await waitFor(() => {
            expect(result.current.isRestoring).toBe(true);
        });

        await act(async () => {
            resolveRestore?.();
            await Promise.resolve();
        });
    });

    it("recreates restoreFromBackup when the onError callback changes", async () => {
        vi.mocked(ensureDatabaseReady).mockResolvedValue(undefined);

        const onError1 = vi.fn();

        const { result, rerender } = renderHook(
            (props: { onError: (message: string) => void }) => useAppBootstrap(props),
            { initialProps: { onError: onError1 } }
        );

        const firstRestoreFromBackup = result.current.restoreFromBackup;

        const onError2 = vi.fn();
        rerender({ onError: onError2 });

        expect(result.current.restoreFromBackup).not.toBe(firstRestoreFromBackup);
    });

    it("dismisses the recovery dialog", async () => {
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

        act(() => {
            result.current.dismiss();
        });

        expect(result.current.open).toBe(false);
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
        expect(getDatabaseBackupStatus).not.toHaveBeenCalled();
    });

    it("does not surface an error for a backup-status check settled after unmount", async () => {
        vi.mocked(ensureDatabaseReady).mockRejectedValueOnce(new Error("boom"));

        let resolveStatus:
            | ((value: { available: boolean; backedUpAtMs: number | null }) => void)
            | undefined;

        vi.mocked(getDatabaseBackupStatus).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveStatus = resolve;
                })
        );

        const onError = vi.fn();

        const { unmount } = renderHook(() => useAppBootstrap({ onError }));

        await waitFor(() => {
            expect(getDatabaseBackupStatus).toHaveBeenCalledTimes(1);
        });

        unmount();

        resolveStatus?.({ available: false, backedUpAtMs: null });

        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(onError).not.toHaveBeenCalled();
    });
});
