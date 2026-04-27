import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../lib/db";
import {
    getDefaultAppSettings,
    loadStoredSettings,
    persistSettings,
    updateStoredImportMode,
    updateStoredLibraryPath,
} from "./use-app-settings-storage";

vi.mock("../lib/db", () => ({
    getDb: vi.fn(),
}));

type DbSelectMock = ReturnType<typeof vi.fn>;
type DbExecuteMock = ReturnType<typeof vi.fn>;

type MockDb = {
    select: DbSelectMock;
    execute: DbExecuteMock;
};

describe("use-app-settings-storage", () => {
    let mockDb: MockDb;

    beforeEach(() => {
        vi.restoreAllMocks();

        mockDb = {
            select: vi.fn(),
            execute: vi.fn(),
        };

        vi.mocked(getDb).mockResolvedValue(mockDb as never);
    });

    it("returns default settings", () => {
        expect(getDefaultAppSettings()).toEqual({
            importMode: "copy",
            libraryPath: "",
        });
    });

    it("loads default settings when database has no app settings rows", async () => {
        mockDb.select.mockResolvedValue([]);

        await expect(loadStoredSettings()).resolves.toEqual({
            importMode: "copy",
            libraryPath: "",
        });

        expect(mockDb.select).toHaveBeenCalledWith(
            `
            SELECT key, value
            FROM app_settings
            WHERE key IN (?, ?)
        `,
            ["import_mode", "library_path"]
        );
    });

    it("loads stored settings from database", async () => {
        mockDb.select.mockResolvedValue([
            {
                key: "import_mode",
                value: "move",
            },
            {
                key: "library_path",
                value: "  /library  ",
            },
        ]);

        await expect(loadStoredSettings()).resolves.toEqual({
            importMode: "move",
            libraryPath: "/library",
        });
    });

    it("falls back to copy when import mode in database is invalid", async () => {
        mockDb.select.mockResolvedValue([
            {
                key: "import_mode",
                value: "invalid-mode",
            },
            {
                key: "library_path",
                value: "/library",
            },
        ]);

        await expect(loadStoredSettings()).resolves.toEqual({
            importMode: "copy",
            libraryPath: "/library",
        });
    });

    it("persists settings to database", async () => {
        await persistSettings({
            importMode: "copy",
            libraryPath: "/library",
        });

        expect(mockDb.execute).toHaveBeenNthCalledWith(
            1,
            `
            INSERT INTO app_settings (key, value, created_at, updated_at)
            VALUES (?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = datetime('now')
        `,
            ["import_mode", "copy"]
        );

        expect(mockDb.execute).toHaveBeenNthCalledWith(
            2,
            `
            INSERT INTO app_settings (key, value, created_at, updated_at)
            VALUES (?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = datetime('now')
        `,
            ["library_path", "/library"]
        );
    });

    it("updates only import mode preserving current library path", async () => {
        mockDb.select.mockResolvedValue([
            {
                key: "import_mode",
                value: "copy",
            },
            {
                key: "library_path",
                value: "/library",
            },
        ]);

        const result = await updateStoredImportMode("move");

        expect(result).toEqual({
            importMode: "move",
            libraryPath: "/library",
        });

        expect(mockDb.execute).toHaveBeenNthCalledWith(
            1,
            `
            INSERT INTO app_settings (key, value, created_at, updated_at)
            VALUES (?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = datetime('now')
        `,
            ["import_mode", "move"]
        );

        expect(mockDb.execute).toHaveBeenNthCalledWith(
            2,
            `
            INSERT INTO app_settings (key, value, created_at, updated_at)
            VALUES (?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = datetime('now')
        `,
            ["library_path", "/library"]
        );
    });

    it("updates only library path preserving current import mode", async () => {
        mockDb.select.mockResolvedValue([
            {
                key: "import_mode",
                value: "move",
            },
            {
                key: "library_path",
                value: "/old-library",
            },
        ]);

        const result = await updateStoredLibraryPath("  /new-library  ");

        expect(result).toEqual({
            importMode: "move",
            libraryPath: "/new-library",
        });

        expect(mockDb.execute).toHaveBeenNthCalledWith(
            1,
            `
            INSERT INTO app_settings (key, value, created_at, updated_at)
            VALUES (?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = datetime('now')
        `,
            ["import_mode", "move"]
        );

        expect(mockDb.execute).toHaveBeenNthCalledWith(
            2,
            `
            INSERT INTO app_settings (key, value, created_at, updated_at)
            VALUES (?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = datetime('now')
        `,
            ["library_path", "/new-library"]
        );
    });
});