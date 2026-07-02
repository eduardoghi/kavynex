import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";

export type StoredAppSettingsPayload = {
    importMode: string | null;
    libraryPath: string | null;
};

/**
 * Reads the stored app settings from the backend database (single shared pool).
 * Returns null values for keys that were never set.
 */
export async function getStoredAppSettings(): Promise<StoredAppSettingsPayload> {
    return invokeCommand<StoredAppSettingsPayload>(TAURI_COMMANDS.GET_APP_SETTINGS);
}

/**
 * Persists both app settings keys atomically through the backend database.
 */
export async function setStoredAppSettings(
    importMode: string,
    libraryPath: string
): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.SET_APP_SETTINGS, {
        importMode,
        libraryPath,
    });
}
