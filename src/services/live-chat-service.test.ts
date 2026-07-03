import { beforeEach, describe, expect, it, vi } from "vitest";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";
import { readLiveChatMessagesFromFile } from "./live-chat-service";

vi.mock("@tauri-apps/plugin-fs", () => ({
    BaseDirectory: { AppData: 1 },
    exists: vi.fn(),
    mkdir: vi.fn(),
    readDir: vi.fn(),
    readTextFile: vi.fn(),
    remove: vi.fn(),
    writeTextFile: vi.fn(),
}));

function rawLine(renderer: Record<string, unknown>, offset = "0"): string {
    return JSON.stringify({
        replayChatItemAction: {
            videoOffsetTimeMsec: offset,
            actions: [{ addChatItemAction: { item: { liveChatTextMessageRenderer: renderer } } }],
        },
    });
}

describe("readLiveChatMessagesFromFile", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(exists).mockResolvedValue(true);
    });

    it("parses author_channel_id from authorExternalChannelId", async () => {
        vi.mocked(readTextFile).mockResolvedValue(
            rawLine(
                {
                    id: "msg1",
                    message: { runs: [{ text: "hello" }] },
                    authorName: { simpleText: "@alice" },
                    authorExternalChannelId: "UC123abc",
                    timestampText: { simpleText: "-11:30" },
                },
                "1500"
            )
        );

        const messages = await readLiveChatMessagesFromFile("live_chat/x.json");

        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            message_id: "msg1",
            author_name: "@alice",
            author_channel_id: "UC123abc",
            message_text: "hello",
            timestamp_text: "-11:30",
            message_offset_ms: 1500,
        });
    });

    it("returns null author_channel_id when absent", async () => {
        vi.mocked(readTextFile).mockResolvedValue(
            rawLine({
                message: { runs: [{ text: "hi" }] },
                authorName: { simpleText: "bob" },
            })
        );

        const messages = await readLiveChatMessagesFromFile("live_chat/x.json");

        expect(messages[0]?.author_channel_id).toBeNull();
    });
});
