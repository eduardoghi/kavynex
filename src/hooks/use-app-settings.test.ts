import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppSettings } from "./use-app-settings";

vi.mock("./use-app-settings-actions", () => ({
    useAppSettingsActions: vi.fn(),
}));

vi.mock("./use-app-settings-storage", () => ({
    getDefaultAppSettings: vi.fn(),
}));

import { useAppSettingsActions } from "./use-app-settings-actions";
import { getDefaultAppSettings } from "./use-app-settings-storage";

const mockedUseAppSettingsActions = vi.mocked(useAppSettingsActions);
const mockedGetDefaultAppSettings = vi.mocked(getDefaultAppSettings);

describe("useAppSettings", () => {
    const prepareSettings = vi.fn();
    const changeLibraryPath = vi.fn();
    const setImportModeAction = vi.fn();
    const openCurrentLibraryPathAction = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();

        mockedGetDefaultAppSettings.mockReturnValue({
            importMode: "copy",
            libraryPath: "/library",
        });

        mockedUseAppSettingsActions.mockReturnValue({
            isPreparingSettings: false,
            isMigratingLibraryPath: false,
            prepareSettings,
            changeLibraryPath,
            setImportModeAction,
            openCurrentLibraryPathAction,
        });
    });

    it("prepares settings on mount", async () => {
        renderHook(() =>
            useAppSettings({
                onError: vi.fn(),
            })
        );

        await waitFor(() => {
            expect(prepareSettings).toHaveBeenCalledTimes(1);
        });
    });

    it("opens and closes settings modal", () => {
        const { result } = renderHook(() =>
            useAppSettings({
                onError: vi.fn(),
            })
        );

        act(() => {
            result.current.openSettings();
        });

        expect(result.current.settingsOpen).toBe(true);

        act(() => {
            result.current.closeSettings();
        });

        expect(result.current.settingsOpen).toBe(false);
    });

    it("delegates import mode update", () => {
        const { result } = renderHook(() =>
            useAppSettings({
                onError: vi.fn(),
            })
        );

        act(() => {
            result.current.setImportMode("move");
        });

        expect(setImportModeAction).toHaveBeenCalledWith("move");
    });

    it("delegates library path change using current settings", async () => {
        const { result } = renderHook(() =>
            useAppSettings({
                onError: vi.fn(),
            })
        );

        await act(async () => {
            await result.current.chooseLibraryPath();
        });

        expect(changeLibraryPath).toHaveBeenCalledWith("/library");
    });

    it("delegates open current library path using current settings", async () => {
        const { result } = renderHook(() =>
            useAppSettings({
                onError: vi.fn(),
            })
        );

        await act(async () => {
            await result.current.openCurrentLibraryPath();
        });

        expect(openCurrentLibraryPathAction).toHaveBeenCalledWith("/library");
    });
});