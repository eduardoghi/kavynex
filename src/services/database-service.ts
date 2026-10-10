import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";
import { pickFolder } from "./file-dialog-service";
import type { DatabaseBackupStatus } from "../types/generated/DatabaseBackupStatus";
import type { DatabaseCompaction } from "../types/generated/DatabaseCompaction";
import type { DatabaseIntegrityReport } from "../types/generated/DatabaseIntegrityReport";
import type { ExternalBackupStatus } from "../types/generated/ExternalBackupStatus";

export type {
    DatabaseBackupStatus,
    DatabaseCompaction,
    DatabaseIntegrityReport,
    ExternalBackupStatus,
};

/**
 * Initializes the backend database (creating and migrating the schema on first call)
 * and confirms it is reachable. Called on app startup so database errors surface early.
 */
export async function ensureDatabaseReady(): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.ENSURE_DATABASE_READY);
}

/**
 * Opens a new, empty database in place of a missing one whose backups are still on disk. For the
 * user who chose to start over instead of restoring. The backups are left where they are.
 */
export async function startWithEmptyDatabase(): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.START_WITH_EMPTY_DATABASE);
}

/**
 * Reports whether a database backup exists that could be restored, and when it was taken.
 * Used to offer recovery when {@link ensureDatabaseReady} fails.
 */
export async function getDatabaseBackupStatus(): Promise<DatabaseBackupStatus> {
    return invokeCommand(TAURI_COMMANDS.GET_DATABASE_BACKUP_STATUS);
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
 * Whether the external database mirror is set up, its folder reachable, and when it last copied.
 */
export async function getExternalBackupStatus(): Promise<ExternalBackupStatus> {
    return invokeCommand(TAURI_COMMANDS.GET_EXTERNAL_BACKUP_STATUS);
}

/**
 * Opens a directory picker for the automatic external backup folder (Settings > Database).
 * Returns the chosen path, or null if the dialog was cancelled.
 */
export async function chooseExternalBackupDirectory(): Promise<string | null> {
    return pickFolder("externalBackup");
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
    return invokeCommand(TAURI_COMMANDS.GET_DATABASE_IMPORT_UNDO_STATUS);
}

/**
 * Reverts the last applied database import by staging the pre-import snapshot. Like an import,
 * the swap is applied on the next startup, so the caller must relaunch the app after this
 * resolves.
 */
export async function undoDatabaseImport(): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.UNDO_DATABASE_IMPORT);
}

/**
 * Runs a full `PRAGMA integrity_check` against the live database, a more thorough (and
 * slower) check than the quick check used by the automatic health paths. Resolves to what SQLite
 * reported. The problems it listed, not just whether the check passed, so a failing check can say
 * what is wrong rather than only that something is.
 */
export async function checkDatabaseIntegrity(): Promise<DatabaseIntegrityReport> {
    return invokeCommand(TAURI_COMMANDS.CHECK_DATABASE_INTEGRITY);
}

/**
 * Runs `VACUUM` on the live database, which gives the space deleted rows left behind back to the
 * disk. Resolves to how much smaller the database got.
 */
export async function compactDatabase(): Promise<DatabaseCompaction> {
    return invokeCommand(TAURI_COMMANDS.COMPACT_DATABASE);
}
