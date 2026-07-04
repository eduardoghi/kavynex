import { useCallback } from "react";
import type { AppSettings } from "../types/settings";
import { resolveErrorMessage } from "../utils/error-message";
import { executeChangeLibraryPath } from "../use-cases/change-library-path";
import { initializeAppSettings } from "../use-cases/initialize-app-settings";
import { openLibraryDirectory } from "../services/library-service";
import { useAsyncFlag } from "./use-async-flag";
import {
    loadStoredSettings,
    persistSettings,
    updateStoredImportMode,
    updateStoredLibraryPath,
} from "./use-app-settings-storage";
import { logError } from "../utils/app-logger";

type UseAppSettingsActionsOptions = {
    onError: (message: string) => void;
    setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
};

type UseAppSettingsActionsReturn = {
    isPreparingSettings: boolean;
    isMigratingLibraryPath: boolean;
    prepareSettings: () => Promise<void>;
    changeLibraryPath: (currentLibraryPath: string) => Promise<void>;
    setImportModeAction: (mode: AppSettings["importMode"]) => void;
    openCurrentLibraryPathAction: (libraryPath: string) => Promise<void>;
};

export function useAppSettingsActions({
    onError,
    setSettings,
}: UseAppSettingsActionsOptions): UseAppSettingsActionsReturn {
    const { isRunning: isPreparingSettings, runWithFlag: runPrepareSettings } = useAsyncFlag();
    const { isRunning: isMigratingLibraryPath, runWithFlag: runLibraryPathChange } =
        useAsyncFlag();

    const prepareSettings = useCallback(async (): Promise<void> => {
        await runPrepareSettings(async () => {
            try {
                const storedSettings = await loadStoredSettings();
                const result = await initializeAppSettings({
                    storedSettings,
                });

                // Persist before exposing the settings to the UI. The library path state
                // drives the asset-scope registration effect, and the backend validates
                // the requested path against the persisted library path, so the database
                // must already hold the value before that effect can fire.
                await persistSettings(result.settings);
                setSettings(result.settings);
            } catch (error) {
                logError("settings", "Failed to prepare app settings.", error);
                onError(resolveErrorMessage(error, "Failed to prepare app settings."));
            }
        });
    }, [onError, runPrepareSettings, setSettings]);

    const changeLibraryPath = useCallback(
        async (currentLibraryPath: string): Promise<void> => {
            await runLibraryPathChange(async () => {
                try {
                    const result = await executeChangeLibraryPath({
                        currentLibraryPath,
                    });

                    if (!result.changed) {
                        return;
                    }

                    const nextSettings = await updateStoredLibraryPath(result.finalLibraryPath);
                    setSettings(nextSettings);
                } catch (error) {
                    logError("settings", "Failed to change library folder.", error, {
                        currentLibraryPath,
                    });
                    onError(resolveErrorMessage(error, "Failed to change library folder."));
                }
            });
        },
        [onError, runLibraryPathChange, setSettings]
    );

    const setImportModeAction = useCallback(
        (mode: AppSettings["importMode"]): void => {
            void (async () => {
                try {
                    const nextSettings = await updateStoredImportMode(mode);
                    setSettings(nextSettings);
                } catch (error) {
                    logError("settings", "Failed to change import mode.", error, {
                        mode,
                    });
                    onError(resolveErrorMessage(error, "Failed to change import mode."));
                }
            })();
        },
        [onError, setSettings]
    );

    const openCurrentLibraryPathAction = useCallback(
        async (libraryPath: string): Promise<void> => {
            try {
                await openLibraryDirectory(libraryPath);
            } catch (error) {
                logError("settings", "Failed to open library folder.", error, {
                    libraryPath,
                });
                onError(resolveErrorMessage(error, "Failed to open library folder."));
            }
        },
        [onError]
    );

    return {
        isPreparingSettings,
        isMigratingLibraryPath,
        prepareSettings,
        changeLibraryPath,
        setImportModeAction,
        openCurrentLibraryPathAction,
    };
}