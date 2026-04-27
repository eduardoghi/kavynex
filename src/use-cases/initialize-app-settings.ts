import type { AppSettings } from "../types/settings";
import {
    ensureDirectoryExists,
    resolveExistingDirectory,
} from "../services/library-service";
import { parseAppError } from "../utils/app-error";

const DEFAULT_SETTINGS: AppSettings = {
    importMode: "copy",
    libraryPath: "",
};

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
    let libraryPath = storedSettings.libraryPath.trim();

    if (libraryPath) {
        try {
            libraryPath = await resolveExistingDirectory(libraryPath);
        } catch (error) {
            console.error(
                "Failed to resolve stored library directory:",
                parseAppError(error)
            );
            libraryPath = "";
        }
    }

    if (libraryPath) {
        try {
            libraryPath = await ensureDirectoryExists(libraryPath);
        } catch (error) {
            console.error(
                "Failed to ensure library directory exists:",
                parseAppError(error)
            );
            libraryPath = "";
        }
    }

    return {
        settings: {
            importMode: storedSettings.importMode === "move" ? "move" : "copy",
            libraryPath,
        },
        shouldWarnAboutLibraryPath: !libraryPath,
    };
}

export function getDefaultAppSettings(): AppSettings {
    return DEFAULT_SETTINGS;
}