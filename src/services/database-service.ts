import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeVoid } from "../lib/tauri-client";

/**
 * Initializes the backend database (creating and migrating the schema on first call)
 * and confirms it is reachable. Called on app startup so database errors surface early.
 */
export async function ensureDatabaseReady(): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.ENSURE_DATABASE_READY);
}
