import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    checkDatabaseIntegrity,
    chooseExternalBackupDirectory,
    ensureDatabaseReady,
    exportDatabase,
    getDatabaseBackupStatus,
    getDatabaseImportUndoStatus,
    importDatabase,
    restoreDatabaseFromBackup,
    undoDatabaseImport,
} from "./database-service";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";
import { pickFolder } from "./file-dialog-service";
import { TAURI_COMMANDS } from "../constants/tauri-commands";

vi.mock("../lib/tauri-client", () => ({
    invokeCommand: vi.fn(),
    invokeVoid: vi.fn(),
}));

vi.mock("./file-dialog-service", () => ({
    pickFolder: vi.fn(),
}));

describe("checkDatabaseIntegrity", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("invokes the backend command and resolves true when the database is healthy", async () => {
        vi.mocked(invokeCommand).mockResolvedValueOnce(true);

        const result = await checkDatabaseIntegrity();

        expect(invokeCommand).toHaveBeenCalledWith(TAURI_COMMANDS.CHECK_DATABASE_INTEGRITY);
        expect(result).toBe(true);
    });

    it("resolves false when the integrity check reports a problem", async () => {
        vi.mocked(invokeCommand).mockResolvedValueOnce(false);

        const result = await checkDatabaseIntegrity();

        expect(result).toBe(false);
    });
});

// Each wrapper is one call, and what can go wrong in it is the wire contract: the command name and
// the argument keys. The backend reads `destinationPath`/`sourcePath` by those exact camelCase
// names, so a renamed key is a refused export or import that no type check catches.
describe("database command wrappers", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("sends the export destination under the key the backend reads", async () => {
        await exportDatabase("D:/backups/kavynex.db");

        expect(invokeVoid).toHaveBeenCalledWith(TAURI_COMMANDS.EXPORT_DATABASE, {
            destinationPath: "D:/backups/kavynex.db",
        });
    });

    it("sends the import source under the key the backend reads", async () => {
        await importDatabase("D:/backups/kavynex.db");

        expect(invokeVoid).toHaveBeenCalledWith(TAURI_COMMANDS.IMPORT_DATABASE, {
            sourcePath: "D:/backups/kavynex.db",
        });
    });

    it("calls the argument-less commands by name", async () => {
        await ensureDatabaseReady();
        await restoreDatabaseFromBackup();
        await undoDatabaseImport();

        expect(vi.mocked(invokeVoid).mock.calls).toEqual([
            [TAURI_COMMANDS.ENSURE_DATABASE_READY],
            [TAURI_COMMANDS.RESTORE_DATABASE_FROM_BACKUP],
            [TAURI_COMMANDS.UNDO_DATABASE_IMPORT],
        ]);
    });

    it("returns what the status commands report", async () => {
        const status = { available: true, backed_up_at: "2026-09-01T00:00:00Z" };
        vi.mocked(invokeCommand).mockResolvedValueOnce(status as never);
        vi.mocked(invokeCommand).mockResolvedValueOnce(true as never);

        await expect(getDatabaseBackupStatus()).resolves.toBe(status);
        await expect(getDatabaseImportUndoStatus()).resolves.toBe(true);

        expect(vi.mocked(invokeCommand).mock.calls).toEqual([
            [TAURI_COMMANDS.GET_DATABASE_BACKUP_STATUS],
            [TAURI_COMMANDS.GET_DATABASE_IMPORT_UNDO_STATUS],
        ]);
    });

    it("lets a refused import reach the caller", async () => {
        // The settings flow shows this error and does not relaunch, so it must not be swallowed.
        vi.mocked(invokeVoid).mockRejectedValueOnce({ code: "DATABASE_IMPORT_INVALID" });

        await expect(importDatabase("D:/notes.db")).rejects.toMatchObject({
            code: "DATABASE_IMPORT_INVALID",
        });
    });
});

describe("chooseExternalBackupDirectory", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("asks the backend's folder picker and returns its answer", async () => {
        vi.mocked(pickFolder).mockResolvedValueOnce("E:/Kavynex backups");
        await expect(chooseExternalBackupDirectory()).resolves.toBe("E:/Kavynex backups");

        vi.mocked(pickFolder).mockResolvedValueOnce(null);
        await expect(chooseExternalBackupDirectory()).resolves.toBeNull();
    });
});
