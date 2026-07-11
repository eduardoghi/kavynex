import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeTauri } from "../lib/tauri-client";
import { listChannels } from "../repositories/channel-repository";
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

function buildIntegrityPayload(
    mediaReferences: MediaIntegrityReference[],
    channelAvatarPaths: (string | null)[]
): {
    mediaPaths: string[];
    thumbnailPaths: string[];
} {
    return {
        mediaPaths: normalizeNonEmptyUniquePaths(
            mediaReferences.map((item) => item.file_path)
        ),
        // Channel avatars live under thumbnails/ but are referenced by the channels table, not
        // by any media row. Without them here, an avatar that is not also a video thumbnail
        // would be reported as an orphan even though it is in use (and the real cleanup counts
        // it as referenced), misleading the user into deleting a file that is still needed.
        thumbnailPaths: normalizeNonEmptyUniquePaths([
            ...mediaReferences.map((item) => item.thumbnail_path),
            ...channelAvatarPaths,
        ]),
    };
}

export async function getLibraryIntegrity(
    libraryPath: string
): Promise<LibraryIntegrityReport> {
    const normalizedLibraryPath = libraryPath.trim();

    if (!normalizedLibraryPath) {
        return createEmptyLibraryIntegrityReport();
    }

    const [mediaReferences, channels] = await Promise.all([
        listMediaIntegrityReferences(),
        listChannels(),
    ]);
    const payload = buildIntegrityPayload(
        mediaReferences,
        channels.map((channel) => channel.avatar_path)
    );

    // Always call through, even with no references: the library folder may still hold orphan
    // files the database no longer knows about.
    return invokeTauri<LibraryIntegrityReport>(TAURI_COMMANDS.CHECK_LIBRARY_INTEGRITY, {
        libraryPath: normalizedLibraryPath,
        mediaPaths: payload.mediaPaths,
        thumbnailPaths: payload.thumbnailPaths,
    });
}