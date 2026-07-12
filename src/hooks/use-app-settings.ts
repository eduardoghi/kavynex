import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppSettings, ImportMode } from "../types/settings";
import { useAppSettingsActions } from "./use-app-settings-actions";
import { getDefaultAppSettings } from "./use-app-settings-storage";
import { registerLibraryAssetScope } from "../services/asset-scope-service";
import { migrateLiveChatToLibrary } from "../services/live-chat-service";
import { logError } from "../utils/app-logger";

type UseAppSettingsOptions = {
    onError: (message: string) => void;
};

type UseAppSettingsReturn = {
    settingsOpen: boolean;
    settings: AppSettings;
    isPreparingSettings: boolean;
    isMigratingLibraryPath: boolean;
    openSettings: () => void;
    closeSettings: () => void;
    setImportMode: (mode: ImportMode) => void;
    setLoadRemoteImages: (loadRemoteImages: boolean) => void;
    chooseLibraryPath: () => Promise<void>;
    openCurrentLibraryPath: () => Promise<void>;
};

export function useAppSettings({
    onError,
}: UseAppSettingsOptions): UseAppSettingsReturn {
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settings, setSettings] = useState<AppSettings>(getDefaultAppSettings());

    const settingsActions = useAppSettingsActions({
        onError,
        setSettings,
    });

    // Destructure the stable field off the per-render settingsActions controller object so
    // the effect below can depend on it directly. This keeps the dependency array honest (no
    // eslint-disable) while still not depending on the whole object, whose identity changes
    // every render.
    const { prepareSettings } = settingsActions;

    const openSettings = useCallback((): void => {
        setSettingsOpen(true);
    }, []);

    const closeSettings = useCallback((): void => {
        setSettingsOpen(false);
    }, []);

    const setImportMode = useCallback(
        (mode: ImportMode): void => {
            settingsActions.setImportModeAction(mode);
        },
        [settingsActions]
    );

    const setLoadRemoteImages = useCallback(
        (loadRemoteImages: boolean): void => {
            settingsActions.setLoadRemoteImagesAction(loadRemoteImages);
        },
        [settingsActions]
    );

    const chooseLibraryPath = useCallback(async (): Promise<void> => {
        await settingsActions.changeLibraryPath(settings.libraryPath);
    }, [settings.libraryPath, settingsActions]);

    const openCurrentLibraryPath = useCallback(async (): Promise<void> => {
        await settingsActions.openCurrentLibraryPathAction(settings.libraryPath);
    }, [settings.libraryPath, settingsActions]);

    useEffect(() => {
        void prepareSettings();
    }, [prepareSettings]);

    // Authorize the asset protocol to read from the current library directory. Runs on
    // startup and whenever the library path changes. Failures are non-fatal: media may
    // not render, but nothing else breaks.
    useEffect(() => {
        const libraryPath = settings.libraryPath.trim();

        if (!libraryPath) {
            return;
        }

        void registerLibraryAssetScope(libraryPath).catch((error) => {
            logError("asset-scope", "Failed to register library asset scope.", error, {
                libraryPath,
            });
        });

        // Best effort: move any live chat files still in the old app-data location into the
        // library so they travel with it and are covered by a library backup. Idempotent.
        void migrateLiveChatToLibrary().catch((error) => {
            logError("live-chat", "Failed to migrate live chat into the library.", error, {
                libraryPath,
            });
        });
    }, [settings.libraryPath]);

    // Memoized so the controller object keeps a stable identity across renders. Consumers that
    // depend on the whole object stop being invalidated on unrelated re-renders.
    const { isPreparingSettings, isMigratingLibraryPath } = settingsActions;

    return useMemo(
        () => ({
            settingsOpen,
            settings,
            isPreparingSettings,
            isMigratingLibraryPath,
            openSettings,
            closeSettings,
            setImportMode,
            setLoadRemoteImages,
            chooseLibraryPath,
            openCurrentLibraryPath,
        }),
        [
            settingsOpen,
            settings,
            isPreparingSettings,
            isMigratingLibraryPath,
            openSettings,
            closeSettings,
            setImportMode,
            setLoadRemoteImages,
            chooseLibraryPath,
            openCurrentLibraryPath,
        ]
    );
}