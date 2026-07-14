import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    getStoredAppSettings,
    setStoredAppSettings,
} from "../services/app-settings-command-service";
import {
    getDefaultAppSettings,
    loadStoredSettings,
    persistSettings,
    updateStoredCheckUpdatesOnStartup,
    updateStoredImportMode,
    updateStoredLibraryPath,
    updateStoredLoadRemoteImages,
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
            loadRemoteImages: null,
            checkUpdatesOnStartup: null,
        });
    });

    it("returns default settings", () => {
        expect(getDefaultAppSettings()).toEqual({
            importMode: "copy",
            libraryPath: "",
            loadRemoteImages: false,
            checkUpdatesOnStartup: false,
        });
    });

    it("loads default settings when backend has no stored values", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: null,
            libraryPath: null,
            loadRemoteImages: null,
            checkUpdatesOnStartup: null,
        });

        await expect(loadStoredSettings()).resolves.toEqual({
            importMode: "copy",
            libraryPath: "",
            loadRemoteImages: false,
            checkUpdatesOnStartup: false,
        });

        expect(getStoredAppSettings).toHaveBeenCalledTimes(1);
    });

    it("loads stored settings from backend", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "move",
            libraryPath: "  /library  ",
            loadRemoteImages: "false",
            checkUpdatesOnStartup: null,
        });

        await expect(loadStoredSettings()).resolves.toEqual({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: false,
            checkUpdatesOnStartup: false,
        });
    });

    it("falls back to copy when import mode from backend is invalid", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "invalid-mode",
            libraryPath: "/library",
            loadRemoteImages: null,
            checkUpdatesOnStartup: null,
        });

        await expect(loadStoredSettings()).resolves.toEqual({
            importMode: "copy",
            libraryPath: "/library",
            loadRemoteImages: false,
            checkUpdatesOnStartup: false,
        });
    });

    it("only treats an explicit \"true\" as remote images enabled", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: null,
            libraryPath: null,
            loadRemoteImages: "true",
            checkUpdatesOnStartup: null,
        });

        await expect(loadStoredSettings()).resolves.toMatchObject({
            loadRemoteImages: true,
            checkUpdatesOnStartup: false,
        });
    });

    it("keeps remote images off for any non-\"true\" stored value", async () => {
        for (const stored of ["false", "1", "yes", ""]) {
            vi.mocked(getStoredAppSettings).mockResolvedValue({
                importMode: null,
                libraryPath: null,
                loadRemoteImages: stored,
                checkUpdatesOnStartup: null,
            });

            await expect(loadStoredSettings()).resolves.toMatchObject({
                loadRemoteImages: false,
                checkUpdatesOnStartup: false,
            });
        }
    });

    it("persists settings through the backend command", async () => {
        await persistSettings({
            importMode: "copy",
            libraryPath: "/library",
            loadRemoteImages: true,
            checkUpdatesOnStartup: false,
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("copy", "/library", true, false);
    });

    it("trims the library path before persisting settings", async () => {
        await persistSettings({
            importMode: "copy",
            libraryPath: "  /library  ",
            loadRemoteImages: false,
            checkUpdatesOnStartup: false,
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("copy", "/library", false, false);
    });

    it("updates only import mode preserving current library path and remote images", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "copy",
            libraryPath: "/library",
            loadRemoteImages: "false",
            checkUpdatesOnStartup: null,
        });

        const result = await updateStoredImportMode("move");

        expect(result).toEqual({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: false,
            checkUpdatesOnStartup: false,
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("move", "/library", false, false);
    });

    it("updates only library path preserving current import mode and remote images", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "move",
            libraryPath: "/old-library",
            loadRemoteImages: null,
            checkUpdatesOnStartup: null,
        });

        const result = await updateStoredLibraryPath("  /new-library  ");

        expect(result).toEqual({
            importMode: "move",
            libraryPath: "/new-library",
            loadRemoteImages: false,
            checkUpdatesOnStartup: false,
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("move", "/new-library", false, false);
    });

    it("updates only the remote images preference preserving the other settings", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: null,
            checkUpdatesOnStartup: null,
        });

        const result = await updateStoredLoadRemoteImages(false);

        expect(result).toEqual({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: false,
            checkUpdatesOnStartup: false,
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("move", "/library", false, false);
    });

    it("updates only the startup update-check preference preserving the other settings", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: "true",
            checkUpdatesOnStartup: null,
        });

        const result = await updateStoredCheckUpdatesOnStartup(true);

        expect(result).toEqual({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: true,
            checkUpdatesOnStartup: true,
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("move", "/library", true, true);
    });
});
