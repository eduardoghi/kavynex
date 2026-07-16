import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand } from "../lib/tauri-client";
import type { ImportMode } from "../types/settings";
import { normalizeString } from "../utils/guards";
import { ClientError } from "../utils/app-error";

export async function importMediaFile(
    sourcePath: string,
    importMode: ImportMode,
    libraryPath: string
): Promise<string> {
    const normalizedSourcePath = normalizeString(sourcePath);
    const normalizedLibraryPath = normalizeString(libraryPath);

    if (!normalizedSourcePath) {
        throw new ClientError("Source media path is required.");
    }

    if (!normalizedLibraryPath) {
        throw new ClientError("Library path is required.");
    }

    const result = await invokeCommand(TAURI_COMMANDS.IMPORT_MEDIA_FILE, {
        path: normalizedSourcePath,
        mode: importMode,
        libraryPath: normalizedLibraryPath,
    });

    return normalizeString(result);
}