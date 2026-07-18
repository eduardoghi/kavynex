import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand } from "../lib/tauri-client";
import { listChannels } from "../repositories/channel-repository";
import { listMediaIntegrityReferences } from "../repositories/media-repository";
import type {
    DiagnosticsMediaTarget,
    LibraryIntegrityReport,
    MediaIntegrityReference,
} from "../types/diagnostics";
import { normalizeNonEmptyUniquePaths } from "../utils/paths";

// Result of the library-integrity check: the raw report plus a lookup from a stored media
// file path to the media row it belongs to, so the diagnostics UI can turn a "missing media"
// path into a jump-to-the-media action. Keyed by the same normalization the backend uses for
// the example paths it echoes back (trimmed, forward slashes).
export type LibraryIntegrityResult = {
    report: LibraryIntegrityReport;
    mediaByPath: Record<string, DiagnosticsMediaTarget>;
};

function normalizePathKey(path: string): string {
    return path.trim().replace(/\\/g, "/");
}

function buildMediaByPath(
    mediaReferences: MediaIntegrityReference[]
): Record<string, DiagnosticsMediaTarget> {
    const mediaByPath: Record<string, DiagnosticsMediaTarget> = {};

    for (const reference of mediaReferences) {
        const key = normalizePathKey(reference.file_path);

        if (key) {
            mediaByPath[key] = {
                channelId: reference.channel_id,
                mediaId: reference.id,
            };
        }
    }

    return mediaByPath;
}

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
        corrupt_media_files: 0,
        corrupt_media_examples: [],
        corrupt_thumbnail_files: 0,
        corrupt_thumbnail_examples: [],
        checked_live_chat_files: 0,
        missing_live_chat_files: 0,
        missing_live_chat_examples: [],
        corrupt_live_chat_files: 0,
        corrupt_live_chat_examples: [],
        orphan_live_chat_files: 0,
        orphan_live_chat_examples: [],
        invalid_live_chat_files: 0,
        invalid_live_chat_examples: [],
    };
}

function buildIntegrityPayload(
    mediaReferences: MediaIntegrityReference[],
    channelAvatarPaths: (string | null)[]
): {
    mediaPaths: string[];
    thumbnailPaths: string[];
    liveChatPaths: string[];
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
        liveChatPaths: normalizeNonEmptyUniquePaths(
            mediaReferences.map((item) => item.live_chat_file_path)
        ),
    };
}

export async function getLibraryIntegrity(
    libraryPath: string
): Promise<LibraryIntegrityResult> {
    const normalizedLibraryPath = libraryPath.trim();

    if (!normalizedLibraryPath) {
        return { report: createEmptyLibraryIntegrityReport(), mediaByPath: {} };
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
    const report = await invokeCommand(
        TAURI_COMMANDS.CHECK_LIBRARY_INTEGRITY,
        {
            libraryPath: normalizedLibraryPath,
            mediaPaths: payload.mediaPaths,
            thumbnailPaths: payload.thumbnailPaths,
            liveChatPaths: payload.liveChatPaths,
        }
    );

    return { report, mediaByPath: buildMediaByPath(mediaReferences) };
}