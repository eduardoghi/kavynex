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
        });
    });

    it("returns default settings", () => {
        expect(getDefaultAppSettings()).toEqual({
            importMode: "copy",
            libraryPath: "",
            loadRemoteImages: true,
        });
    });

    it("loads default settings when backend has no stored values", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: null,
            libraryPath: null,
            loadRemoteImages: null,
        });

        await expect(loadStoredSettings()).resolves.toEqual({
            importMode: "copy",
            libraryPath: "",
            loadRemoteImages: true,
        });

        expect(getStoredAppSettings).toHaveBeenCalledTimes(1);
    });

    it("loads stored settings from backend", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "move",
            libraryPath: "  /library  ",
            loadRemoteImages: "false",
        });

        await expect(loadStoredSettings()).resolves.toEqual({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: false,
        });
    });

    it("falls back to copy when import mode from backend is invalid", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "invalid-mode",
            libraryPath: "/library",
            loadRemoteImages: null,
        });

        await expect(loadStoredSettings()).resolves.toEqual({
            importMode: "copy",
            libraryPath: "/library",
            loadRemoteImages: true,
        });
    });

    it("only treats an explicit \"false\" as remote images disabled", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: null,
            libraryPath: null,
            loadRemoteImages: "true",
        });

        await expect(loadStoredSettings()).resolves.toMatchObject({
            loadRemoteImages: true,
        });
    });

    it("persists settings through the backend command", async () => {
        await persistSettings({
            importMode: "copy",
            libraryPath: "/library",
            loadRemoteImages: true,
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("copy", "/library", true);
    });

    it("trims the library path before persisting settings", async () => {
        await persistSettings({
            importMode: "copy",
            libraryPath: "  /library  ",
            loadRemoteImages: false,
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("copy", "/library", false);
    });

    it("updates only import mode preserving current library path and remote images", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "copy",
            libraryPath: "/library",
            loadRemoteImages: "false",
        });

        const result = await updateStoredImportMode("move");

        expect(result).toEqual({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: false,
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("move", "/library", false);
    });

    it("updates only library path preserving current import mode and remote images", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "move",
            libraryPath: "/old-library",
            loadRemoteImages: null,
        });

        const result = await updateStoredLibraryPath("  /new-library  ");

        expect(result).toEqual({
            importMode: "move",
            libraryPath: "/new-library",
            loadRemoteImages: true,
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("move", "/new-library", true);
    });

    it("updates only the remote images preference preserving the other settings", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: null,
        });

        const result = await updateStoredLoadRemoteImages(false);

        expect(result).toEqual({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: false,
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("move", "/library", false);
    });
});
