import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand } from "../lib/tauri-client";
import type { DiagnosticsMediaTarget, LibraryIntegrityReport } from "../types/diagnostics";

// Result of the library-integrity check. The raw report plus a lookup from a stored media file
// path to the media row it belongs to, so the diagnostics UI can turn a "missing media" path into
// a jump-to-the-media action.
//
// Both halves come from one command now. This module used to assemble them here. It pulled every
// media row over IPC, built three arrays holding every stored path, and sent those back to the
// backend, which had the same rows two queries away the whole time. That made a check whose output
// is capped at five examples per category cost time and memory proportional to the entire library,
// in both directions. The mapping is kept as a `Record` rather than the command's own shape so the
// consumer (diagnostics-rules) is unchanged.
export type LibraryIntegrityResult = {
    report: LibraryIntegrityReport;
    mediaByPath: Record<string, DiagnosticsMediaTarget>;
};

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

export async function getLibraryIntegrity(
    libraryPath: string
): Promise<LibraryIntegrityResult> {
    const normalizedLibraryPath = libraryPath.trim();

    if (!normalizedLibraryPath) {
        return { report: createEmptyLibraryIntegrityReport(), mediaByPath: {} };
    }

    // Always call through, even when the database holds no rows. The library folder may still
    // hold orphan files nothing references, which is the half of the report the rows cannot
    // answer.
    const check = await invokeCommand(TAURI_COMMANDS.CHECK_LIBRARY_INTEGRITY, {
        libraryPath: normalizedLibraryPath,
    });

    return { report: check.report, mediaByPath: check.mediaTargets };
}
