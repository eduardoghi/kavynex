import {
    BaseDirectory,
    exists,
    mkdir,
    readDir,
    readTextFile,
    remove,
    writeTextFile,
} from "@tauri-apps/plugin-fs";
import { createAppError } from "../utils/app-error";

export type LiveChatMessageItem = {
    message_id: string | null;
    message_offset_ms: number;
    author_name: string;
    author_channel_id: string | null;
    author_thumbnail: string | null;
    author_badges: string | null;
    message_text: string;
    timestamp_text: string | null;
    amount_text: string | null;
    header_primary_text: string | null;
    header_secondary_text: string | null;
};

type FsEntry = {
    name?: string;
    isDirectory?: boolean;
};

function normalizeRelativePath(relativePath: string): string {
    const normalized = relativePath.trim().replace(/\\/g, "/");

    if (!normalized) {
        throw createAppError("INVALID_LIVE_CHAT_PATH", "Live chat path is empty.");
    }

    if (normalized.startsWith("/") || normalized.includes("..")) {
        throw createAppError("INVALID_LIVE_CHAT_PATH", "Live chat path is invalid.");
    }

    return normalized;
}

function extractRunsText(runs: unknown): string {
    if (!Array.isArray(runs)) {
        return "";
    }

    return runs
        .map((run) => {
            const item = (run ?? {}) as Record<string, unknown>;

            if (typeof item.text === "string") {
                return item.text;
            }

            const emoji = item.emoji as Record<string, unknown> | undefined;
            const shortcuts = Array.isArray(emoji?.shortcuts) ? emoji.shortcuts : [];
            const emojiId = typeof emoji?.emojiId === "string" ? emoji.emojiId : "";

            if (typeof shortcuts[0] === "string" && shortcuts[0].trim()) {
                return shortcuts[0];
            }

            return emojiId;
        })
        .filter((value) => typeof value === "string" && value.trim() !== "")
        .join("");
}

function parseRendererMessage(renderer: Record<string, unknown>): string {
    const message = renderer.message as Record<string, unknown> | undefined;
    return extractRunsText(message?.runs).trim();
}

function parseAuthorName(renderer: Record<string, unknown>): string {
    const authorName = renderer.authorName as Record<string, unknown> | undefined;

    if (typeof authorName?.simpleText === "string" && authorName.simpleText.trim()) {
        return authorName.simpleText.trim();
    }

    return "Unknown author";
}

function parseAuthorThumbnail(renderer: Record<string, unknown>): string | null {
    const authorPhoto = renderer.authorPhoto as Record<string, unknown> | undefined;
    const thumbnails = Array.isArray(authorPhoto?.thumbnails) ? authorPhoto.thumbnails : [];
    const candidate = thumbnails[thumbnails.length - 1] as Record<string, unknown> | undefined;

    if (typeof candidate?.url === "string" && candidate.url.trim()) {
        return candidate.url.trim();
    }

    return null;
}

function parseAuthorChannelId(renderer: Record<string, unknown>): string | null {
    const value = renderer.authorExternalChannelId;

    if (typeof value === "string" && value.trim()) {
        return value.trim();
    }

    return null;
}

function parseTimestampText(renderer: Record<string, unknown>): string | null {
    const timestampText = renderer.timestampText as Record<string, unknown> | undefined;

    if (typeof timestampText?.simpleText === "string" && timestampText.simpleText.trim()) {
        return timestampText.simpleText.trim();
    }

    return null;
}

function parseReplayOffsetMs(lineObject: Record<string, unknown>): number {
    const replayAction = lineObject.replayChatItemAction as Record<string, unknown> | undefined;
    const rawOffset = replayAction?.videoOffsetTimeMsec;

    if (typeof rawOffset === "string" || typeof rawOffset === "number") {
        const value = Number(rawOffset);

        if (Number.isFinite(value) && value >= 0) {
            return Math.floor(value);
        }
    }

    return 0;
}

