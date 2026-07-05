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
import { logError } from "../utils/app-logger";

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
            "The previously selected library folder could not be found, so it was cleared. " +
                "If it is on a removable drive, reconnect it and restart the app; otherwise " +
                "select the library folder again in Settings."
        );
    });

    it("logs and reports an error when preparing settings fails", async () => {
        const onError = vi.fn();
        const setSettings = vi.fn();
        const error = new Error("load failed");

        vi.mocked(loadStoredSettings).mockRejectedValueOnce(error);

        const { result } = renderHook(() =>
            useAppSettingsActions({
                onError,
                setSettings,
            })
        );

        await act(async () => {
            await result.current.prepareSettings();
        });

        expect(logError).toHaveBeenCalledWith(
            "settings",
            "Failed to prepare app settings.",
            error
        );
        expect(onError).toHaveBeenCalledWith("Failed to prepare app settings.");
        expect(setSettings).not.toHaveBeenCalled();
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

    it("logs and reports an error when changing the library path fails", async () => {
        const onError = vi.fn();
        const setSettings = vi.fn();
        const error = new Error("change failed");

        vi.mocked(executeChangeLibraryPath).mockRejectedValueOnce(error);

        const { result } = renderHook(() =>
            useAppSettingsActions({
                onError,
                setSettings,
            })
        );

        await act(async () => {
            await result.current.changeLibraryPath("/library");
        });

        expect(logError).toHaveBeenCalledWith(
            "settings",
            "Failed to change library folder.",
            error,
            {
                currentLibraryPath: "/library",
            }
        );
        expect(onError).toHaveBeenCalledWith("Failed to change library folder.");
        expect(setSettings).not.toHaveBeenCalled();
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

    it("logs and reports an error when changing the import mode fails", async () => {
        const onError = vi.fn();
        const setSettings = vi.fn();
        const error = new Error("mode failed");

        vi.mocked(updateStoredImportMode).mockRejectedValueOnce(error);

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
            expect(logError).toHaveBeenCalledWith(
                "settings",
                "Failed to change import mode.",
                error,
                {
                    mode: "move",
                }
            );
        });

        expect(onError).toHaveBeenCalledWith("Failed to change import mode.");
        expect(setSettings).not.toHaveBeenCalled();
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
        const error = new Error("open failed");

        vi.mocked(openLibraryDirectory).mockRejectedValueOnce(error);

        const { result } = renderHook(() =>
            useAppSettingsActions({
                onError,
                setSettings,
            })
        );

        await act(async () => {
            await result.current.openCurrentLibraryPathAction("/library");
        });

        expect(logError).toHaveBeenCalledWith(
            "settings",
            "Failed to open library folder.",
            error,
            {
                libraryPath: "/library",
            }
        );
        expect(onError).toHaveBeenCalledWith("Failed to open library folder.");
    });

    it("recreates action callbacks when onError or setSettings change", () => {
        const onError1 = vi.fn();
        const setSettings1 = vi.fn();

        const { result, rerender } = renderHook(
            (props: { onError: (message: string) => void; setSettings: typeof setSettings1 }) =>
                useAppSettingsActions(props),
            {
                initialProps: { onError: onError1, setSettings: setSettings1 },
            }
        );

        const firstPrepare = result.current.prepareSettings;
        const firstChange = result.current.changeLibraryPath;
        const firstImportMode = result.current.setImportModeAction;
        const firstOpen = result.current.openCurrentLibraryPathAction;

        const onError2 = vi.fn();
        const setSettings2 = vi.fn();

        rerender({ onError: onError2, setSettings: setSettings2 });

        expect(result.current.prepareSettings).not.toBe(firstPrepare);
        expect(result.current.changeLibraryPath).not.toBe(firstChange);
        expect(result.current.setImportModeAction).not.toBe(firstImportMode);
        expect(result.current.openCurrentLibraryPathAction).not.toBe(firstOpen);
    });
});