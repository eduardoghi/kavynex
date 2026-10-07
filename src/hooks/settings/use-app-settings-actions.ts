import { useCallback, useState } from "react";
import type { AppSettings } from "../../types/settings";
import { resolveErrorMessage } from "../../utils/error-message";
import {
    moveLibrary,
    planChangeLibraryPath,
    type PendingLibraryMove,
} from "../../use-cases/change-library-path";
import { initializeAppSettings } from "../../use-cases/initialize-app-settings";
import { chooseExternalBackupDirectory } from "../../services/database-service";
import { getLibrarySummary, openLibraryDirectory } from "../../services/library-service";
import { parseAppError } from "../../utils/app-error";
import { LIBRARY_FOLDER_UNREACHABLE_ERROR_CODE } from "../../constants/error-codes";
import { useAsyncFlag } from "../use-async-flag";
import { useMemoObject } from "../use-memo-object";
import {
    loadStoredSettings,
    persistSettings,
    updateStoredCheckUpdatesOnStartup,
    updateStoredExternalBackupDir,
    updateStoredImportMode,
    updateStoredLibraryPath,
    updateStoredLoadRemoteImages,
} from "./use-app-settings-storage";
import { logError } from "../../utils/app-logger";

type UseAppSettingsActionsOptions = {
    onError: (message: string) => void;
    setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
};

type UseAppSettingsActionsReturn = {
    isPreparingSettings: boolean;
    hasLoadedSettings: boolean;
    isMigratingLibraryPath: boolean;
    isSavingExternalBackupDir: boolean;
    // A move of the library waiting for the user to confirm it, or null.
    pendingLibraryMove: PendingLibraryMove | null;
    prepareSettings: () => Promise<void>;
    changeLibraryPath: (currentLibraryPath: string) => Promise<void>;
    confirmLibraryMove: () => Promise<void>;
    cancelLibraryMove: () => void;
    setImportModeAction: (mode: AppSettings["importMode"]) => void;
    setLoadRemoteImagesAction: (loadRemoteImages: boolean) => void;
    setCheckUpdatesOnStartupAction: (checkUpdatesOnStartup: boolean) => void;
    openCurrentLibraryPathAction: (libraryPath: string) => Promise<void>;
    chooseExternalBackupDirAction: () => Promise<void>;
    clearExternalBackupDirAction: () => Promise<void>;
};

