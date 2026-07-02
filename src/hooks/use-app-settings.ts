import { useCallback, useEffect, useState } from "react";
import type { AppSettings, ImportMode } from "../types/settings";
import { useAppSettingsActions } from "./use-app-settings-actions";
import { getDefaultAppSettings } from "./use-app-settings-storage";
import { registerLibraryAssetScope } from "../services/asset-scope-service";
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

    const chooseLibraryPath = useCallback(async (): Promise<void> => {
        await settingsActions.changeLibraryPath(settings.libraryPath);
    }, [settings.libraryPath, settingsActions]);

    const openCurrentLibraryPath = useCallback(async (): Promise<void> => {
        await settingsActions.openCurrentLibraryPathAction(settings.libraryPath);
    }, [settings.libraryPath, settingsActions]);

    useEffect(() => {
        void settingsActions.prepareSettings();
    }, [settingsActions.prepareSettings]);

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
    }, [settings.libraryPath]);

    return {
        settingsOpen,
        settings,
        isPreparingSettings: settingsActions.isPreparingSettings,
        isMigratingLibraryPath: settingsActions.isMigratingLibraryPath,
        openSettings,
        closeSettings,
        setImportMode,
        chooseLibraryPath,
        openCurrentLibraryPath,
    };
}