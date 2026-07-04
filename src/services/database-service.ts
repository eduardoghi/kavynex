import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";

export type DatabaseBackupStatus = {
    available: boolean;
    backedUpAtMs: number | null;
};

/**
 * Initializes the backend database (creating and migrating the schema on first call)
 * and confirms it is reachable. Called on app startup so database errors surface early.
 */
export async function ensureDatabaseReady(): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.ENSURE_DATABASE_READY);
}

/**
 * Reports whether a database backup exists that could be restored, and when it was taken.
 * Used to offer recovery when {@link ensureDatabaseReady} fails.
 */
export async function getDatabaseBackupStatus(): Promise<DatabaseBackupStatus> {
    return invokeCommand<DatabaseBackupStatus>(TAURI_COMMANDS.GET_DATABASE_BACKUP_STATUS);
}

/**
 * Restores the database from the most recent healthy backup, moving the corrupt database
 * aside. Only valid while the database is closed (after a failed open).
 */
export async function restoreDatabaseFromBackup(): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.RESTORE_DATABASE_FROM_BACKUP);
}