export function useAppSettingsActions({
    onError,
    setSettings,
}: UseAppSettingsActionsOptions): UseAppSettingsActionsReturn {
    const { isRunning: isPreparingSettings, runWithFlag: runPrepareSettings } = useAsyncFlag();
    // True once the stored settings have been read and applied. Until then `settings` holds the
    // defaults, which is not the user's choice for anything, so a consumer that acts on a stored
    // preference (the startup update check, which is on by default) has to wait for this. It stays
    // false when the read fails, since the stored value is then unknown rather than the default.
    const [hasLoadedSettings, setHasLoadedSettings] = useState(false);
    const { isRunning: isMigratingLibraryPath, runWithFlag: runLibraryPathChange } =
        useAsyncFlag();
    const { isRunning: isSavingExternalBackupDir, runWithFlag: runSaveExternalBackupDir } =
        useAsyncFlag();
    const [pendingLibraryMove, setPendingLibraryMove] = useState<PendingLibraryMove | null>(
        null
    );

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
                setHasLoadedSettings(true);

                if (result.shouldWarnAboutLibraryPath) {
                    onError(
                        "The previously selected library folder could not be found, so it was cleared. " +
                            "If it is on a removable drive, reconnect it and restart the app; otherwise " +
                            "select the library folder again in Settings."
                    );
                }
            } catch (error) {
                logError("settings", "Failed to prepare app settings.", error);
                onError(resolveErrorMessage(error, "Failed to prepare app settings."));
            }
        });
    }, [onError, runPrepareSettings, setSettings]);

    // Choosing a folder only plans the change. A first library is applied at once, and a move of an
    // existing one becomes pendingLibraryMove, which the library section shows with what is about
    // to be copied and where. It used to start copying the whole library the moment the folder
    // dialog closed, with no way to back out of a misclick.
    const changeLibraryPath = useCallback(
        async (currentLibraryPath: string): Promise<void> => {
            await runLibraryPathChange(async () => {
                try {
                    const plan = await planChangeLibraryPath({ currentLibraryPath });

                    if (plan.kind === "unchanged") {
                        return;
                    }

                    if (plan.kind === "apply") {
                        setSettings(await updateStoredLibraryPath(plan.finalLibraryPath));
                        return;
                    }

                    // Best effort. A summary that cannot be read (the current folder being gone is
                    // one reason) leaves the confirmation without sizes rather than blocking it.
                    const summary = await getLibrarySummary(plan.currentLibraryPath).catch(
                        () => null
                    );

                    setPendingLibraryMove({
                        currentLibraryPath: plan.currentLibraryPath,
                        destination: plan.destination,
                        summary,
                        currentFolderUnreachable: false,
                    });
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

    const cancelLibraryMove = useCallback((): void => {
        setPendingLibraryMove(null);
    }, []);

    const confirmLibraryMove = useCallback(async (): Promise<void> => {
        const move = pendingLibraryMove;

        if (!move) {
            return;
        }

        await runLibraryPathChange(async () => {
            try {
                const result = await moveLibrary(move);
                setPendingLibraryMove(null);

                if (!result.changed) {
                    return;
                }

                const nextSettings = await updateStoredLibraryPath(result.finalLibraryPath);
                setSettings(nextSettings);

                if (result.oldDirectoryRetained) {
                        // The migration copied everything but could not remove the old directory, so
                        // a full duplicate of the media remains on the old location with nothing to
                        // clean it up automatically. Tell the user so they can delete it by hand.
                    onError(
                        "Your library was copied to the new folder, but the old folder could not " +
                            "be removed automatically, so a full copy of your media is still there. " +
                            "The new library works normally; you can delete the old folder manually " +
                            "once you have confirmed everything is present."
                    );
                }
            } catch (error) {
                // Not a failure but a second question. The backend refuses to switch away from a
                // folder it cannot reach while media are registered in it, until the user says
                // that is what they want.
                if (
                    parseAppError(error).code === LIBRARY_FOLDER_UNREACHABLE_ERROR_CODE &&
                    !move.currentFolderUnreachable
                ) {
                    setPendingLibraryMove({ ...move, currentFolderUnreachable: true });
                    return;
                }

                setPendingLibraryMove(null);
                logError("settings", "Failed to change library folder.", error, {
                    currentLibraryPath: move.currentLibraryPath,
                });
                onError(resolveErrorMessage(error, "Failed to change library folder."));
            }
        });
    }, [onError, pendingLibraryMove, runLibraryPathChange, setSettings]);

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

    const setLoadRemoteImagesAction = useCallback(
        (loadRemoteImages: boolean): void => {
            void (async () => {
                try {
                    const nextSettings = await updateStoredLoadRemoteImages(loadRemoteImages);
                    setSettings(nextSettings);
                } catch (error) {
                    logError("settings", "Failed to change the remote images preference.", error, {
                        loadRemoteImages,
                    });
                    onError(
                        resolveErrorMessage(
                            error,
                            "Failed to change the remote images preference."
                        )
                    );
                }
            })();
        },
        [onError, setSettings]
    );

    const setCheckUpdatesOnStartupAction = useCallback(
        (checkUpdatesOnStartup: boolean): void => {
            void (async () => {
                try {
                    const nextSettings =
                        await updateStoredCheckUpdatesOnStartup(checkUpdatesOnStartup);
                    setSettings(nextSettings);
                } catch (error) {
                    logError(
                        "settings",
                        "Failed to change the startup update-check preference.",
                        error,
                        { checkUpdatesOnStartup }
                    );
                    onError(
                        resolveErrorMessage(
                            error,
                            "Failed to change the startup update-check preference."
                        )
                    );
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

    const chooseExternalBackupDirAction = useCallback(async (): Promise<void> => {
        await runSaveExternalBackupDir(async () => {
            try {
                const selectedPath = await chooseExternalBackupDirectory();

                if (!selectedPath) {
                    return;
                }

                const nextSettings = await updateStoredExternalBackupDir(selectedPath);
                setSettings(nextSettings);
            } catch (error) {
                logError("settings", "Failed to set the external backup folder.", error);
                onError(
                    resolveErrorMessage(error, "Failed to set the external backup folder.")
                );
            }
        });
    }, [onError, runSaveExternalBackupDir, setSettings]);

    const clearExternalBackupDirAction = useCallback(async (): Promise<void> => {
        await runSaveExternalBackupDir(async () => {
            try {
                const nextSettings = await updateStoredExternalBackupDir("");
                setSettings(nextSettings);
            } catch (error) {
                logError("settings", "Failed to turn off the external backup.", error);
                onError(resolveErrorMessage(error, "Failed to turn off the external backup."));
            }
        });
    }, [onError, runSaveExternalBackupDir, setSettings]);

    // Memoized so the controller object keeps a stable identity across renders, like every sibling
    // controller hook. The action members are already useCallback-stable, so this object's identity
    // only turns over when one of the boolean flags flips, which is exactly when a consumer that
    // depends on the whole object should re-render. Without this, the object was fresh every render,
    // which propagated through use-app-settings's callbacks and defeated the memo boundary
    // HomeSecondaryModals relies on (it would re-render on every yt-dlp log tick).
    return useMemoObject({
        isPreparingSettings,
        hasLoadedSettings,
        isMigratingLibraryPath,
        isSavingExternalBackupDir,
        pendingLibraryMove,
        prepareSettings,
        changeLibraryPath,
        confirmLibraryMove,
        cancelLibraryMove,
        setImportModeAction,
        setLoadRemoteImagesAction,
        setCheckUpdatesOnStartupAction,
        openCurrentLibraryPathAction,
        chooseExternalBackupDirAction,
        clearExternalBackupDirAction,
    });
}