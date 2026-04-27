import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeTauri } from "../lib/tauri-client";
import type { LibrarySummaryInfo } from "../types/diagnostics";

function createEmptyLibrarySummary(): LibrarySummaryInfo {
    return {
        total_bytes: 0,
        formatted_size: "0 B",
        video_files: 0,
        audio_files: 0,
        thumbnail_files: 0,
    };
}

export async function getLibrarySummary(
    libraryPath: string
): Promise<LibrarySummaryInfo> {
    const normalizedLibraryPath = libraryPath.trim();

    if (!normalizedLibraryPath) {
        return createEmptyLibrarySummary();
    }

    return invokeTauri<LibrarySummaryInfo>(TAURI_COMMANDS.GET_LIBRARY_SUMMARY, {
        libraryPath: normalizedLibraryPath,
    });
}