import type { AppSettings } from "../types/settings";
import {
    ensureDirectoryExists,
    resolveExistingDirectory,
} from "../services/library-service";
import { logError } from "../utils/app-logger";

export type InitializeAppSettingsResult = {
    settings: AppSettings;
    shouldWarnAboutLibraryPath: boolean;
};

type InitializeAppSettingsOptions = {
    storedSettings: AppSettings;
};

export async function initializeAppSettings({
    storedSettings,
}: InitializeAppSettingsOptions): Promise<InitializeAppSettingsResult> {
    const storedLibraryPath = storedSettings.libraryPath.trim();
    let libraryPath = storedLibraryPath;

    if (libraryPath) {
        try {
            libraryPath = await resolveExistingDirectory(libraryPath);
        } catch (error) {
            logError("settings", "Failed to resolve stored library directory.", error, {
                libraryPath,
            });
            libraryPath = "";
        }
    }

    if (libraryPath) {
        try {
            libraryPath = await ensureDirectoryExists(libraryPath);
        } catch (error) {
            logError("settings", "Failed to ensure library directory exists.", error, {
                libraryPath,
            });
            libraryPath = "";
        }
    }

    return {
        settings: {
            importMode: storedSettings.importMode === "move" ? "move" : "copy",
            libraryPath,
            loadRemoteImages: storedSettings.loadRemoteImages,
        },
        // Only warn when a previously configured library path was lost (e.g. a removable
        // drive is unplugged or the folder was deleted). A fresh install with no stored
        // path is the normal empty state, not a warning.
        shouldWarnAboutLibraryPath: storedLibraryPath !== "" && libraryPath === "",
    };
}