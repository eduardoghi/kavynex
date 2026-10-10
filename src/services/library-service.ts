import { pickFolder } from "./file-dialog-service";
import { TAURI_COMMANDS } from "../constants/tauri-commands";
import {
    invokeCommand,
    invokeVoid,
    migrateLibraryWithProgress,
    streamLibraryVerification,
} from "../lib/tauri-client";
import type { LibraryMigrationProgress } from "../types/generated/LibraryMigrationProgress";
import { normalizeString } from "../utils/guards";
import { logError } from "../utils/app-logger";
import { ClientError } from "../utils/app-error";
import type { LibrarySummaryInfo } from "../types/generated/LibrarySummaryInfo";
import type { MigrateLibraryDirectoryResult } from "../types/generated/MigrateLibraryDirectoryResult";
import type { ContentVerificationReport } from "../types/generated/ContentVerificationReport";

export type { LibrarySummaryInfo };

/**
 * Re-reads every content-addressed file in the library and checks it against the hash in its own
 * name, calling `onProgress` as it goes and resolving with the report.
 *
 * Long by nature. It reads every byte the library holds, which is why the caller drives a progress
 * bar and offers `cancelLibraryVerification` rather than showing a spinner. Only one runs at a time;
 * a second call is refused by the backend rather than queued.
 */
export async function verifyLibraryContent(
    libraryPath: string,
    onProgress: (checked: number, total: number) => void
): Promise<ContentVerificationReport> {
    const normalized = normalizeString(libraryPath);

    if (!normalized) {
        throw new ClientError("A library folder is required.");
    }

    return streamLibraryVerification(onProgress);
}

/**
 * Asks a running verification to stop. Safe to call when none is running.
 */
export async function cancelLibraryVerification(): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.CANCEL_LIBRARY_VERIFICATION);
}

export function createEmptyLibrarySummary(): LibrarySummaryInfo {
    return {
        total_bytes: 0,
        formatted_size: "0 B",
        video_files: 0,
        audio_files: 0,
        thumbnail_files: 0,
    };
}

export async function chooseLibraryDirectory(): Promise<string | null> {
    return pickFolder();
}

export async function ensureDirectoryExists(path: string): Promise<string> {
    const normalizedPath = normalizeString(path);

    if (!normalizedPath) {
        throw new ClientError("Directory path is required.");
    }

    const result = await invokeCommand(TAURI_COMMANDS.ENSURE_DIRECTORY_EXISTS, {
        path: normalizedPath,
    });

    return normalizeString(result);
}

export async function resolveExistingDirectory(path: string): Promise<string> {
    const normalizedPath = normalizeString(path);

    if (!normalizedPath) {
        throw new ClientError("Directory path is required.");
    }

    const result = await invokeCommand(TAURI_COMMANDS.RESOLVE_EXISTING_DIRECTORY, {
        path: normalizedPath,
    });

    return normalizeString(result);
}

export async function migrateLibraryDirectory(
    currentLibraryPath: string,
    newLibraryPath: string,
    // switchWithoutMoving is the user's confirmation that the current folder cannot be reached and
    // the library should point at the new one anyway, with nothing moved. onProgress follows the
    // copy, which cancelLibraryMigration can stop.
    options: {
        switchWithoutMoving?: boolean;
        onProgress?: (progress: LibraryMigrationProgress) => void;
    } = {}
): Promise<MigrateLibraryDirectoryResult> {
    const normalizedCurrentLibraryPath = normalizeString(currentLibraryPath);
    const normalizedNewLibraryPath = normalizeString(newLibraryPath);

    if (!normalizedCurrentLibraryPath) {
        throw new ClientError("Current library path is required.");
    }

    if (!normalizedNewLibraryPath) {
        throw new ClientError("New library path is required.");
    }

    // The command returns the full MigrateLibraryDirectoryResult (final path, whether anything
    // changed, and whether the old directory was retained); return it as-is rather than rebuilding
    // it. It is validated against migrateLibraryDirectoryResultSchema in invokeCommand.
    return migrateLibraryWithProgress(
        {
            oldLibraryPath: normalizedCurrentLibraryPath,
            newLibraryPath: normalizedNewLibraryPath,
            switchWithoutMoving: options.switchWithoutMoving ?? false,
        },
        options.onProgress ?? (() => undefined)
    );
}

/**
 * Asks a running library migration to stop copying. Safe to call when none is running.
 */
export async function cancelLibraryMigration(): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.CANCEL_LIBRARY_MIGRATION);
}

// The functions below that take the library path send it nowhere. The backend reads the library
// from the settings. They use it to skip a call that cannot succeed while no library is configured.

export async function getLibrarySummary(path: string): Promise<LibrarySummaryInfo> {
    const normalizedPath = normalizeString(path);

    if (!normalizedPath) {
        return createEmptyLibrarySummary();
    }

    try {
        const result = await invokeCommand(TAURI_COMMANDS.GET_LIBRARY_SUMMARY);

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
        throw new ClientError("Library path is required.");
    }

    await resolveExistingDirectory(normalizedPath);
    await invokeVoid(TAURI_COMMANDS.OPEN_PATH_IN_SYSTEM, { path: normalizedPath });
}

export async function openFileLocation(path: string, libraryPath: string): Promise<void> {
    const normalizedPath = normalizeString(path);
    const normalizedLibraryPath = normalizeString(libraryPath);

    if (!normalizedPath) {
        throw new ClientError("Path is required.");
    }

    if (!normalizedLibraryPath) {
        throw new ClientError("Library path is required.");
    }

    await invokeVoid(TAURI_COMMANDS.OPEN_PATH_IN_SYSTEM, { path: normalizedPath });
}

// Opens the app's log directory in the OS file manager. Unlike the two above it passes no path.
// The backend resolves it from `app_log_dir()`, which is what makes the command safe without a
// containment check (see src-tauri/src/commands/logging.rs). There is nothing here to normalize or
// reject, so this is a direct call rather than a validating wrapper.
export async function openLogDirectory(): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.OPEN_LOG_DIRECTORY);
}

// Opens a video's YouTube page in the system browser. The backend builds the URL from the id.
export async function openYoutubeVideo(videoId: string): Promise<void> {
    const normalizedVideoId = normalizeString(videoId);

    if (!normalizedVideoId) {
        throw new ClientError("A YouTube video id is required.");
    }

    await invokeVoid(TAURI_COMMANDS.OPEN_YOUTUBE_VIDEO, { videoId: normalizedVideoId });
}

// Opens a channel's YouTube page (by its UC... id) in the system browser.
export async function openYoutubeChannel(channelId: string): Promise<void> {
    const normalizedChannelId = normalizeString(channelId);

    if (!normalizedChannelId) {
        throw new ClientError("A YouTube channel id is required.");
    }

    await invokeVoid(TAURI_COMMANDS.OPEN_YOUTUBE_CHANNEL, { channelId: normalizedChannelId });
}