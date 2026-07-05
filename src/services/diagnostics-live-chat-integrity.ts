import { listLiveChatFiles } from "./live-chat-service";
import { listMediaIntegrityReferences } from "../repositories/media-repository";
import type { LiveChatIntegrityReport, MediaIntegrityReference } from "../types/diagnostics";

function normalizeNonEmptyUniquePaths(values: Array<string | null | undefined>): string[] {
    return [...new Set(values.map((value) => value?.trim() ?? "").filter((value) => value !== ""))];
}

function buildExpectedLiveChatPaths(mediaReferences: MediaIntegrityReference[]): string[] {
    return normalizeNonEmptyUniquePaths(
        mediaReferences.map((item) => item.live_chat_file_path)
    );
}

function createEmptyLiveChatIntegrityReport(): LiveChatIntegrityReport {
    return {
        checked_live_chat_files: 0,
        missing_live_chat_files: 0,
        missing_live_chat_examples: [],
        orphan_live_chat_files: 0,
        orphan_live_chat_examples: [],
    };
}

export async function getLiveChatIntegrity(): Promise<LiveChatIntegrityReport> {
    const mediaReferences = await listMediaIntegrityReferences();
    const expectedLiveChatPaths = buildExpectedLiveChatPaths(mediaReferences);

    const actualLiveChatPaths = await listLiveChatFiles();

    if (expectedLiveChatPaths.length === 0 && actualLiveChatPaths.length === 0) {
        return createEmptyLiveChatIntegrityReport();
    }

    const actualSet = new Set(actualLiveChatPaths);
    const expectedSet = new Set(expectedLiveChatPaths);

    const missing = expectedLiveChatPaths.filter((path) => !actualSet.has(path));
    const orphan = actualLiveChatPaths.filter((path) => !expectedSet.has(path));

    return {
        checked_live_chat_files: expectedLiveChatPaths.length,
        missing_live_chat_files: missing.length,
        missing_live_chat_examples: missing.slice(0, 10),
        orphan_live_chat_files: orphan.length,
        orphan_live_chat_examples: orphan.slice(0, 10),
    };
}