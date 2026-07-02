import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    getStoredAppSettings,
    setStoredAppSettings,
} from "../services/app-settings-command-service";
import {
    getDefaultAppSettings,
    loadStoredSettings,
    persistSettings,
    updateStoredImportMode,
    updateStoredLibraryPath,
} from "./use-app-settings-storage";

vi.mock("../services/app-settings-command-service", () => ({
    getStoredAppSettings: vi.fn(),
    setStoredAppSettings: vi.fn(),
}));

describe("use-app-settings-storage", () => {
    beforeEach(() => {
        vi.restoreAllMocks();

        vi.mocked(setStoredAppSettings).mockResolvedValue(undefined);
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: null,
            libraryPath: null,
        });
    });

    it("returns default settings", () => {
        expect(getDefaultAppSettings()).toEqual({
            importMode: "copy",
            libraryPath: "",
        });
    });

    it("loads default settings when backend has no stored values", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: null,
            libraryPath: null,
        });

        await expect(loadStoredSettings()).resolves.toEqual({
            importMode: "copy",
            libraryPath: "",
        });

        expect(getStoredAppSettings).toHaveBeenCalledTimes(1);
    });

    it("loads stored settings from backend", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "move",
            libraryPath: "  /library  ",
        });

        await expect(loadStoredSettings()).resolves.toEqual({
            importMode: "move",
            libraryPath: "/library",
        });
    });

    it("falls back to copy when import mode from backend is invalid", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "invalid-mode",
            libraryPath: "/library",
        });

        await expect(loadStoredSettings()).resolves.toEqual({
            importMode: "copy",
            libraryPath: "/library",
        });
    });

    it("persists settings through the backend command", async () => {
        await persistSettings({
            importMode: "copy",
            libraryPath: "/library",
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("copy", "/library");
    });

    it("updates only import mode preserving current library path", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "copy",
            libraryPath: "/library",
        });

        const result = await updateStoredImportMode("move");

        expect(result).toEqual({
            importMode: "move",
            libraryPath: "/library",
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("move", "/library");
    });

    it("updates only library path preserving current import mode", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "move",
            libraryPath: "/old-library",
        });

        const result = await updateStoredLibraryPath("  /new-library  ");

        expect(result).toEqual({
            importMode: "move",
            libraryPath: "/new-library",
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("move", "/new-library");
    });
});
