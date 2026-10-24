import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand, invokeVoid, streamLiveChatFile } from "../lib/tauri-client";
import { logWarn } from "../utils/app-logger";
import { parseLiveChatLine } from "./live-chat-parsing";
import type {
    LiveChatAuthorBadge,
    LiveChatMessageItem,
    LiveChatMessagePart,
} from "./live-chat-parsing";

// The message types are defined next door, with the parser that produces them, and re-exported here
// because this module is what every consumer already imports. Splitting the parser out was meant to
// isolate the code that reads YouTube's JSON, not to make every component learn a second module
// name.
export type {
    LiveChatAuthorBadge,
    LiveChatBadgeType,
    LiveChatMessageItem,
    LiveChatMessageKind,
    LiveChatMessagePart,
} from "./live-chat-parsing";

/**
 * Lists stored live chat files as library-relative paths (e.g. `live_chat/<file>`), for
 * diagnostics.
 */
export async function listLiveChatFiles(): Promise<string[]> {
    return invokeCommand(TAURI_COMMANDS.LIST_LIVE_CHAT_FILES);
}

/**
 * Moves any live chat files still in the old app-data location into the library and
 * compresses legacy files. Idempotent, called once the library path is known.
 */
export async function migrateLiveChatToLibrary(): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.MIGRATE_LIVE_CHAT_TO_LIBRARY);
}

// One copy of each value that repeats across a replay's messages. A long stream holds hundreds of
// thousands of messages from a few thousand authors, and every message parsed out of JSON carries
// its own copy of its author's name, channel id, avatar URL and badge list, and of every custom
// emoji's URL and label. The whole replay stays in memory for seeking, so those copies are most of
// what it costs. The messages are never mutated after parsing, which is what makes sharing safe.
export class LiveChatInterner {
    private readonly strings = new Map<string, string>();
    private readonly badgeLists = new Map<string, LiveChatAuthorBadge[]>();
    private readonly emojiParts = new Map<string, LiveChatMessagePart>();

    string<T extends string | null>(value: T): T {
        if (value === null) {
            return value;
        }

        const existing = this.strings.get(value);

        if (existing !== undefined) {
            return existing as T;
        }

        this.strings.set(value, value);
        return value;
    }

    private badges(badges: LiveChatAuthorBadge[]): LiveChatAuthorBadge[] {
        const key = badges.map((badge) => `${badge.type}\u0000${badge.label}`).join("\u0001");
        const existing = this.badgeLists.get(key);

        if (existing !== undefined) {
            return existing;
        }

        this.badgeLists.set(key, badges);
        return badges;
    }

    private part(part: LiveChatMessagePart): LiveChatMessagePart {
        if (part.type !== "emoji") {
            return part;
        }

        const key = `${part.url}\u0000${part.label}`;
        const existing = this.emojiParts.get(key);

        if (existing !== undefined) {
            return existing;
        }

        this.emojiParts.set(key, part);
        return part;
    }

    message(message: LiveChatMessageItem): LiveChatMessageItem {
        return {
            ...message,
            author_name: this.string(message.author_name),
            author_channel_id: this.string(message.author_channel_id),
            author_thumbnail: this.string(message.author_thumbnail),
            author_badges: this.badges(message.author_badges),
            message_parts: message.message_parts.map((part) => this.part(part)),
        };
    }
}

