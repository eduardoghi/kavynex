import type { AppSettings } from "../types/settings";
import {
    ensureDirectoryExists,
    resolveExistingDirectory,
} from "../services/library-service";
import { logError } from "../utils/app-logger";

export type InitializeAppSettingsResult = {
    settings: AppSettings;
    // The stored library folder could not be reached (a drive that is not connected, a share that
    // is offline). `settings.libraryPath` still holds the stored path. It is kept rather than
    // cleared, because clearing it is what made "reconnect the drive and restart" impossible, and
    // what let the next folder the user picked be taken as a first library instead of a switch the
    // backend asks about.
    libraryUnreachable: boolean;
};

type InitializeAppSettingsOptions = {
    storedSettings: AppSettings;
};

export async function initializeAppSettings({
    storedSettings,
}: InitializeAppSettingsOptions): Promise<InitializeAppSettingsResult> {
    const storedLibraryPath = storedSettings.libraryPath.trim();
    let libraryPath = storedLibraryPath;
    let libraryUnreachable = false;

    if (libraryPath) {
        try {
            libraryPath = await resolveExistingDirectory(libraryPath);
            libraryPath = await ensureDirectoryExists(libraryPath);
        } catch (error) {
            logError("settings", "The stored library directory is unreachable.", error, {
                libraryPath,
            });
            libraryPath = storedLibraryPath;
            libraryUnreachable = true;
        }
    }

    return {
        settings: {
            importMode: storedSettings.importMode === "move" ? "move" : "copy",
            libraryPath,
            loadRemoteImages: storedSettings.loadRemoteImages,
            checkUpdatesOnStartup: storedSettings.checkUpdatesOnStartup,
            externalBackupDir: storedSettings.externalBackupDir,
        },
        libraryUnreachable,
    };
}
