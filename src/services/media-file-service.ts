import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeTauri } from "../lib/tauri-client";
import type { ImportMode } from "../types/settings";
import { normalizeString } from "../utils/guards";

export async function importMediaFile(
    sourcePath: string,
    importMode: ImportMode,
    libraryPath: string
): Promise<string> {
    const normalizedSourcePath = normalizeString(sourcePath);
    const normalizedLibraryPath = normalizeString(libraryPath);

    if (!normalizedSourcePath) {
        throw new Error("Source media path is required.");
    }

    if (!normalizedLibraryPath) {
        throw new Error("Library path is required.");
    }

    const result = await invokeTauri<string>(TAURI_COMMANDS.IMPORT_MEDIA_FILE, {
        path: normalizedSourcePath,
        mode: importMode,
        libraryPath: normalizedLibraryPath,
    });

    return normalizeString(result);
}

export async function deleteMediaFile(
    filePath: string,
    libraryPath: string
): Promise<void> {
    const normalizedFilePath = normalizeString(filePath);
    const normalizedLibraryPath = normalizeString(libraryPath);

    if (!normalizedFilePath || !normalizedLibraryPath) {
        return;
    }

    await invokeTauri(TAURI_COMMANDS.DELETE_MEDIA_FILE, {
        filePath: normalizedFilePath,
        libraryPath: normalizedLibraryPath,
    });
}