import { BaseDirectory, exists, readDir } from "@tauri-apps/plugin-fs";
import { listMediaIntegrityReferences } from "../repositories/media-repository";
import type { LiveChatIntegrityReport, MediaIntegrityReference } from "../types/diagnostics";

type FsEntry = {
    name?: string;
    isDirectory?: boolean;
};

function normalizeNonEmptyUniquePaths(values: Array<string | null | undefined>): string[] {
    return [...new Set(values.map((value) => value?.trim() ?? "").filter((value) => value !== ""))];
}

async function flattenRelativePaths(relativeDir: string): Promise<string[]> {
    const entries = (await readDir(relativeDir, {
        baseDir: BaseDirectory.AppData,
    })) as FsEntry[];

    const paths: string[] = [];

    for (const entry of entries) {
        const entryName = entry.name?.trim() ?? "";

        if (!entryName) {
            continue;
        }

        const nextPath = `${relativeDir}/${entryName}`;

        if (entry.isDirectory) {
            paths.push(...(await flattenRelativePaths(nextPath)));
            continue;
        }

        paths.push(nextPath);
    }

    return paths;
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

    const liveChatDirExists = await exists("live_chat", {
        baseDir: BaseDirectory.AppData,
    });

    const actualLiveChatPaths = liveChatDirExists
        ? await flattenRelativePaths("live_chat")
        : [];

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