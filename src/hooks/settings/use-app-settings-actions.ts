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
import {
    cancelLibraryMigration,
    getLibrarySummary,
    openLibraryDirectory,
    resolveExistingDirectory,
} from "../../services/library-service";
import { displayWindowsPath } from "../../utils/paths";
import type { LibraryMigrationProgress } from "../../types/generated/LibraryMigrationProgress";
import { parseAppError } from "../../utils/app-error";
import {
    LIBRARY_FOLDER_UNREACHABLE_ERROR_CODE,
    LIBRARY_MIGRATION_CANCELLED_ERROR_CODE,
} from "../../constants/error-codes";
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
    // For an outcome that is not a failure, such as a move the user cancelled.
    onNotice?: (message: string) => void;
    setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
};

type UseAppSettingsActionsReturn = {
    isPreparingSettings: boolean;
    hasLoadedSettings: boolean;
    isMigratingLibraryPath: boolean;
    isSavingExternalBackupDir: boolean;
    // The configured library folder could not be reached at startup. The path stays configured;
    // see initializeAppSettings.
    isLibraryUnreachable: boolean;
    isRetryingLibraryFolder: boolean;
    // A move of the library waiting for the user to confirm it, or null.
    pendingLibraryMove: PendingLibraryMove | null;
    // How far the copy of a confirmed move has got, or null when none is copying.
    libraryMoveProgress: LibraryMigrationProgress | null;
    prepareSettings: () => Promise<void>;
    changeLibraryPath: (currentLibraryPath: string) => Promise<void>;
    confirmLibraryMove: () => Promise<void>;
    cancelLibraryMove: () => void;
    // Stops a move that is copying. The old library stays as it was.
    cancelRunningLibraryMove: () => Promise<void>;
    // Checks the unreachable library folder again, and starts over with it once it is back.
    retryLibraryFolder: (libraryPath: string) => Promise<void>;
    setImportModeAction: (mode: AppSettings["importMode"]) => void;
    setLoadRemoteImagesAction: (loadRemoteImages: boolean) => void;
    setCheckUpdatesOnStartupAction: (checkUpdatesOnStartup: boolean) => void;
    openCurrentLibraryPathAction: (libraryPath: string) => Promise<void>;
    chooseExternalBackupDirAction: () => Promise<void>;
    clearExternalBackupDirAction: () => Promise<void>;
};