// Live chat files live in the library (under `live_chat/`), whose path is user-configurable, so
// the read goes through a backend command rather than the plugin-fs (whose scope is fixed to app
// data at build time). The replay is streamed line by line (see streamLiveChatFile) and parsed
// incrementally here, so a long dense stream is never held as one giant decompressed string on
// either side of the IPC boundary. Only the compact parsed messages below are retained (they must
// be, so the playback-time window can seek anywhere in the timeline).
export async function readLiveChatMessagesFromFile(
    relativePath: string,
    signal?: AbortSignal
): Promise<LiveChatMessageItem[]> {
    const messages: LiveChatMessageItem[] = [];
    const interner = new LiveChatInterner();
    // Ids of the chat items kept so far. A replay whose continuations overlap carries the same action
    // twice, and the panel keys its rows by `message_id`, so a repeat would be two rows sharing a key
    // and a measurement. Pins are left out. A pin repeats its message's id by design, and the same
    // pin added again later is a second appearance of the banner, not a duplicate.
    const seenMessageIds = new Set<string>();
    let parsedLines = 0;
    let failedLines = 0;
    let duplicateMessages = 0;

    await streamLiveChatFile(
        relativePath,
        (lines) => {
            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }

                try {
                    for (const message of parseLiveChatLine(line)) {
                        if (message.kind !== "pinned" && message.message_id !== null) {
                            if (seenMessageIds.has(message.message_id)) {
                                duplicateMessages += 1;
                                continue;
                            }

                            seenMessageIds.add(message.message_id);
                        }

                        messages.push(interner.message(message));
                    }
                    parsedLines += 1;
                } catch {
                    // One corrupt/truncated line, or a JSON shape yt-dlp/YouTube changed, must not
                    // abort the whole replay, but it must not vanish silently either. Count them
                    // and warn once below so the loss shows up in the log (and in any bug report)
                    // instead of only as fewer messages.
                    failedLines += 1;
                }
            }
        },
        signal
    );

    if (failedLines > 0) {
        logWarn("live-chat", "Some live chat replay lines could not be parsed and were skipped.", {
            liveChatFilePath: relativePath,
            failedLines,
            parsedLines,
        });
    }

    if (duplicateMessages > 0) {
        logWarn("live-chat", "Some live chat replay messages were repeated and kept only once.", {
            liveChatFilePath: relativePath,
            duplicateMessages,
        });
    }

    // Keep messages ordered by playback offset so the visible-window lookup can binary
    // search instead of scanning. Array.prototype.sort is stable, so messages that share
    // an offset keep their original (chronological) order.
    messages.sort((a, b) => a.message_offset_ms - b.message_offset_ms);

    return messages;
}

// Number of leading messages (offset <= playback time) kept mounted at once, matching the
// most recent slice a YouTube-style replay shows.
const MAX_VISIBLE_LIVE_CHAT_MESSAGES = 200;

// Returns how many leading messages have an offset at or before `playbackMs`. Assumes
// `messages` is sorted ascending by `message_offset_ms` (readLiveChatMessagesFromFile
// guarantees this), so the boundary is found in O(log n) instead of scanning the whole
// array on every playback tick.
function countMessagesUpToOffset(messages: LiveChatMessageItem[], playbackMs: number): number {
    let low = 0;
    let high = messages.length;

    while (low < high) {
        const mid = (low + high) >>> 1;
        const midMessage = messages[mid];

        if (midMessage !== undefined && midMessage.message_offset_ms <= playbackMs) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    return low;
}

// The bounds of the visible window, `[start, end)` into `messages`. Separate from the slice so the
// player can keep the same array while the playhead moves without reaching a new message, which is
// most ticks of a quiet chat.
export function visibleLiveChatWindow(
    messages: LiveChatMessageItem[],
    playbackSeconds: number
): { start: number; end: number } {
    const playbackMs = Math.max(0, Math.floor(playbackSeconds * 1000));
    const end = countMessagesUpToOffset(messages, playbackMs);

    return { start: Math.max(0, end - MAX_VISIBLE_LIVE_CHAT_MESSAGES), end };
}

// The pinned messages only, keeping their ascending-offset order (a filtered subset of the
// already-sorted list). Extracted once per message list so the per-playback-tick active-pin lookup
// is a binary search over this small array (getActiveLiveChatPinFromPins) instead of a backward
// scan over every message, which was O(n) per tick whenever no pin preceded the playhead.
export function extractLiveChatPins(
    messages: LiveChatMessageItem[]
): LiveChatMessageItem[] {
    return messages.filter((message) => message.kind === "pinned");
}

// The pin in effect at `playbackSeconds` given the pre-extracted, offset-sorted `pins`. The most
// recent pin at or before the current time. O(log P) in the number of pins. A pin "stays until a
// newer pin replaces it", so it is searched over the whole pin list, never the capped visible
// window. It can have been set far more than MAX_VISIBLE_LIVE_CHAT_MESSAGES ago and must not
// vanish once it scrolls out of that window.
export function getActiveLiveChatPinFromPins(
    pins: LiveChatMessageItem[],
    playbackSeconds: number
): LiveChatMessageItem | null {
    const playbackMs = Math.max(0, Math.floor(playbackSeconds * 1000));
    const upperBound = countMessagesUpToOffset(pins, playbackMs);

    if (upperBound <= 0) {
        return null;
    }

    return pins[upperBound - 1] ?? null;
}

// Convenience over the whole message list. Extracts the pins and resolves the active one. The
// per-tick UI path uses the two functions above directly (memoizing the extraction) so it does not
// re-filter every message each tick.
export function getActiveLiveChatPin(
    messages: LiveChatMessageItem[],
    playbackSeconds: number
): LiveChatMessageItem | null {
    return getActiveLiveChatPinFromPins(extractLiveChatPins(messages), playbackSeconds);
}