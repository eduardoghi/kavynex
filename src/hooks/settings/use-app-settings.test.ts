import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppSettings } from "./use-app-settings";

vi.mock("./use-app-settings-actions", () => ({
    useAppSettingsActions: vi.fn(),
}));

vi.mock("./use-app-settings-storage", () => ({
    getDefaultAppSettings: vi.fn(),
}));

vi.mock("../../services/asset-scope-service", () => ({
    registerLibraryAssetScope: vi.fn(),
}));

vi.mock("../../services/live-chat-service", () => ({
    migrateLiveChatToLibrary: vi.fn(),
}));

vi.mock("../../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { useAppSettingsActions } from "./use-app-settings-actions";
import { getDefaultAppSettings } from "./use-app-settings-storage";
import { registerLibraryAssetScope } from "../../services/asset-scope-service";
import { migrateLiveChatToLibrary } from "../../services/live-chat-service";
import { logError } from "../../utils/app-logger";

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
            hasLoadedSettings: true,
            isMigratingLibraryPath: false,
            prepareSettings,
            changeLibraryPath,
            confirmLibraryMove: vi.fn(),
            cancelLibraryMove: vi.fn(),
            cancelRunningLibraryMove: vi.fn(),
            retryLibraryFolder: vi.fn(),
            setImportModeAction,
            setLoadRemoteImagesAction: vi.fn(),
            setCheckUpdatesOnStartupAction: vi.fn(),
            openCurrentLibraryPathAction,
            isSavingExternalBackupDir: false,
            isLibraryUnreachable: false,
            isRetryingLibraryFolder: false,
            pendingLibraryMove: null,
            libraryMoveProgress: null,
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
            hasLoadedSettings: true,
            isMigratingLibraryPath: false,
            prepareSettings,
            changeLibraryPath,
            confirmLibraryMove: vi.fn(),
            cancelLibraryMove: vi.fn(),
            cancelRunningLibraryMove: vi.fn(),
            retryLibraryFolder: vi.fn(),
            setImportModeAction: nextSetImportModeAction,
            setLoadRemoteImagesAction: vi.fn(),
            setCheckUpdatesOnStartupAction: vi.fn(),
            openCurrentLibraryPathAction,
            isSavingExternalBackupDir: false,
            isLibraryUnreachable: false,
            isRetryingLibraryFolder: false,
            pendingLibraryMove: null,
            libraryMoveProgress: null,
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
            hasLoadedSettings: true,
            isMigratingLibraryPath: false,
            prepareSettings,
            changeLibraryPath: nextChangeLibraryPath,
            confirmLibraryMove: vi.fn(),
            cancelLibraryMove: vi.fn(),
            cancelRunningLibraryMove: vi.fn(),
            retryLibraryFolder: vi.fn(),
            setImportModeAction,
            setLoadRemoteImagesAction: vi.fn(),
            setCheckUpdatesOnStartupAction: vi.fn(),
            openCurrentLibraryPathAction: nextOpenCurrentLibraryPathAction,
            isSavingExternalBackupDir: false,
            isLibraryUnreachable: false,
            isRetryingLibraryFolder: false,
            pendingLibraryMove: null,
            libraryMoveProgress: null,
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
            hasLoadedSettings: true,
            isMigratingLibraryPath: false,
            prepareSettings: nextPrepareSettings,
            changeLibraryPath,
            confirmLibraryMove: vi.fn(),
            cancelLibraryMove: vi.fn(),
            cancelRunningLibraryMove: vi.fn(),
            retryLibraryFolder: vi.fn(),
            setImportModeAction,
            setLoadRemoteImagesAction: vi.fn(),
            setCheckUpdatesOnStartupAction: vi.fn(),
            openCurrentLibraryPathAction,
            isSavingExternalBackupDir: false,
            isLibraryUnreachable: false,
            isRetryingLibraryFolder: false,
            pendingLibraryMove: null,
            libraryMoveProgress: null,
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

    it("skips asset scope registration and live chat migration while the folder cannot be reached", () => {
        // The path is still configured, but there is nothing behind it to authorize. The app
        // reloads once the folder is back, and the fresh start registers it.
        mockedUseAppSettingsActions.mockReturnValue({
            ...mockedUseAppSettingsActions(
                {} as Parameters<typeof useAppSettingsActions>[0]
            ),
            isLibraryUnreachable: true,
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

    it("surfaces the restart-required asset scope failure to the user, not just the log", async () => {
        // Registering the scope is otherwise best effort and log-only, and that is right for a
        // partial failure. This one is not partial. The library folder was changed and changed back
        // in the same session, so the scope refuses it permanently and no media loads at all. The
        // only fix is restarting, which the user cannot guess from an empty grid.
        const onError = vi.fn();
        mockedRegisterLibraryAssetScope.mockRejectedValueOnce({
            code: "ASSET_SCOPE_RESTART_REQUIRED",
            message: "this library was released earlier in this session",
        });

        renderHook(() => useAppSettings({ onError }));

        await waitFor(() => {
            expect(onError).toHaveBeenCalledTimes(1);
        });

        expect(onError.mock.calls[0]?.[0]).toContain("restarted");
    });

    it("keeps an ordinary asset scope failure out of the user's way", async () => {
        // The counterpart to the test above. Escalating every scope failure would put a modal in
        // front of the user for something that leaves the app working, which is why the log-only
        // default exists. Only the restart-required code is worth interrupting for.
        const onError = vi.fn();
        mockedRegisterLibraryAssetScope.mockRejectedValueOnce(new Error("scope failure"));

        renderHook(() => useAppSettings({ onError }));

        await waitFor(() => {
            expect(mockedLogError).toHaveBeenCalledWith(
                "asset-scope",
                "Failed to register library asset scope.",
                expect.anything(),
                { libraryPath: "/library" }
            );
        });

        expect(onError).not.toHaveBeenCalled();
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

    it("reports the library assets ready only once the current folder's scope registration settles", async () => {
        // The channel avatars wait on this flag. An image requested before the grant is refused and
        // never requested again, so a flag that ran ahead of the registration, or stayed true for the
        // previous folder, would leave the sidebar without avatars until something re-rendered them.
        mockedGetDefaultAppSettings.mockReturnValue({
            importMode: "copy",
            libraryPath: "/library",
            loadRemoteImages: true,
            checkUpdatesOnStartup: false,
            externalBackupDir: "",
        });

        let resolveFirst!: () => void;
        let rejectSecond!: (error: unknown) => void;
        mockedRegisterLibraryAssetScope
            .mockReturnValueOnce(new Promise<void>((resolve) => (resolveFirst = resolve)))
            .mockReturnValueOnce(new Promise<void>((_, reject) => (rejectSecond = reject)));

        // Hoisted, so the effect sees the stable callback it gets in the app and runs once per folder.
        const onError = vi.fn();
        const { result } = renderHook(() => useAppSettings({ onError }));

        expect(result.current.libraryAssetsReady).toBe(false);

        await act(async () => {
            resolveFirst();
        });

        expect(result.current.libraryAssetsReady).toBe(true);

        const { setSettings } = mockedUseAppSettingsActions.mock.calls[0]![0];

        act(() => {
            setSettings((previous) => ({ ...previous, libraryPath: "/new-library" }));
        });

        expect(result.current.libraryAssetsReady).toBe(false);

        // A failed grant is not retried, so it settles the wait the same way a granted one does.
        await act(async () => {
            rejectSecond(new Error("scope failure"));
        });

        await waitFor(() => {
            expect(result.current.libraryAssetsReady).toBe(true);
        });
    });
});