function parseLiveChatLine(line: string): LiveChatMessageItem[] {
    const trimmed = line.trim();

    if (!trimmed) {
        return [];
    }

    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const replayAction = parsed.replayChatItemAction as Record<string, unknown> | undefined;
    const actions = Array.isArray(replayAction?.actions) ? replayAction.actions : [];
    const replayOffsetMs = parseReplayOffsetMs(parsed);

    const messages: LiveChatMessageItem[] = [];

    for (const action of actions) {
        const actionObject = (action ?? {}) as Record<string, unknown>;
        const addChatItemAction = actionObject.addChatItemAction as Record<string, unknown> | undefined;
        const item = addChatItemAction?.item as Record<string, unknown> | undefined;

        if (!item) {
            continue;
        }

        const textRenderer = item.liveChatTextMessageRenderer as Record<string, unknown> | undefined;

        if (!textRenderer) {
            continue;
        }

        const messageText = parseRendererMessage(textRenderer);

        if (!messageText) {
            continue;
        }

        const messageId =
            typeof textRenderer.id === "string" && textRenderer.id.trim()
                ? textRenderer.id.trim()
                : null;

        messages.push({
            message_id: messageId,
            message_offset_ms: replayOffsetMs,
            author_name: parseAuthorName(textRenderer),
            author_channel_id: parseAuthorChannelId(textRenderer),
            author_thumbnail: parseAuthorThumbnail(textRenderer),
            author_badges: null,
            message_text: messageText,
            timestamp_text: parseTimestampText(textRenderer),
            amount_text: null,
            header_primary_text: null,
            header_secondary_text: null,
        });
    }

    return messages;
}

export async function ensureLiveChatDirectory(): Promise<void> {
    await mkdir("live_chat", {
        baseDir: BaseDirectory.AppData,
        recursive: true,
    });
}

export async function saveLiveChatTextToAppData(
    relativePath: string,
    contents: string
): Promise<void> {
    const normalizedPath = normalizeRelativePath(relativePath);

    await ensureLiveChatDirectory();

    await writeTextFile(normalizedPath, contents, {
        baseDir: BaseDirectory.AppData,
    });
}

export async function readLiveChatTextFromAppData(relativePath: string): Promise<string> {
    const normalizedPath = normalizeRelativePath(relativePath);

    const fileExists = await exists(normalizedPath, {
        baseDir: BaseDirectory.AppData,
    });

    if (!fileExists) {
        throw createAppError(
            "LIVE_CHAT_FILE_NOT_FOUND",
            "Live chat replay file was not found in app storage."
        );
    }

    return readTextFile(normalizedPath, {
        baseDir: BaseDirectory.AppData,
    });
}

export async function deleteLiveChatFileFromAppData(relativePath: string): Promise<void> {
    const normalizedPath = normalizeRelativePath(relativePath);

    const fileExists = await exists(normalizedPath, {
        baseDir: BaseDirectory.AppData,
    });

    if (!fileExists) {
        return;
    }

    await remove(normalizedPath, {
        baseDir: BaseDirectory.AppData,
    });
}

async function listFilesRecursively(relativeDir: string): Promise<string[]> {
    const entries = (await readDir(relativeDir, {
        baseDir: BaseDirectory.AppData,
    })) as FsEntry[];

    const files: string[] = [];

    for (const entry of entries) {
        const entryName = entry.name?.trim() ?? "";

        if (!entryName) {
            continue;
        }

        const nextPath = `${relativeDir}/${entryName}`;

        if (entry.isDirectory) {
            files.push(...(await listFilesRecursively(nextPath)));
            continue;
        }

        files.push(nextPath);
    }

    return files;
}

export async function deleteAllLiveChatFilesFromAppData(): Promise<void> {
    const liveChatExists = await exists("live_chat", {
        baseDir: BaseDirectory.AppData,
    });

    if (!liveChatExists) {
        return;
    }

    const files = await listFilesRecursively("live_chat");

    await Promise.allSettled(
        files.map((filePath) =>
            remove(filePath, {
                baseDir: BaseDirectory.AppData,
            })
        )
    );
}

export async function readLiveChatMessagesFromFile(
    relativePath: string
): Promise<LiveChatMessageItem[]> {
    const contents = await readLiveChatTextFromAppData(relativePath);
    const lines = contents.split(/\r?\n/);

    const messages: LiveChatMessageItem[] = [];

    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }

        try {
            messages.push(...parseLiveChatLine(line));
        } catch {
            continue;
        }
    }

    return messages;
}

export function getVisibleLiveChatMessages(
    messages: LiveChatMessageItem[],
    playbackSeconds: number
): LiveChatMessageItem[] {
    const playbackMs = Math.max(0, Math.floor(playbackSeconds * 1000));

    return messages
        .filter((message) => message.message_offset_ms <= playbackMs)
        .slice(-200);
}