import {
    BaseDirectory,
    exists,
    mkdir,
    readDir,
    readFile,
    remove,
    writeTextFile,
} from "@tauri-apps/plugin-fs";
import { createAppError } from "../utils/app-error";

export type LiveChatBadgeType = "owner" | "moderator" | "member" | "verified" | "other";

export type LiveChatAuthorBadge = {
    type: LiveChatBadgeType;
    label: string;
};

export type LiveChatMessageKind =
    | "message"
    | "superchat"
    | "sticker"
    | "membership"
    | "pinned";

export type LiveChatMessagePart =
    | { type: "text"; text: string }
    | { type: "emoji"; url: string; label: string };

export type LiveChatMessageItem = {
    kind: LiveChatMessageKind;
    message_id: string | null;
    message_offset_ms: number;
    author_name: string;
    author_channel_id: string | null;
    author_thumbnail: string | null;
    author_badges: LiveChatAuthorBadge[];
    message_text: string;
    message_parts: LiveChatMessagePart[];
    timestamp_text: string | null;
    amount_text: string | null;
    superchat_body_color: string | null;
    superchat_text_color: string | null;
    sticker_image_url: string | null;
    pinned_header: string | null;
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
        .filter((value) => value !== "")
        .join("");
}

function parseRendererMessage(renderer: Record<string, unknown>): string {
    const message = renderer.message as Record<string, unknown> | undefined;
    return extractRunsText(message?.runs).trim();
}

function emojiImageUrl(emoji: Record<string, unknown>): string | null {
    const image = emoji.image as Record<string, unknown> | undefined;
    const thumbnails = Array.isArray(image?.thumbnails) ? image.thumbnails : [];
    const candidate = thumbnails[thumbnails.length - 1] as Record<string, unknown> | undefined;
    const url = typeof candidate?.url === "string" ? candidate.url.trim() : "";

    if (!url) {
        return null;
    }

    return url.startsWith("//") ? `https:${url}` : url;
}

// Preserves message structure so custom channel emojis can render as inline images.
// Standard unicode emojis become their character; custom emojis become an image part
// (with the shortcut kept as label / fallback).
function parseMessageParts(renderer: Record<string, unknown>): LiveChatMessagePart[] {
    const runs = (renderer.message as Record<string, unknown> | undefined)?.runs;

    if (!Array.isArray(runs)) {
        return [];
    }

    const parts: LiveChatMessagePart[] = [];

    for (const run of runs) {
        const item = (run ?? {}) as Record<string, unknown>;

        if (typeof item.text === "string") {
            if (item.text) {
                parts.push({ type: "text", text: item.text });
            }
            continue;
        }

        const emoji = item.emoji as Record<string, unknown> | undefined;

        if (!emoji) {
            continue;
        }

        const shortcuts = Array.isArray(emoji.shortcuts) ? emoji.shortcuts : [];
        const label =
            (typeof shortcuts[0] === "string" && shortcuts[0].trim() ? shortcuts[0] : "") ||
            (typeof emoji.emojiId === "string" ? emoji.emojiId : "");

        if (emoji.isCustomEmoji === true) {
            const url = emojiImageUrl(emoji);

            if (url) {
                parts.push({ type: "emoji", url, label });
            } else if (label) {
                parts.push({ type: "text", text: label });
            }

            continue;
        }

        // Standard emoji: emojiId is the unicode character.
        const text = typeof emoji.emojiId === "string" && emoji.emojiId ? emoji.emojiId : label;

        if (text) {
            parts.push({ type: "text", text });
        }
    }

    return parts;
}

