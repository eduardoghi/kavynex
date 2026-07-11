import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeTauri } from "../lib/tauri-client";
import { listMediaIntegrityReferences } from "../repositories/media-repository";
import type { LibraryIntegrityReport, MediaIntegrityReference } from "../types/diagnostics";
import { normalizeNonEmptyUniquePaths } from "../utils/paths";

function createEmptyLibraryIntegrityReport(): LibraryIntegrityReport {
    return {
        checked_media_files: 0,
        missing_media_files: 0,
        missing_media_examples: [],
        checked_thumbnail_files: 0,
        missing_thumbnail_files: 0,
        missing_thumbnail_examples: [],
        orphan_media_files: 0,
        orphan_media_examples: [],
        orphan_thumbnail_files: 0,
        orphan_thumbnail_examples: [],
        invalid_media_files: 0,
        invalid_media_examples: [],
        invalid_thumbnail_files: 0,
        invalid_thumbnail_examples: [],
    };
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

    // Always call through, even with no references: the library folder may still hold orphan
    // files the database no longer knows about.
    return invokeTauri<LibraryIntegrityReport>(TAURI_COMMANDS.CHECK_LIBRARY_INTEGRITY, {
        libraryPath: normalizedLibraryPath,
        mediaPaths: payload.mediaPaths,
        thumbnailPaths: payload.thumbnailPaths,
    });
}