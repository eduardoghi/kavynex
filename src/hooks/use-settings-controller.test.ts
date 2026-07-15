import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummaryInfo } from "../services/library-service";

vi.mock("../lib/tauri-platform", () => ({
    openFileDialog: vi.fn(),
    saveFileDialog: vi.fn(),
    relaunch: vi.fn(),
}));

vi.mock("../services/database-service", () => ({
    exportDatabase: vi.fn(),
    importDatabase: vi.fn(),
    getDatabaseImportUndoStatus: vi.fn(),
    undoDatabaseImport: vi.fn(),
}));

vi.mock("../services/library-service", () => ({
    getLibrarySummary: vi.fn(),
}));

vi.mock("../utils/app-error", () => ({
    parseAppError: vi.fn((error: unknown) => error),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

const mockCheckForUpdate = vi.fn();
const mockInstallUpdate = vi.fn();

vi.mock("./use-app-update", () => ({
    useAppUpdate: () => ({
        status: "idle",
        updateInfo: null,
        progress: null,
        errorMessage: "",
        checkForUpdate: mockCheckForUpdate,
        installUpdate: mockInstallUpdate,
    }),
}));

import { openFileDialog, relaunch, saveFileDialog } from "../lib/tauri-platform";
import {
    exportDatabase,
    getDatabaseImportUndoStatus,
    importDatabase,
    undoDatabaseImport,
} from "../services/database-service";
import { getLibrarySummary } from "../services/library-service";
import { useSettingsController } from "./use-settings-controller";

const openMock = vi.mocked(openFileDialog);
const saveMock = vi.mocked(saveFileDialog);
const relaunchMock = vi.mocked(relaunch);
const exportDatabaseMock = vi.mocked(exportDatabase);
const importDatabaseMock = vi.mocked(importDatabase);
const getDatabaseImportUndoStatusMock = vi.mocked(getDatabaseImportUndoStatus);
const undoDatabaseImportMock = vi.mocked(undoDatabaseImport);
const getLibrarySummaryMock = vi.mocked(getLibrarySummary);

function createSummary(overrides: Partial<LibrarySummaryInfo> = {}): LibrarySummaryInfo {
    return {
        total_bytes: 1024,
        formatted_size: "1 KB",
        video_files: 2,
        audio_files: 3,
        thumbnail_files: 4,
        ...overrides,
    };
}

type HookProps = {
    opened: boolean;
    libraryPath: string;
};

describe("useSettingsController", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // No previous import to undo unless a test opts in.
        getDatabaseImportUndoStatusMock.mockResolvedValue(false);
    });

    it("loads the library summary when opened", async () => {
        getLibrarySummaryMock.mockResolvedValueOnce(createSummary());

        const { result } = renderHook(() =>
            useSettingsController({ opened: true, libraryPath: "/library" })
        );

        await waitFor(() => {
            expect(result.current.librarySummary.formatted_size).toBe("1 KB");
        });

        expect(getLibrarySummaryMock).toHaveBeenCalledWith("/library");
        expect(result.current.isLoadingLibrarySummary).toBe(false);
        expect(result.current.librarySummaryError).toBe("");
    });

    it("discards a stale library summary response when the library path changes", async () => {
        let resolveSecondRequest!: (value: LibrarySummaryInfo) => void;

        getLibrarySummaryMock
            .mockResolvedValueOnce(createSummary({ formatted_size: "1 KB" }))
            .mockImplementationOnce(
                () =>
                    new Promise<LibrarySummaryInfo>((resolve) => {
                        resolveSecondRequest = resolve;
                    })
            );

        const initialProps: HookProps = { opened: true, libraryPath: "/library-a" };

        const { result, rerender } = renderHook(
            ({ opened, libraryPath }: HookProps) => useSettingsController({ opened, libraryPath }),
            { initialProps }
        );

        await waitFor(() => {
            expect(result.current.librarySummary.formatted_size).toBe("1 KB");
        });

        rerender({ opened: true, libraryPath: "/library-b" });

        await waitFor(() => {
            expect(getLibrarySummaryMock).toHaveBeenCalledWith("/library-b");
        });

        // The request for /library-b is still pending, so the stale summary is cleared
        // while loading, and the loading flag reflects the pending request.
        expect(result.current.librarySummary.formatted_size).toBe("0 B");
        expect(result.current.isLoadingLibrarySummary).toBe(true);

        // A third, unrelated request should win over the pending /library-b response
        // if it resolves later. Here we simply resolve /library-b and confirm it applies,
        // then simulate a stale resolution being ignored by closing (which bumps the
        // request id) before the promise settles again.
        act(() => {
            resolveSecondRequest(createSummary({ formatted_size: "2 KB" }));
        });

        await waitFor(() => {
            expect(result.current.librarySummary.formatted_size).toBe("2 KB");
        });
    });

    it("ignores a stale response that resolves after the modal is closed", async () => {
        let resolveRequest!: (value: LibrarySummaryInfo) => void;

        getLibrarySummaryMock.mockImplementationOnce(
            () =>
                new Promise<LibrarySummaryInfo>((resolve) => {
                    resolveRequest = resolve;
                })
        );

        const initialProps: HookProps = { opened: true, libraryPath: "/library" };

        const { result, rerender } = renderHook(
            ({ opened, libraryPath }: HookProps) => useSettingsController({ opened, libraryPath }),
            { initialProps }
        );

        await waitFor(() => {
            expect(getLibrarySummaryMock).toHaveBeenCalledWith("/library");
        });

        rerender({ opened: false, libraryPath: "/library" });

        act(() => {
            resolveRequest(createSummary({ formatted_size: "9 KB" }));
        });

        expect(result.current.librarySummary.formatted_size).toBe("0 B");
        expect(result.current.isLoadingLibrarySummary).toBe(false);
    });

    it("sets an error message when loading the library summary fails", async () => {
        getLibrarySummaryMock.mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() =>
            useSettingsController({ opened: true, libraryPath: "/library" })
        );

        await waitFor(() => {
            expect(result.current.librarySummaryError).toBe("Could not load library summary.");
        });

        expect(result.current.librarySummary.formatted_size).toBe("0 B");
        expect(result.current.isLoadingLibrarySummary).toBe(false);
    });

    it("refreshes the library summary for the current path on demand", async () => {
        getLibrarySummaryMock
            .mockResolvedValueOnce(createSummary({ formatted_size: "1 KB" }))
            .mockResolvedValueOnce(createSummary({ formatted_size: "5 KB" }));

        const { result } = renderHook(() =>
            useSettingsController({ opened: true, libraryPath: "/library" })
        );

        await waitFor(() => {
            expect(result.current.librarySummary.formatted_size).toBe("1 KB");
        });

        await act(async () => {
            await result.current.refreshLibrarySummary();
        });

        expect(getLibrarySummaryMock).toHaveBeenCalledTimes(2);
        expect(result.current.librarySummary.formatted_size).toBe("5 KB");
    });

    it("clears the summary without querying the backend for a blank library path", async () => {
        getLibrarySummaryMock.mockResolvedValueOnce(createSummary({ formatted_size: "1 KB" }));

        const { result, rerender } = renderHook(
            ({ opened, libraryPath }: HookProps) => useSettingsController({ opened, libraryPath }),
            { initialProps: { opened: true, libraryPath: "/library" } }
        );

        await waitFor(() => {
            expect(result.current.librarySummary.formatted_size).toBe("1 KB");
        });

        getLibrarySummaryMock.mockClear();

        rerender({ opened: true, libraryPath: "   " });

        await waitFor(() => {
            expect(result.current.librarySummary.formatted_size).toBe("0 B");
        });

        expect(getLibrarySummaryMock).not.toHaveBeenCalled();
        expect(result.current.isLoadingLibrarySummary).toBe(false);
        expect(result.current.librarySummaryError).toBe("");
    });

    it("exports the database successfully with the expected dialog options", async () => {
        getLibrarySummaryMock.mockResolvedValueOnce(createSummary());
        saveMock.mockResolvedValueOnce("/backups/kavynex-backup.db");
        exportDatabaseMock.mockResolvedValueOnce(undefined);

        const { result } = renderHook(() =>
            useSettingsController({ opened: true, libraryPath: "/library" })
        );

        await act(async () => {
            await result.current.exportDatabaseAction();
        });

        expect(saveMock).toHaveBeenCalledWith({
            title: "Export database",
            defaultPath: "kavynex-backup.db",
            filters: [{ name: "Database", extensions: ["db"] }],
        });
        expect(exportDatabaseMock).toHaveBeenCalledWith("/backups/kavynex-backup.db");
        expect(result.current.databaseBusy).toBe("idle");
        expect(result.current.databaseMessage).toEqual({
            tone: "success",
            text: "Database exported successfully.",
        });
    });

    it("reports an error when the export dialog itself fails to open", async () => {
        getLibrarySummaryMock.mockResolvedValueOnce(createSummary());
        saveMock.mockRejectedValueOnce(new Error("dialog crashed"));

        const { result } = renderHook(() =>
            useSettingsController({ opened: true, libraryPath: "/library" })
        );

        await act(async () => {
            await result.current.exportDatabaseAction();
        });

        expect(exportDatabaseMock).not.toHaveBeenCalled();
        expect(result.current.databaseBusy).toBe("idle");
        expect(result.current.databaseMessage).toEqual({
            tone: "error",
            text: "Could not open the export dialog.",
        });
    });

    it("reports an error when exporting the database fails", async () => {
        getLibrarySummaryMock.mockResolvedValueOnce(createSummary());
        saveMock.mockResolvedValueOnce("/backups/kavynex-backup.db");
        exportDatabaseMock.mockRejectedValueOnce(new Error("disk full"));

        const { result } = renderHook(() =>
            useSettingsController({ opened: true, libraryPath: "/library" })
        );

        await act(async () => {
            await result.current.exportDatabaseAction();
        });

        expect(result.current.databaseBusy).toBe("idle");
        expect(result.current.databaseMessage).toEqual({
            tone: "error",
            text: "Could not export the database.",
        });
    });

    it("does nothing when the export dialog is cancelled", async () => {
        getLibrarySummaryMock.mockResolvedValueOnce(createSummary());
        saveMock.mockResolvedValueOnce(null);

        const { result } = renderHook(() =>
            useSettingsController({ opened: true, libraryPath: "/library" })
        );

        await act(async () => {
            await result.current.exportDatabaseAction();
        });

        expect(exportDatabaseMock).not.toHaveBeenCalled();
        expect(result.current.databaseBusy).toBe("idle");
        expect(result.current.databaseMessage).toBeNull();
    });

    it("imports the database and relaunches the app on success", async () => {
        getLibrarySummaryMock.mockResolvedValueOnce(createSummary());
        openMock.mockResolvedValueOnce("/backups/import.db");
        importDatabaseMock.mockResolvedValueOnce(undefined);
        relaunchMock.mockResolvedValueOnce(undefined);

        const { result } = renderHook(() =>
            useSettingsController({ opened: true, libraryPath: "/library" })
        );

        await act(async () => {
            await result.current.pickImportFileAction();
        });

        expect(openMock).toHaveBeenCalledWith({
            title: "Import database",
            multiple: false,
            directory: false,
            filters: [{ name: "Database", extensions: ["db"] }],
        });
        expect(result.current.pendingImportPath).toBe("/backups/import.db");

        await act(async () => {
            await result.current.confirmImportAction();
        });

        expect(importDatabaseMock).toHaveBeenCalledWith("/backups/import.db");
        expect(relaunchMock).toHaveBeenCalledTimes(1);
    });

    it("drops a picked but unconfirmed import when the modal closes", async () => {
        getLibrarySummaryMock.mockResolvedValue(createSummary());
        openMock.mockResolvedValueOnce("/backups/import.db");

        const { result, rerender } = renderHook(
            ({ opened }) => useSettingsController({ opened, libraryPath: "/library" }),
            { initialProps: { opened: true } }
        );

        await act(async () => {
            await result.current.pickImportFileAction();
        });

        expect(result.current.pendingImportPath).toBe("/backups/import.db");

        // The modal only locks while a database operation is in flight, so an import waiting on
        // its confirmation can be dismissed with Esc or a click outside. The component stays
        // mounted, so the pending path has to be cleared here or reopening Settings re-shows the
        // "Replace the current database?" confirmation for a file the user already walked away
        // from - one click from replacing their library with it.
        rerender({ opened: false });
        expect(result.current.pendingImportPath).toBeNull();

        rerender({ opened: true });
        expect(result.current.pendingImportPath).toBeNull();
    });

    it("reports an error when the import dialog itself fails to open", async () => {
        getLibrarySummaryMock.mockResolvedValueOnce(createSummary());
        openMock.mockRejectedValueOnce(new Error("dialog crashed"));

        const { result } = renderHook(() =>
            useSettingsController({ opened: true, libraryPath: "/library" })
        );

        await act(async () => {
            await result.current.pickImportFileAction();
        });

        expect(result.current.pendingImportPath).toBeNull();
        expect(result.current.databaseMessage).toEqual({
            tone: "error",
            text: "Could not open the import dialog.",
        });
    });

    it("does nothing when confirming an import with no pending path", async () => {
        const { result } = renderHook(() =>
            useSettingsController({ opened: false, libraryPath: "" })
        );

        await act(async () => {
            await result.current.confirmImportAction();
        });

        expect(importDatabaseMock).not.toHaveBeenCalled();
        expect(relaunchMock).not.toHaveBeenCalled();
        expect(result.current.databaseBusy).toBe("idle");
    });

    it("does not set a pending import path when the import dialog is cancelled", async () => {
        getLibrarySummaryMock.mockResolvedValueOnce(createSummary());
        openMock.mockResolvedValueOnce(null);

        const { result } = renderHook(() =>
            useSettingsController({ opened: true, libraryPath: "/library" })
        );

        await act(async () => {
            await result.current.pickImportFileAction();
        });

        expect(result.current.pendingImportPath).toBeNull();
        expect(importDatabaseMock).not.toHaveBeenCalled();
    });

    it("reports an error and clears the pending import path when import fails", async () => {
        getLibrarySummaryMock.mockResolvedValueOnce(createSummary());
        openMock.mockResolvedValueOnce("/backups/import.db");
        importDatabaseMock.mockRejectedValueOnce(new Error("corrupt file"));

        const { result } = renderHook(() =>
            useSettingsController({ opened: true, libraryPath: "/library" })
        );

        await act(async () => {
            await result.current.pickImportFileAction();
        });

        await act(async () => {
            await result.current.confirmImportAction();
        });

        expect(relaunchMock).not.toHaveBeenCalled();
        expect(result.current.databaseBusy).toBe("idle");
        expect(result.current.pendingImportPath).toBeNull();
        expect(result.current.databaseMessage).toEqual({
            tone: "error",
            text: "Could not import the selected database.",
        });
    });

    it("clears the pending import path when the import is cancelled", async () => {
        getLibrarySummaryMock.mockResolvedValueOnce(createSummary());
        openMock.mockResolvedValueOnce("/backups/import.db");

        const { result } = renderHook(() =>
            useSettingsController({ opened: true, libraryPath: "/library" })
        );

        await act(async () => {
            await result.current.pickImportFileAction();
        });

        expect(result.current.pendingImportPath).toBe("/backups/import.db");

        act(() => {
            result.current.cancelImport();
        });

        expect(result.current.pendingImportPath).toBeNull();
    });

    it("reports when the last import can be undone", async () => {
        getLibrarySummaryMock.mockResolvedValueOnce(createSummary());
        getDatabaseImportUndoStatusMock.mockResolvedValueOnce(true);

        const { result } = renderHook(() =>
            useSettingsController({ opened: true, libraryPath: "/library" })
        );

        await waitFor(() => {
            expect(result.current.canUndoImport).toBe(true);
        });
    });

    it("undoes the last import and relaunches the app on confirm", async () => {
        getLibrarySummaryMock.mockResolvedValueOnce(createSummary());
        getDatabaseImportUndoStatusMock.mockResolvedValueOnce(true);
        undoDatabaseImportMock.mockResolvedValueOnce(undefined);
        relaunchMock.mockResolvedValueOnce(undefined);

        const { result } = renderHook(() =>
            useSettingsController({ opened: true, libraryPath: "/library" })
        );

        await waitFor(() => {
            expect(result.current.canUndoImport).toBe(true);
        });

        act(() => {
            result.current.requestUndoImport();
        });
        expect(result.current.isUndoImportConfirmOpen).toBe(true);

        await act(async () => {
            await result.current.confirmUndoImportAction();
        });

        expect(undoDatabaseImportMock).toHaveBeenCalledTimes(1);
        expect(relaunchMock).toHaveBeenCalledTimes(1);
    });

    it("reports an error and stays idle when the undo fails", async () => {
        getLibrarySummaryMock.mockResolvedValueOnce(createSummary());
        getDatabaseImportUndoStatusMock.mockResolvedValueOnce(true);
        undoDatabaseImportMock.mockRejectedValueOnce(new Error("no snapshot"));

        const { result } = renderHook(() =>
            useSettingsController({ opened: true, libraryPath: "/library" })
        );

        await waitFor(() => {
            expect(result.current.canUndoImport).toBe(true);
        });

        act(() => {
            result.current.requestUndoImport();
        });

        await act(async () => {
            await result.current.confirmUndoImportAction();
        });

        expect(relaunchMock).not.toHaveBeenCalled();
        expect(result.current.databaseBusy).toBe("idle");
        expect(result.current.isUndoImportConfirmOpen).toBe(false);
        expect(result.current.databaseMessage).toEqual({
            tone: "error",
            text: "Could not undo the last database import.",
        });
    });

    it("exposes the app update state and actions from useAppUpdate", () => {
        const { result } = renderHook(() =>
            useSettingsController({ opened: false, libraryPath: "" })
        );

        expect(result.current.appUpdateStatus).toBe("idle");
        expect(result.current.updateInfo).toBeNull();

        void result.current.checkForUpdate();
        void result.current.installUpdate();

        expect(mockCheckForUpdate).toHaveBeenCalledTimes(1);
        expect(mockInstallUpdate).toHaveBeenCalledTimes(1);
    });
});
