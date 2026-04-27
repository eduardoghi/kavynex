import { BaseDirectory, exists, readDir } from "@tauri-apps/plugin-fs";
import type { LiveChatStorageInfo } from "../types/diagnostics";

type FsEntry = {
    name?: string;
    isDirectory?: boolean;
};

async function countFilesRecursively(relativeDir: string): Promise<number> {
    const entries = (await readDir(relativeDir, {
        baseDir: BaseDirectory.AppData,
    })) as FsEntry[];

    let total = 0;

    for (const entry of entries) {
        const entryName = entry.name?.trim() ?? "";

        if (!entryName) {
            continue;
        }

        const nextPath = `${relativeDir}/${entryName}`;

        if (entry.isDirectory) {
            total += await countFilesRecursively(nextPath);
            continue;
        }

        total += 1;
    }

    return total;
}

export async function getLiveChatStorageSummary(): Promise<LiveChatStorageInfo> {
    const liveChatExists = await exists("live_chat", {
        baseDir: BaseDirectory.AppData,
    });

    if (!liveChatExists) {
        return {
            live_chat_files: 0,
        };
    }

    return {
        live_chat_files: await countFilesRecursively("live_chat"),
    };
}