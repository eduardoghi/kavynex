import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri-client", () => ({
    invokeCommand: vi.fn(),
}));

import { invokeCommand } from "../lib/tauri-client";
import { pickFile, pickFolder, pickSaveDestination } from "./file-dialog-service";

const invokeMock = vi.mocked(invokeCommand);

describe("file-dialog-service", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("asks the backend for a folder", async () => {
        invokeMock.mockResolvedValueOnce("D:/Library");

        await expect(pickFolder("library")).resolves.toBe("D:/Library");
        expect(invokeMock).toHaveBeenCalledWith("open_folder_dialog", { purpose: "library" });
    });

    it("asks the backend for a file with the filters the caller names", async () => {
        invokeMock.mockResolvedValueOnce("/backups/import.db");

        const filters = [{ name: "Database", extensions: ["db"] }];

        await expect(pickFile({ title: "Import database", filters })).resolves.toBe(
            "/backups/import.db"
        );
        expect(invokeMock).toHaveBeenCalledWith("open_file_dialog", {
            title: "Import database",
            filters,
        });
    });

    it("sends an empty filter list rather than leaving it out", async () => {
        // The command takes a Vec, which serde does not default when the key is missing.
        invokeMock.mockResolvedValueOnce(null);

        await pickFile();

        expect(invokeMock).toHaveBeenCalledWith("open_file_dialog", { title: null, filters: [] });
    });

    it("asks the backend for a save destination with the file name filled in", async () => {
        invokeMock.mockResolvedValueOnce("/backups/kavynex-backup.db");

        await expect(
            pickSaveDestination({ title: "Export database", defaultFileName: "kavynex-backup.db" })
        ).resolves.toBe("/backups/kavynex-backup.db");
        expect(invokeMock).toHaveBeenCalledWith("save_file_dialog", {
            title: "Export database",
            defaultFileName: "kavynex-backup.db",
            filters: [],
        });
    });

    it("returns the choice trimmed, and null for a cancelled or blank one", async () => {
        invokeMock.mockResolvedValueOnce("  E:/Kavynex backups  ");
        await expect(pickFolder("externalBackup")).resolves.toBe("E:/Kavynex backups");

        invokeMock.mockResolvedValueOnce(null);
        await expect(pickFile()).resolves.toBeNull();

        invokeMock.mockResolvedValueOnce("   ");
        await expect(pickSaveDestination()).resolves.toBeNull();
    });
});