function partsToText(parts: LiveChatMessagePart[]): string {
    return parts
        .map((part) => (part.type === "text" ? part.text : part.label))
        .join("")
        .trim();
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

function defaultBadgeLabel(type: LiveChatBadgeType): string {
    switch (type) {
        case "owner":
            return "Owner";
        case "moderator":
            return "Moderator";
        case "member":
            return "Member";
        case "verified":
            return "Verified";
        default:
            return "Badge";
    }
}

function parseAuthorBadges(renderer: Record<string, unknown>): LiveChatAuthorBadge[] {
    const rawBadges = renderer.authorBadges;

    if (!Array.isArray(rawBadges)) {
        return [];
    }

    const badges: LiveChatAuthorBadge[] = [];

    for (const rawBadge of rawBadges) {
        const badgeRenderer = (rawBadge as Record<string, unknown>)?.liveChatAuthorBadgeRenderer as
            | Record<string, unknown>
            | undefined;

        if (!badgeRenderer) {
            continue;
        }

        const icon = badgeRenderer.icon as Record<string, unknown> | undefined;
        const iconType = typeof icon?.iconType === "string" ? icon.iconType.toUpperCase() : "";
        const hasCustomThumbnail = Boolean(badgeRenderer.customThumbnail);
        const tooltip = typeof badgeRenderer.tooltip === "string" ? badgeRenderer.tooltip.trim() : "";

        let type: LiveChatBadgeType;

        if (iconType === "OWNER") {
            type = "owner";
        } else if (iconType === "MODERATOR") {
            type = "moderator";
        } else if (iconType === "VERIFIED") {
            type = "verified";
        } else if (hasCustomThumbnail) {
            // Member badges carry a custom image instead of a standard icon type.
            type = "member";
        } else {
            type = "other";
        }

        badges.push({ type, label: tooltip || defaultBadgeLabel(type) });
    }

    return badges;
}

function parseTimestampText(renderer: Record<string, unknown>): string | null {
    const timestampText = renderer.timestampText as Record<string, unknown> | undefined;

    if (typeof timestampText?.simpleText === "string" && timestampText.simpleText.trim()) {
        return timestampText.simpleText.trim();
    }

    return null;
}

function parsePurchaseAmount(renderer: Record<string, unknown> | undefined): string | null {
    const amount = (renderer?.purchaseAmountText as Record<string, unknown> | undefined)?.simpleText;

    if (typeof amount === "string" && amount.trim()) {
        return amount.trim();
    }

    return null;
}

// YouTube stores super chat colors as ARGB integers; keep the RGB part as a CSS hex.
function argbColorToHex(value: unknown): string | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
    }

    const rgb = value & 0xffffff;
    return `#${rgb.toString(16).padStart(6, "0")}`;
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

function makeMessage(
    partial: Partial<LiveChatMessageItem> & {
        kind: LiveChatMessageKind;
        message_offset_ms: number;
    }
): LiveChatMessageItem {
    return {
        kind: partial.kind,
        message_id: partial.message_id ?? null,
        message_offset_ms: partial.message_offset_ms,
        author_name: partial.author_name ?? "Unknown author",
        author_channel_id: partial.author_channel_id ?? null,
        author_thumbnail: partial.author_thumbnail ?? null,
        author_badges: partial.author_badges ?? [],
        message_text: partial.message_text ?? "",
        message_parts: partial.message_parts ?? [],
        timestamp_text: partial.timestamp_text ?? null,
        amount_text: partial.amount_text ?? null,
        superchat_body_color: partial.superchat_body_color ?? null,
        superchat_text_color: partial.superchat_text_color ?? null,
        sticker_image_url: partial.sticker_image_url ?? null,
        pinned_header: partial.pinned_header ?? null,
    };
}

function parseStickerImageUrl(renderer: Record<string, unknown>): string | null {
    const sticker = renderer.sticker as Record<string, unknown> | undefined;
    const thumbnails = Array.isArray(sticker?.thumbnails) ? sticker.thumbnails : [];
    const candidate = thumbnails[thumbnails.length - 1] as Record<string, unknown> | undefined;
    const url = typeof candidate?.url === "string" ? candidate.url.trim() : "";

    if (!url) {
        return null;
    }

    return url.startsWith("//") ? `https:${url}` : url;
}

