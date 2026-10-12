import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    type DatabaseStatus,
    useAppBootstrap,
    useStartupErrorGate,
} from "./use-app-bootstrap";

vi.mock("../services/database-service", () => ({
    ensureDatabaseReady: vi.fn(),
    getDatabaseBackupStatus: vi.fn(),
    restoreDatabaseFromBackup: vi.fn(),
    startWithEmptyDatabase: vi.fn(),
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
    startWithEmptyDatabase,
    type DatabaseBackupStatus,
} from "../services/database-service";
import { logError } from "../utils/app-logger";

describe("useAppBootstrap", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default. No backup available, so failures surface as errors unless a test says
        // otherwise.
        vi.mocked(getDatabaseBackupStatus).mockResolvedValue({
            available: false,
            backedUpAtMs: null,
            totalBytes: 0,
            formattedTotalSize: "0 B",
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

        await waitFor(() => {
            expect(result.current.databaseStatus).toBe("ready");
        });
    });

    it("reports the database check failed when it does", async () => {
        vi.mocked(ensureDatabaseReady).mockRejectedValueOnce(new Error("boom"));

        // Hoisted, since a new callback identity runs the check again.
        const onError = vi.fn();
        const { result } = renderHook(() => useAppBootstrap({ onError }));

        expect(result.current.databaseStatus).toBe("pending");

        await waitFor(() => {
            expect(result.current.databaseStatus).toBe("failed");
        });
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
        // A database created by a newer build fails to open but is not corrupt. The recovery
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

    it("does not offer a restore for a database another program is holding", async () => {
        // The file could not be read at all, which says nothing about its contents. A restore
        // would replace a database that may be fine with a snapshot up to a day old.
        vi.mocked(ensureDatabaseReady).mockRejectedValueOnce({
            code: "DATABASE_UNAVAILABLE",
            message: "the database could not be read",
        });

        const onError = vi.fn();
        const { result } = renderHook(() => useAppBootstrap({ onError }));

        // resolveErrorMessage is mocked to its fallback here. The catalogued sentence for this
        // code lives in utils/user-friendly-error.ts and is checked there.
        await waitFor(() => {
            expect(onError).toHaveBeenCalledWith("Kavynex could not read its database.");
        });

        expect(getDatabaseBackupStatus).not.toHaveBeenCalled();
        expect(result.current.open).toBe(false);
    });

    it("does not offer a restore when an upgrade of the database could not run", async () => {
        // The database was left as it was, usually for lack of disk space. A restore would put
        // back a snapshot up to a day old that fails the same upgrade.
        vi.mocked(ensureDatabaseReady).mockRejectedValueOnce({
            code: "DATABASE_MIGRATION_BLOCKED",
            message: "could not snapshot the database before a pending schema migration",
        });

        const onError = vi.fn();
        const { result } = renderHook(() => useAppBootstrap({ onError }));

        await waitFor(() => {
            expect(onError).toHaveBeenCalledWith("Kavynex could not upgrade its database.");
        });

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
            totalBytes: 2048,
            formattedTotalSize: "2.00 KB",
        });

        const onError = vi.fn();

        const { result } = renderHook(() => useAppBootstrap({ onError }));

        await waitFor(() => {
            expect(result.current.open).toBe(true);
        });

        expect(result.current.backedUpAtMs).toBe(1_700_000_000_000);
        expect(onError).not.toHaveBeenCalled();
    });

    it("offers the restore or a fresh start when the database file is missing", async () => {
        vi.mocked(ensureDatabaseReady).mockRejectedValueOnce({
            code: "DATABASE_MISSING",
            message: "the database file is missing, but backups of it are still there",
        });
        vi.mocked(getDatabaseBackupStatus).mockResolvedValueOnce({
            available: true,
            backedUpAtMs: 1_700_000_000_000,
            totalBytes: 2048,
            formattedTotalSize: "2.00 KB",
        });
        vi.mocked(startWithEmptyDatabase).mockResolvedValueOnce(undefined);

        const reloadSpy = vi.fn();
        Object.defineProperty(window, "location", {
            configurable: true,
            value: { ...window.location, reload: reloadSpy },
        });

        const { result } = renderHook(() => useAppBootstrap({ onError: vi.fn() }));

        await waitFor(() => {
            expect(result.current.open).toBe(true);
        });

        expect(result.current.reason).toBe("missing");
        expect(result.current.confirmingStartEmpty).toBe(false);

        act(() => {
            result.current.askToStartEmpty();
        });
        expect(result.current.confirmingStartEmpty).toBe(true);

        act(() => {
            result.current.cancelStartEmpty();
        });
        expect(result.current.confirmingStartEmpty).toBe(false);

        await act(async () => {
            await result.current.startEmpty();
        });

        expect(startWithEmptyDatabase).toHaveBeenCalledTimes(1);
        expect(restoreDatabaseFromBackup).not.toHaveBeenCalled();
        expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    it("calls a database that would not open damaged", async () => {
        vi.mocked(ensureDatabaseReady).mockRejectedValueOnce(new Error("corrupt"));
        vi.mocked(getDatabaseBackupStatus).mockResolvedValueOnce({
            available: true,
            backedUpAtMs: 1_700_000_000_000,
            totalBytes: 2048,
            formattedTotalSize: "2.00 KB",
        });

        const { result } = renderHook(() => useAppBootstrap({ onError: vi.fn() }));

        await waitFor(() => {
            expect(result.current.open).toBe(true);
        });

        expect(result.current.reason).toBe("damaged");
    });

    it("restores from backup and reloads on confirmation", async () => {
        vi.mocked(ensureDatabaseReady).mockRejectedValueOnce(new Error("corrupt"));
        vi.mocked(getDatabaseBackupStatus).mockResolvedValueOnce({
            available: true,
            backedUpAtMs: 1_700_000_000_000,
            totalBytes: 2048,
            formattedTotalSize: "2.00 KB",
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
            totalBytes: 1024,
            formattedTotalSize: "1.00 KB",
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
        // Kept open so the restore can be tried again without restarting.
        expect(result.current.open).toBe(true);
        expect(result.current.isRestoring).toBe(false);
    });

    it("marks isRestoring while the restore is in flight", async () => {
        vi.mocked(ensureDatabaseReady).mockRejectedValueOnce(new Error("corrupt"));
        vi.mocked(getDatabaseBackupStatus).mockResolvedValueOnce({
            available: true,
            backedUpAtMs: 1_700_000_000_000,
            totalBytes: 2048,
            formattedTotalSize: "2.00 KB",
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
            totalBytes: 2048,
            formattedTotalSize: "2.00 KB",
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

        let resolveStatus: ((value: DatabaseBackupStatus) => void) | undefined;

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

        resolveStatus?.({
            available: false,
            backedUpAtMs: null,
            totalBytes: 0,
            formattedTotalSize: "0 B",
        });

        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(onError).not.toHaveBeenCalled();
    });
});

describe("useStartupErrorGate", () => {
    function renderGate(initial: DatabaseStatus) {
        const onError = vi.fn();
        const hook = renderHook(
            ({ status }: { status: DatabaseStatus }) => useStartupErrorGate(onError, status),
            { initialProps: { status: initial } }
        );

        return { onError, ...hook };
    }

    it("holds an error until the database check succeeds, then shows it", () => {
        const { onError, result, rerender } = renderGate("pending");

        result.current("Failed to load channels.");

        expect(onError).not.toHaveBeenCalled();

        rerender({ status: "ready" });

        expect(onError).toHaveBeenCalledWith("Failed to load channels.");
    });

    it("drops what it held when the database check fails", () => {
        // The bootstrap's own message, or the recovery dialog, says what is wrong. The loads that
        // failed beside it only repeat it under other names.
        const { onError, result, rerender } = renderGate("pending");

        result.current("Failed to load channels.");
        result.current("Failed to prepare app settings.");
        rerender({ status: "failed" });

        expect(onError).not.toHaveBeenCalled();
    });

    it("passes errors straight through once the check has settled", () => {
        const { onError, result } = renderGate("failed");

        result.current("Failed to update channel.");

        expect(onError).toHaveBeenCalledWith("Failed to update channel.");
    });
});