export function useAppSettingsActions({
    onError,
    onNotice = onError,
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
    const { isRunning: isRetryingLibraryFolder, runWithFlag: runRetryLibraryFolder } =
        useAsyncFlag();
    const [isLibraryUnreachable, setIsLibraryUnreachable] = useState(false);
    const [pendingLibraryMove, setPendingLibraryMove] = useState<PendingLibraryMove | null>(
        null
    );
    const [libraryMoveProgress, setLibraryMoveProgress] =
        useState<LibraryMigrationProgress | null>(null);

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
                //
                // Not when the folder is unreachable. Then the stored path is what the database
                // already holds, and leaving it untouched is the point. Clearing it and writing it
                // back empty would leave reconnecting the drive and restarting with nothing to
                // reconnect to, and the next folder picked would be taken as a first library
                // instead of a switch the backend asks about.
                if (!result.libraryUnreachable) {
                    await persistSettings(result.settings);
                }

                setSettings(result.settings);
                setIsLibraryUnreachable(result.libraryUnreachable);
                setHasLoadedSettings(true);

                if (result.libraryUnreachable) {
                    onError(
                        `Kavynex cannot reach the library folder ${displayWindowsPath(result.settings.libraryPath)}. ` +
                            "If it is on a drive that is not connected, connect it and choose Try " +
                            "again in Settings > Library folder. The folder is still configured, and " +
                            "nothing was changed."
                    );
                }
            } catch (error) {
                logError("settings", "Failed to prepare app settings.", error);
                onError(resolveErrorMessage(error, "Failed to prepare app settings."));
            }
        });
    }, [onError, runPrepareSettings, setSettings]);

    // Reloads the app once the folder answers again rather than only clearing the flag. Images that
    // failed to load while it was gone do not retry on their own, and a fresh start registers the
    // folder's asset scope and stores its canonical path the way every launch does.
    const reloadIfLibraryIsBack = useCallback(async (libraryPath: string): Promise<boolean> => {
        try {
            await resolveExistingDirectory(libraryPath);
        } catch {
            return false;
        }

        window.location.reload();
        return true;
    }, []);

    const retryLibraryFolder = useCallback(
        async (libraryPath: string): Promise<void> => {
            await runRetryLibraryFolder(async () => {
                if (await reloadIfLibraryIsBack(libraryPath)) {
                    return;
                }

                onError(
                    `Kavynex still cannot reach ${displayWindowsPath(libraryPath)}. Check that its ` +
                        "drive is connected, or choose another folder."
                );
            });
        },
        [onError, reloadIfLibraryIsBack, runRetryLibraryFolder]
    );

    // Choosing a folder only plans the change. A first library is applied at once, and a move of an
    // existing one becomes pendingLibraryMove, which the library section shows with what is about
    // to be copied and where. Copying the whole library the moment the folder dialog closed would
    // leave no way to back out of a misclick.
    const changeLibraryPath = useCallback(
        async (currentLibraryPath: string): Promise<void> => {
            // Without the stored settings, an empty current path is not "no library yet", and a
            // folder picked now would be stored over the real one without moving anything.
            if (!hasLoadedSettings) {
                onError(
                    "Kavynex could not read its settings, so the library folder cannot be changed right now. Restart the app and try again."
                );
                return;
            }

            await runLibraryPathChange(async () => {
                try {
                    const plan = await planChangeLibraryPath({ currentLibraryPath });

                    if (plan.kind === "unchanged") {
                        // Picking the configured folder itself after reconnecting its drive is the
                        // natural way to say it is back. A cancelled dialog lands here too, so a
                        // folder still missing stays quiet rather than reporting an error nobody
                        // asked about.
                        if (isLibraryUnreachable) {
                            await reloadIfLibraryIsBack(currentLibraryPath);
                        }

                        return;
                    }

                    if (plan.kind === "apply") {
                        setSettings(await updateStoredLibraryPath(plan.finalLibraryPath));
                        return;
                    }

                    // Known to be gone, so the question is the second one straight away (switch
                    // without moving anything) rather than a move confirmation the backend would
                    // only turn into it.
                    if (isLibraryUnreachable) {
                        setPendingLibraryMove({
                            currentLibraryPath: plan.currentLibraryPath,
                            destination: plan.destination,
                            summary: null,
                            currentFolderUnreachable: true,
                        });
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
        [
            hasLoadedSettings,
            isLibraryUnreachable,
            onError,
            reloadIfLibraryIsBack,
            runLibraryPathChange,
            setSettings,
        ]
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
                const result = await moveLibrary(move, setLibraryMoveProgress);
                setLibraryMoveProgress(null);
                setPendingLibraryMove(null);

                if (!result.changed) {
                    return;
                }

                // The move is done and the old folder may already be gone, so a failure to store the
                // new path is not "the move failed". The backend's commit marker points the next
                // start at the new folder, which is what the user is told to do.
                let nextSettings: AppSettings;

                try {
                    nextSettings = await updateStoredLibraryPath(result.finalLibraryPath);
                } catch (error) {
                    logError("settings", "The library was moved, but its new path was not saved.", error);
                    onError(
                        "Your library was moved to the new folder, but the setting pointing at it could not be saved. Restart Kavynex, and it picks the new folder up."
                    );
                    return;
                }

                setSettings(nextSettings);
                setIsLibraryUnreachable(false);

                if (result.oldDirectoryRetained) {
                    // The migration copied everything but could not remove the old directory, or
                    // part of it, so media remain on the old location with nothing to clean them up
                    // automatically. Tell the user so they can delete them by hand.
                    onError(
                        "Your library was copied to the new folder, but the old folder could not " +
                            "be removed completely, so some or all of your media are still there. " +
                            "The new library works normally. You can delete the old folder manually " +
                            "once you have confirmed everything is present."
                    );
                }
            } catch (error) {
                setLibraryMoveProgress(null);

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

                // What the user clicked for. The message still says where the partial copy is.
                if (parseAppError(error).code === LIBRARY_MIGRATION_CANCELLED_ERROR_CODE) {
                    onNotice(resolveErrorMessage(error, "The move was cancelled."));
                    return;
                }

                logError("settings", "Failed to change library folder.", error, {
                    currentLibraryPath: move.currentLibraryPath,
                });
                onError(resolveErrorMessage(error, "Failed to change library folder."));
            }
        });
    }, [onError, onNotice, pendingLibraryMove, runLibraryPathChange, setSettings]);

    const cancelRunningLibraryMove = useCallback(async (): Promise<void> => {
        try {
            await cancelLibraryMigration();
        } catch (error) {
            logError("settings", "Failed to cancel the library move.", error);
            onError(resolveErrorMessage(error, "Failed to cancel the library move."));
        }
    }, [onError]);

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
        isLibraryUnreachable,
        isRetryingLibraryFolder,
        pendingLibraryMove,
        libraryMoveProgress,
        prepareSettings,
        changeLibraryPath,
        confirmLibraryMove,
        cancelLibraryMove,
        cancelRunningLibraryMove,
        retryLibraryFolder,
        setImportModeAction,
        setLoadRemoteImagesAction,
        setCheckUpdatesOnStartupAction,
        openCurrentLibraryPathAction,
        chooseExternalBackupDirAction,
        clearExternalBackupDirAction,
    });
}