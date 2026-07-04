import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppSettingsActions } from "./use-app-settings-actions";

vi.mock("../use-cases/change-library-path", () => ({
    executeChangeLibraryPath: vi.fn(),
}));

vi.mock("../use-cases/initialize-app-settings", () => ({
    initializeAppSettings: vi.fn(),
}));

vi.mock("../services/library-service", () => ({
    openLibraryDirectory: vi.fn(),
}));

vi.mock("./use-app-settings-storage", () => ({
    loadStoredSettings: vi.fn(),
    persistSettings: vi.fn(),
    updateStoredImportMode: vi.fn(),
    updateStoredLibraryPath: vi.fn(),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { executeChangeLibraryPath } from "../use-cases/change-library-path";
import { initializeAppSettings } from "../use-cases/initialize-app-settings";
import { openLibraryDirectory } from "../services/library-service";
import {
    loadStoredSettings,
    persistSettings,
    updateStoredImportMode,
    updateStoredLibraryPath,
} from "./use-app-settings-storage";

describe("useAppSettingsActions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("prepares settings successfully", async () => {
        const onError = vi.fn();
        const setSettings = vi.fn();

        vi.mocked(loadStoredSettings).mockResolvedValueOnce({
            importMode: "copy",
            libraryPath: "/library",
        });

        vi.mocked(initializeAppSettings).mockResolvedValueOnce({
            settings: {
                importMode: "copy",
                libraryPath: "/library",
            },
            shouldWarnAboutLibraryPath: false,
        });

        vi.mocked(persistSettings).mockResolvedValueOnce(undefined);

        const { result } = renderHook(() =>
            useAppSettingsActions({
                onError,
                setSettings,
            })
        );

        await act(async () => {
            await result.current.prepareSettings();
        });

        expect(loadStoredSettings).toHaveBeenCalledTimes(1);
        expect(initializeAppSettings).toHaveBeenCalledWith({
            storedSettings: {
                importMode: "copy",
                libraryPath: "/library",
            },
        });
        expect(setSettings).toHaveBeenCalledWith({
            importMode: "copy",
            libraryPath: "/library",
        });
        expect(persistSettings).toHaveBeenCalledWith({
            importMode: "copy",
            libraryPath: "/library",
        });
        expect(updateStoredLibraryPath).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
    });

    it("warns the user when the stored library path was reset", async () => {
        const onError = vi.fn();
        const setSettings = vi.fn();

        vi.mocked(loadStoredSettings).mockResolvedValueOnce({
            importMode: "copy",
            libraryPath: "",
        });

        vi.mocked(initializeAppSettings).mockResolvedValueOnce({
            settings: {
                importMode: "copy",
                libraryPath: "",
            },
            shouldWarnAboutLibraryPath: true,
        });

        vi.mocked(persistSettings).mockResolvedValueOnce(undefined);

        const { result } = renderHook(() =>
            useAppSettingsActions({
                onError,
                setSettings,
            })
        );

        await act(async () => {
            await result.current.prepareSettings();
        });

        expect(setSettings).toHaveBeenCalledWith({
            importMode: "copy",
            libraryPath: "",
        });
        expect(persistSettings).toHaveBeenCalledWith({
            importMode: "copy",
            libraryPath: "",
        });
        expect(updateStoredLibraryPath).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(
            expect.stringContaining("library folder could not be found")
        );
    });

    it("changes library path when result is changed", async () => {
        const onError = vi.fn();
        const setSettings = vi.fn();

        vi.mocked(executeChangeLibraryPath).mockResolvedValueOnce({
            changed: true,
            finalLibraryPath: "/new-library",
        });

        vi.mocked(updateStoredLibraryPath).mockResolvedValueOnce({
            importMode: "copy",
            libraryPath: "/new-library",
        });

        const { result } = renderHook(() =>
            useAppSettingsActions({
                onError,
                setSettings,
            })
        );

        await act(async () => {
            await result.current.changeLibraryPath("/library");
        });

        expect(executeChangeLibraryPath).toHaveBeenCalledWith({
            currentLibraryPath: "/library",
        });
        expect(updateStoredLibraryPath).toHaveBeenCalledWith("/new-library");
        expect(setSettings).toHaveBeenCalledWith({
            importMode: "copy",
            libraryPath: "/new-library",
        });
    });

    it("does not update settings when library path was not changed", async () => {
        const onError = vi.fn();
        const setSettings = vi.fn();

        vi.mocked(executeChangeLibraryPath).mockResolvedValueOnce({
            changed: false,
            finalLibraryPath: "/library",
        });

        const { result } = renderHook(() =>
            useAppSettingsActions({
                onError,
                setSettings,
            })
        );

        await act(async () => {
            await result.current.changeLibraryPath("/library");
        });

        expect(updateStoredLibraryPath).not.toHaveBeenCalled();
        expect(setSettings).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
    });

    it("updates import mode in storage", async () => {
        const onError = vi.fn();
        const setSettings = vi.fn();

        vi.mocked(updateStoredImportMode).mockResolvedValueOnce({
            importMode: "move",
            libraryPath: "/library",
        });

        const { result } = renderHook(() =>
            useAppSettingsActions({
                onError,
                setSettings,
            })
        );

        act(() => {
            result.current.setImportModeAction("move");
        });

        await waitFor(() => {
            expect(updateStoredImportMode).toHaveBeenCalledWith("move");
        });

        expect(setSettings).toHaveBeenCalledWith({
            importMode: "move",
            libraryPath: "/library",
        });
        expect(onError).not.toHaveBeenCalled();
    });

    it("opens current library path", async () => {
        const onError = vi.fn();
        const setSettings = vi.fn();

        vi.mocked(openLibraryDirectory).mockResolvedValueOnce(undefined);

        const { result } = renderHook(() =>
            useAppSettingsActions({
                onError,
                setSettings,
            })
        );

        await act(async () => {
            await result.current.openCurrentLibraryPathAction("/library");
        });

        expect(openLibraryDirectory).toHaveBeenCalledWith("/library");
        expect(onError).not.toHaveBeenCalled();
    });

    it("reports open library path error", async () => {
        const onError = vi.fn();
        const setSettings = vi.fn();

        vi.mocked(openLibraryDirectory).mockRejectedValueOnce(
            new Error("open failed")
        );

        const { result } = renderHook(() =>
            useAppSettingsActions({
                onError,
                setSettings,
            })
        );

        await act(async () => {
            await result.current.openCurrentLibraryPathAction("/library");
        });

        expect(onError).toHaveBeenCalled();
    });
});