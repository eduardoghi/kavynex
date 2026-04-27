import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeTauri } from "../lib/tauri-client";
import { listMediaIntegrityReferences } from "../repositories/media-repository";
import type { LibraryIntegrityReport, MediaIntegrityReference } from "../types/diagnostics";

function createEmptyLibraryIntegrityReport(): LibraryIntegrityReport {
    return {
        checked_media_files: 0,
        missing_media_files: 0,
        missing_media_examples: [],
        checked_thumbnail_files: 0,
        missing_thumbnail_files: 0,
        missing_thumbnail_examples: [],
    };
}

function normalizeNonEmptyUniquePaths(values: Array<string | null | undefined>): string[] {
    return [...new Set(values.map((value) => value?.trim() ?? "").filter((value) => value !== ""))];
}

function buildIntegrityPayload(mediaReferences: MediaIntegrityReference[]): {
    mediaPaths: string[];
    thumbnailPaths: string[];
} {
    return {
        mediaPaths: normalizeNonEmptyUniquePaths(
            mediaReferences.map((item) => item.file_path)
        ),
        thumbnailPaths: normalizeNonEmptyUniquePaths(
            mediaReferences.map((item) => item.thumbnail_path)
        ),
    };
}

export async function getLibraryIntegrity(
    libraryPath: string
): Promise<LibraryIntegrityReport> {
    const normalizedLibraryPath = libraryPath.trim();

    if (!normalizedLibraryPath) {
        return createEmptyLibraryIntegrityReport();
    }

    const mediaReferences = await listMediaIntegrityReferences();
    const payload = buildIntegrityPayload(mediaReferences);

    if (payload.mediaPaths.length === 0 && payload.thumbnailPaths.length === 0) {
        return createEmptyLibraryIntegrityReport();
    }

    return invokeTauri<LibraryIntegrityReport>(TAURI_COMMANDS.CHECK_LIBRARY_INTEGRITY, {
        libraryPath: normalizedLibraryPath,
        mediaPaths: payload.mediaPaths,
        thumbnailPaths: payload.thumbnailPaths,
    });
}