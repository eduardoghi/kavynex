import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";
import { normalizeString } from "../utils/guards";
import { logError } from "../utils/app-logger";

export type LibrarySummaryInfo = {
    total_bytes: number;
    formatted_size: string;
    video_files: number;
    audio_files: number;
    thumbnail_files: number;
};

type MigrateLibraryDirectoryResult = {
    final_library_path: string;
    changed: boolean;
};

const EMPTY_LIBRARY_SUMMARY: LibrarySummaryInfo = {
    total_bytes: 0,
    formatted_size: "0 B",
    video_files: 0,
    audio_files: 0,
    thumbnail_files: 0,
};

export async function chooseLibraryDirectory(): Promise<string | null> {
    const selection = await open({
        directory: true,
        multiple: false,
    });

    if (typeof selection !== "string") {
        return null;
    }

    const normalizedSelection = normalizeString(selection);
    return normalizedSelection || null;
}

export async function resolveDefaultLibraryDirectory(): Promise<string> {
    const path = await invokeCommand<string>(TAURI_COMMANDS.RESOLVE_DEFAULT_LIBRARY_DIRECTORY);
    return normalizeString(path);
}

export async function ensureDirectoryExists(path: string): Promise<string> {
    const normalizedPath = normalizeString(path);

    if (!normalizedPath) {
        throw new Error("Directory path is required.");
    }

    const result = await invokeCommand<string>(TAURI_COMMANDS.ENSURE_DIRECTORY_EXISTS, {
        path: normalizedPath,
    });

    return normalizeString(result);
}

export async function resolveExistingDirectory(path: string): Promise<string> {
    const normalizedPath = normalizeString(path);

    if (!normalizedPath) {
        throw new Error("Directory path is required.");
    }

    const result = await invokeCommand<string>(TAURI_COMMANDS.RESOLVE_EXISTING_DIRECTORY, {
        path: normalizedPath,
    });

    return normalizeString(result);
}

export async function isDirectoryEmpty(path: string): Promise<boolean> {
    const normalizedPath = normalizeString(path);

    if (!normalizedPath) {
        throw new Error("Directory path is required.");
    }

    return invokeCommand<boolean>(TAURI_COMMANDS.IS_DIRECTORY_EMPTY, {
        path: normalizedPath,
    });
}

export async function migrateLibraryDirectory(
    currentLibraryPath: string,
    newLibraryPath: string
): Promise<MigrateLibraryDirectoryResult> {
    const normalizedCurrentLibraryPath = normalizeString(currentLibraryPath);
    const normalizedNewLibraryPath = normalizeString(newLibraryPath);

    if (!normalizedCurrentLibraryPath) {
        throw new Error("Current library path is required.");
    }

    if (!normalizedNewLibraryPath) {
        throw new Error("New library path is required.");
    }

    const finalLibraryPath = await invokeCommand<string>(
        TAURI_COMMANDS.MIGRATE_LIBRARY_DIRECTORY,
        {
            oldLibraryPath: normalizedCurrentLibraryPath,
            newLibraryPath: normalizedNewLibraryPath,
        }
    );

    return {
        final_library_path: normalizeString(finalLibraryPath),
        changed: true,
    };
}

export async function getLibrarySummary(path: string): Promise<LibrarySummaryInfo> {
    const normalizedPath = normalizeString(path);

    if (!normalizedPath) {
        return EMPTY_LIBRARY_SUMMARY;
    }

    try {
        const result = await invokeCommand<LibrarySummaryInfo>(TAURI_COMMANDS.GET_LIBRARY_SUMMARY, {
            libraryPath: normalizedPath,
        });

        return {
            total_bytes: Number(result.total_bytes ?? 0),
            formatted_size: normalizeString(result.formatted_size) || "0 B",
            video_files: Number(result.video_files ?? 0),
            audio_files: Number(result.audio_files ?? 0),
            thumbnail_files: Number(result.thumbnail_files ?? 0),
        };
    } catch (error) {
        logError("library-service", "Failed to get library summary.", error, {
            path: normalizedPath,
        });
        throw error;
    }
}

export async function openLibraryDirectory(path: string): Promise<void> {
    const normalizedPath = normalizeString(path);

    if (!normalizedPath) {
        throw new Error("Library path is required.");
    }

    await resolveExistingDirectory(normalizedPath);
    await invokeVoid(TAURI_COMMANDS.OPEN_PATH_IN_SYSTEM, {
        path: normalizedPath,
        libraryPath: normalizedPath,
    });
}

export async function openFileLocation(path: string, libraryPath?: string | null): Promise<void> {
    const normalizedPath = normalizeString(path);
    const normalizedLibraryPath = normalizeString(libraryPath ?? "");

    if (!normalizedPath) {
        throw new Error("Path is required.");
    }

    await invokeVoid(TAURI_COMMANDS.OPEN_PATH_IN_SYSTEM, {
        path: normalizedPath,
        libraryPath: normalizedLibraryPath || null,
    });
}

export async function openExternalUrl(url: string): Promise<void> {
    const normalizedUrl = normalizeString(url);

    if (!normalizedUrl) {
        throw new Error("URL is required.");
    }

    await openUrl(normalizedUrl);
}