function parseRendererId(renderer: Record<string, unknown>): string | null {
    return typeof renderer.id === "string" && renderer.id.trim() ? renderer.id.trim() : null;
}

function buildChatMessage(
    renderer: Record<string, unknown>,
    isPaid: boolean,
    offset: number
): LiveChatMessageItem | null {
    const parts = parseMessageParts(renderer);
    const text = partsToText(parts);

    // Regular messages must have content; super chats keep the amount as content.
    if (!text && !isPaid) {
        return null;
    }

    return makeMessage({
        kind: isPaid ? "superchat" : "message",
        message_id: parseRendererId(renderer),
        message_offset_ms: offset,
        author_name: parseAuthorName(renderer),
        author_channel_id: parseAuthorChannelId(renderer),
        author_thumbnail: parseAuthorThumbnail(renderer),
        author_badges: parseAuthorBadges(renderer),
        message_text: text,
        message_parts: parts,
        timestamp_text: parseTimestampText(renderer),
        amount_text: isPaid ? parsePurchaseAmount(renderer) : null,
        superchat_body_color: isPaid ? argbColorToHex(renderer.bodyBackgroundColor) : null,
        superchat_text_color: isPaid ? argbColorToHex(renderer.bodyTextColor) : null,
    });
}

function buildSticker(renderer: Record<string, unknown>, offset: number): LiveChatMessageItem {
    return makeMessage({
        kind: "sticker",
        message_id: parseRendererId(renderer),
        message_offset_ms: offset,
        author_name: parseAuthorName(renderer),
        author_channel_id: parseAuthorChannelId(renderer),
        author_thumbnail: parseAuthorThumbnail(renderer),
        message_text: "",
        timestamp_text: parseTimestampText(renderer),
        amount_text: parsePurchaseAmount(renderer),
        superchat_body_color: argbColorToHex(renderer.backgroundColor),
        superchat_text_color: argbColorToHex(renderer.moneyChipTextColor),
        sticker_image_url: parseStickerImageUrl(renderer),
    });
}

function extractRunsFrom(value: unknown): string {
    return extractRunsText((value as Record<string, unknown> | undefined)?.runs).trim();
}

function buildMembership(renderer: Record<string, unknown>, offset: number): LiveChatMessageItem {
    // New members carry the announcement in headerSubtext; milestone messages add the
    // member's own message.
    const headerText = extractRunsFrom(renderer.headerSubtext);
    const memberMessage = parseRendererMessage(renderer);
    const text = [headerText, memberMessage].filter(Boolean).join(" — ");

    return makeMessage({
        kind: "membership",
        message_id: parseRendererId(renderer),
        message_offset_ms: offset,
        author_name: parseAuthorName(renderer),
        author_channel_id: parseAuthorChannelId(renderer),
        author_thumbnail: parseAuthorThumbnail(renderer),
        message_text: text || "New member",
        timestamp_text: parseTimestampText(renderer),
    });
}

function buildGiftRedemption(
    renderer: Record<string, unknown>,
    offset: number
): LiveChatMessageItem {
    return makeMessage({
        kind: "membership",
        message_id: parseRendererId(renderer),
        message_offset_ms: offset,
        author_name: parseAuthorName(renderer),
        author_channel_id: parseAuthorChannelId(renderer),
        author_thumbnail: parseAuthorThumbnail(renderer),
        message_text: parseRendererMessage(renderer) || "received a gift membership",
        timestamp_text: parseTimestampText(renderer),
    });
}

function buildGiftPurchase(
    renderer: Record<string, unknown>,
    offset: number
): LiveChatMessageItem {
    const header = (renderer.header as Record<string, unknown> | undefined)
        ?.liveChatSponsorshipsHeaderRenderer as Record<string, unknown> | undefined;

    return makeMessage({
        kind: "membership",
        message_id: parseRendererId(renderer),
        message_offset_ms: offset,
        author_name: header ? parseAuthorName(header) : "Unknown author",
        author_channel_id: parseAuthorChannelId(renderer),
        author_thumbnail: header ? parseAuthorThumbnail(header) : null,
        message_text: header ? extractRunsFrom(header.primaryText) : "Sent gift memberships",
    });
}

