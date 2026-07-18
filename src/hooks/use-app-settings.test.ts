import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppSettings } from "./use-app-settings";

vi.mock("./use-app-settings-actions", () => ({
    useAppSettingsActions: vi.fn(),
}));

vi.mock("./use-app-settings-storage", () => ({
    getDefaultAppSettings: vi.fn(),
}));

vi.mock("../services/asset-scope-service", () => ({
    registerLibraryAssetScope: vi.fn(),
}));

vi.mock("../services/live-chat-service", () => ({
    migrateLiveChatToLibrary: vi.fn(),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { useAppSettingsActions } from "./use-app-settings-actions";
import { getDefaultAppSettings } from "./use-app-settings-storage";
import { registerLibraryAssetScope } from "../services/asset-scope-service";
import { migrateLiveChatToLibrary } from "../services/live-chat-service";
import { logError } from "../utils/app-logger";

const mockedUseAppSettingsActions = vi.mocked(useAppSettingsActions);
const mockedGetDefaultAppSettings = vi.mocked(getDefaultAppSettings);
const mockedRegisterLibraryAssetScope = vi.mocked(registerLibraryAssetScope);
const mockedMigrateLiveChatToLibrary = vi.mocked(migrateLiveChatToLibrary);
const mockedLogError = vi.mocked(logError);

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
            loadRemoteImages: true,
            checkUpdatesOnStartup: false,
            externalBackupDir: "",
        });

        mockedUseAppSettingsActions.mockReturnValue({
            isPreparingSettings: false,
            isMigratingLibraryPath: false,
            prepareSettings,
            changeLibraryPath,
            setImportModeAction,
            setLoadRemoteImagesAction: vi.fn(),
            setCheckUpdatesOnStartupAction: vi.fn(),
            openCurrentLibraryPathAction,
            isSavingExternalBackupDir: false,
            chooseExternalBackupDirAction: vi.fn(),
            clearExternalBackupDirAction: vi.fn(),
        });

        mockedRegisterLibraryAssetScope.mockResolvedValue(undefined);
        mockedMigrateLiveChatToLibrary.mockResolvedValue(undefined);
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

    it("starts with the settings modal closed", () => {
        const { result } = renderHook(() =>
            useAppSettings({
                onError: vi.fn(),
            })
        );

        expect(result.current.settingsOpen).toBe(false);
    });

    it("recomputes setImportMode when the settings actions reference changes across rerenders", () => {
        const { result, rerender } = renderHook(
            (props: { onError: (message: string) => void }) => useAppSettings(props),
            { initialProps: { onError: vi.fn() } }
        );

        act(() => {
            result.current.setImportMode("move");
        });

        expect(setImportModeAction).toHaveBeenCalledWith("move");

        const nextSetImportModeAction = vi.fn();

        mockedUseAppSettingsActions.mockReturnValue({
            isPreparingSettings: false,
            isMigratingLibraryPath: false,
            prepareSettings,
            changeLibraryPath,
            setImportModeAction: nextSetImportModeAction,
            setLoadRemoteImagesAction: vi.fn(),
            setCheckUpdatesOnStartupAction: vi.fn(),
            openCurrentLibraryPathAction,
            isSavingExternalBackupDir: false,
            chooseExternalBackupDirAction: vi.fn(),
            clearExternalBackupDirAction: vi.fn(),
        });

        rerender({ onError: vi.fn() });

        act(() => {
            result.current.setImportMode("copy");
        });

        expect(nextSetImportModeAction).toHaveBeenCalledWith("copy");
        expect(setImportModeAction).toHaveBeenCalledTimes(1);
    });

    it("recomputes chooseLibraryPath and openCurrentLibraryPath when the settings actions reference changes across rerenders", async () => {
        const { result, rerender } = renderHook(
            (props: { onError: (message: string) => void }) => useAppSettings(props),
            { initialProps: { onError: vi.fn() } }
        );

        await act(async () => {
            await result.current.chooseLibraryPath();
        });

        expect(changeLibraryPath).toHaveBeenCalledWith("/library");

        const nextChangeLibraryPath = vi.fn();
        const nextOpenCurrentLibraryPathAction = vi.fn();

        mockedUseAppSettingsActions.mockReturnValue({
            isPreparingSettings: false,
            isMigratingLibraryPath: false,
            prepareSettings,
            changeLibraryPath: nextChangeLibraryPath,
            setImportModeAction,
            setLoadRemoteImagesAction: vi.fn(),
            setCheckUpdatesOnStartupAction: vi.fn(),
            openCurrentLibraryPathAction: nextOpenCurrentLibraryPathAction,
            isSavingExternalBackupDir: false,
            chooseExternalBackupDirAction: vi.fn(),
            clearExternalBackupDirAction: vi.fn(),
        });

        rerender({ onError: vi.fn() });

        await act(async () => {
            await result.current.chooseLibraryPath();
            await result.current.openCurrentLibraryPath();
        });

        expect(nextChangeLibraryPath).toHaveBeenCalledWith("/library");
        expect(nextOpenCurrentLibraryPathAction).toHaveBeenCalledWith("/library");
        expect(changeLibraryPath).toHaveBeenCalledTimes(1);
        expect(openCurrentLibraryPathAction).not.toHaveBeenCalled();
    });

    it("re-invokes prepareSettings when its reference changes across rerenders", async () => {
        const { rerender } = renderHook(
            (props: { onError: (message: string) => void }) => useAppSettings(props),
            { initialProps: { onError: vi.fn() } }
        );

        await waitFor(() => {
            expect(prepareSettings).toHaveBeenCalledTimes(1);
        });

        const nextPrepareSettings = vi.fn();

        mockedUseAppSettingsActions.mockReturnValue({
            isPreparingSettings: false,
            isMigratingLibraryPath: false,
            prepareSettings: nextPrepareSettings,
            changeLibraryPath,
            setImportModeAction,
            setLoadRemoteImagesAction: vi.fn(),
            setCheckUpdatesOnStartupAction: vi.fn(),
            openCurrentLibraryPathAction,
            isSavingExternalBackupDir: false,
            chooseExternalBackupDirAction: vi.fn(),
            clearExternalBackupDirAction: vi.fn(),
        });

        rerender({ onError: vi.fn() });

        await waitFor(() => {
            expect(nextPrepareSettings).toHaveBeenCalledTimes(1);
        });

        expect(prepareSettings).toHaveBeenCalledTimes(1);
    });

    it("skips asset scope registration and live chat migration when the library path is empty", () => {
        mockedGetDefaultAppSettings.mockReturnValue({
            importMode: "copy",
            libraryPath: "   ",
            loadRemoteImages: true,
            checkUpdatesOnStartup: false,
            externalBackupDir: "",
        });

        renderHook(() =>
            useAppSettings({
                onError: vi.fn(),
            })
        );

        expect(mockedRegisterLibraryAssetScope).not.toHaveBeenCalled();
        expect(mockedMigrateLiveChatToLibrary).not.toHaveBeenCalled();
    });

    it("registers the asset scope and migrates live chat with the trimmed library path when non-empty", () => {
        mockedGetDefaultAppSettings.mockReturnValue({
            importMode: "copy",
            libraryPath: "  /library  ",
            loadRemoteImages: true,
            checkUpdatesOnStartup: false,
            externalBackupDir: "",
        });

        renderHook(() =>
            useAppSettings({
                onError: vi.fn(),
            })
        );

        expect(mockedRegisterLibraryAssetScope).toHaveBeenCalledWith("/library");
        expect(mockedMigrateLiveChatToLibrary).toHaveBeenCalledTimes(1);
    });

    it("logs an error when registering the library asset scope fails", async () => {
        mockedGetDefaultAppSettings.mockReturnValue({
            importMode: "copy",
            libraryPath: "/library",
            loadRemoteImages: true,
            checkUpdatesOnStartup: false,
            externalBackupDir: "",
        });

        const failure = new Error("scope failure");
        mockedRegisterLibraryAssetScope.mockRejectedValueOnce(failure);

        renderHook(() =>
            useAppSettings({
                onError: vi.fn(),
            })
        );

        await waitFor(() => {
            expect(mockedLogError).toHaveBeenCalledWith(
                "asset-scope",
                "Failed to register library asset scope.",
                failure,
                { libraryPath: "/library" }
            );
        });
    });

    it("logs an error when migrating live chat into the library fails", async () => {
        mockedGetDefaultAppSettings.mockReturnValue({
            importMode: "copy",
            libraryPath: "/library",
            loadRemoteImages: true,
            checkUpdatesOnStartup: false,
            externalBackupDir: "",
        });

        const failure = new Error("migration failure");
        mockedMigrateLiveChatToLibrary.mockRejectedValueOnce(failure);

        renderHook(() =>
            useAppSettings({
                onError: vi.fn(),
            })
        );

        await waitFor(() => {
            expect(mockedLogError).toHaveBeenCalledWith(
                "live-chat",
                "Failed to migrate live chat into the library.",
                failure,
                { libraryPath: "/library" }
            );
        });
    });

    it("re-runs asset scope registration and live chat migration when settings.libraryPath changes", () => {
        mockedGetDefaultAppSettings.mockReturnValue({
            importMode: "copy",
            libraryPath: "/library",
            loadRemoteImages: true,
            checkUpdatesOnStartup: false,
            externalBackupDir: "",
        });

        renderHook(() =>
            useAppSettings({
                onError: vi.fn(),
            })
        );

        expect(mockedRegisterLibraryAssetScope).toHaveBeenCalledWith("/library");
        expect(mockedMigrateLiveChatToLibrary).toHaveBeenCalledTimes(1);

        const { setSettings } = mockedUseAppSettingsActions.mock.calls[0]![0];

        act(() => {
            setSettings((previous) => ({ ...previous, libraryPath: "/new-library" }));
        });

        expect(mockedRegisterLibraryAssetScope).toHaveBeenCalledWith("/new-library");
        expect(mockedMigrateLiveChatToLibrary).toHaveBeenCalledTimes(2);
    });
});