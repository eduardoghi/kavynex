import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";
import type { StoredAppSettingsPayload } from "../types/generated/StoredAppSettingsPayload";

// Generated from the Rust `StoredAppSettings` struct by ts-rs; re-exported for callers.
export type { StoredAppSettingsPayload };

/**
 * Reads the stored app settings from the backend database (single shared pool).
 * Returns null values for keys that were never set.
 */
export async function getStoredAppSettings(): Promise<StoredAppSettingsPayload> {
    return invokeCommand(TAURI_COMMANDS.GET_APP_SETTINGS);
}

/**
 * Persists all app settings keys atomically through the backend database.
 */
export async function setStoredAppSettings(
    importMode: string,
    libraryPath: string,
    loadRemoteImages: boolean,
    checkUpdatesOnStartup: boolean
): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.SET_APP_SETTINGS, {
        importMode,
        libraryPath,
        loadRemoteImages,
        checkUpdatesOnStartup,
    });
}

/**
 * Persists the external database backup directory. An empty string turns the feature off. Its own
 * command rather than a field on {@link setStoredAppSettings}, so toggling the backup destination
 * never has to round-trip the whole settings form. The backend validates the path is an existing
 * directory.
 */
export async function setExternalBackupDir(path: string): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.SET_EXTERNAL_BACKUP_DIR, { path });
}