function buildPinnedBanner(
    banner: Record<string, unknown>,
    offset: number
): LiveChatMessageItem | null {
    const contents = banner.contents as Record<string, unknown> | undefined;
    const textRenderer = contents?.liveChatTextMessageRenderer as
        | Record<string, unknown>
        | undefined;

    if (!textRenderer) {
        return null;
    }

    const base = buildChatMessage(textRenderer, false, offset);

    if (!base) {
        return null;
    }

    const header = (banner.header as Record<string, unknown> | undefined)
        ?.liveChatBannerHeaderRenderer as Record<string, unknown> | undefined;

    return {
        ...base,
        kind: "pinned",
        pinned_header: (header ? extractRunsFrom(header.text) : "") || "Pinned message",
    };
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

        const banner = (
            (actionObject.addBannerToLiveChatCommand as Record<string, unknown> | undefined)
                ?.bannerRenderer as Record<string, unknown> | undefined
        )?.liveChatBannerRenderer as Record<string, unknown> | undefined;

        if (banner) {
            const parsedBanner = buildPinnedBanner(banner, replayOffsetMs);

            if (parsedBanner) {
                messages.push(parsedBanner);
            }

            continue;
        }

        const addChatItemAction = actionObject.addChatItemAction as Record<string, unknown> | undefined;
        const item = addChatItemAction?.item as Record<string, unknown> | undefined;

        if (!item) {
            continue;
        }

        const textRenderer = item.liveChatTextMessageRenderer as Record<string, unknown> | undefined;
        const paidRenderer = item.liveChatPaidMessageRenderer as Record<string, unknown> | undefined;
        const stickerRenderer = item.liveChatPaidStickerRenderer as
            | Record<string, unknown>
            | undefined;
        const membershipRenderer = item.liveChatMembershipItemRenderer as
            | Record<string, unknown>
            | undefined;
        const giftRedemptionRenderer = item.liveChatSponsorshipsGiftRedemptionAnnouncementRenderer as
            | Record<string, unknown>
            | undefined;
        const giftPurchaseRenderer = item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer as
            | Record<string, unknown>
            | undefined;

        let parsedMessage: LiveChatMessageItem | null = null;

        if (textRenderer) {
            parsedMessage = buildChatMessage(textRenderer, false, replayOffsetMs);
        } else if (paidRenderer) {
            parsedMessage = buildChatMessage(paidRenderer, true, replayOffsetMs);
        } else if (stickerRenderer) {
            parsedMessage = buildSticker(stickerRenderer, replayOffsetMs);
        } else if (membershipRenderer) {
            parsedMessage = buildMembership(membershipRenderer, replayOffsetMs);
        } else if (giftRedemptionRenderer) {
            parsedMessage = buildGiftRedemption(giftRedemptionRenderer, replayOffsetMs);
        } else if (giftPurchaseRenderer) {
            parsedMessage = buildGiftPurchase(giftPurchaseRenderer, replayOffsetMs);
        }

        if (parsedMessage) {
            messages.push(parsedMessage);
        }
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

    const bytes = await readFile(normalizedPath, {
        baseDir: BaseDirectory.AppData,
    });

    return decodeLiveChatBytes(bytes);
}

// Live chat files are stored gzip-compressed to save disk. Older files may still be plain
// JSON, so detect the gzip magic bytes and only decompress when present.
async function decodeLiveChatBytes(bytes: Uint8Array): Promise<string> {
    const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

    if (!isGzip) {
        return new TextDecoder("utf-8").decode(bytes);
    }

    const source = new ReadableStream<BufferSource>({
        start(controller) {
            controller.enqueue(new Uint8Array(bytes));
            controller.close();
        },
    });

    const decompressed = source.pipeThrough(new DecompressionStream("gzip"));

    return new Response(decompressed).text();
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