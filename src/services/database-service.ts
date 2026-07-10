import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";
import type { DatabaseBackupStatus } from "../types/generated/DatabaseBackupStatus";

export type { DatabaseBackupStatus };

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

/**
 * Exports a consistent snapshot of the database to a user-chosen path, so it can be kept
 * off-machine or moved to another install. Distinct from the internal corruption-recovery
 * backup (which lives next to the live database).
 */
export async function exportDatabase(destinationPath: string): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.EXPORT_DATABASE, { destinationPath });
}

/**
 * Validates and stages a database file for import. The swap is applied on the next startup,
 * so the caller must relaunch the app after this resolves.
 */
export async function importDatabase(sourcePath: string): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.IMPORT_DATABASE, { sourcePath });
}

/**
 * Reports whether the last applied database import can still be undone (a snapshot of the
 * database from before that import exists). Used to offer recovery when the wrong or an
 * incompatible database was imported.
 */
export async function getDatabaseImportUndoStatus(): Promise<boolean> {
    return invokeCommand<boolean>(TAURI_COMMANDS.GET_DATABASE_IMPORT_UNDO_STATUS);
}

/**
 * Reverts the last applied database import by staging the pre-import snapshot. Like an import,
 * the swap is applied on the next startup, so the caller must relaunch the app after this
 * resolves.
 */
export async function undoDatabaseImport(): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.UNDO_DATABASE_IMPORT);
}
