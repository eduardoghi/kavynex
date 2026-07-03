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

    it("parses author badges (owner and member)", async () => {
        vi.mocked(readTextFile).mockResolvedValue(
            rawLine({
                message: { runs: [{ text: "hi" }] },
                authorName: { simpleText: "@owner" },
                authorBadges: [
                    {
                        liveChatAuthorBadgeRenderer: {
                            icon: { iconType: "OWNER" },
                            tooltip: "Owner",
                        },
                    },
                    {
                        liveChatAuthorBadgeRenderer: {
                            customThumbnail: { thumbnails: [{ url: "x" }] },
                            tooltip: "Member (6 months)",
                        },
                    },
                ],
            })
        );

        const messages = await readLiveChatMessagesFromFile("live_chat/x.json");

        expect(messages[0]?.author_badges).toEqual([
            { type: "owner", label: "Owner" },
            { type: "member", label: "Member (6 months)" },
        ]);
    });

    it("returns an empty badge list when there are no badges", async () => {
        vi.mocked(readTextFile).mockResolvedValue(
            rawLine({
                message: { runs: [{ text: "hi" }] },
                authorName: { simpleText: "bob" },
            })
        );

        const messages = await readLiveChatMessagesFromFile("live_chat/x.json");

        expect(messages[0]?.author_badges).toEqual([]);
    });

    function rawPaidLine(renderer: Record<string, unknown>, offset = "0"): string {
        return JSON.stringify({
            replayChatItemAction: {
                videoOffsetTimeMsec: offset,
                actions: [
                    { addChatItemAction: { item: { liveChatPaidMessageRenderer: renderer } } },
                ],
            },
        });
    }

    it("parses a super chat with amount and colors", async () => {
        vi.mocked(readTextFile).mockResolvedValue(
            rawPaidLine(
                {
                    id: "sc1",
                    authorName: { simpleText: "@fan" },
                    message: { runs: [{ text: "great stream" }] },
                    purchaseAmountText: { simpleText: "$4.99" },
                    bodyBackgroundColor: 4280150454,
                    bodyTextColor: 4278190080,
                },
                "500"
            )
        );

        const messages = await readLiveChatMessagesFromFile("live_chat/x.json");

        expect(messages[0]).toMatchObject({
            message_id: "sc1",
            author_name: "@fan",
            message_text: "great stream",
            amount_text: "$4.99",
            message_offset_ms: 500,
        });
        expect(messages[0]?.superchat_body_color).toMatch(/^#[0-9a-f]{6}$/);
        expect(messages[0]?.superchat_text_color).toBe("#000000");
    });

    it("keeps a super chat that has no message text", async () => {
        vi.mocked(readTextFile).mockResolvedValue(
            rawPaidLine({
                authorName: { simpleText: "@fan" },
                purchaseAmountText: { simpleText: "$2.00" },
            })
        );

        const messages = await readLiveChatMessagesFromFile("live_chat/x.json");

        expect(messages).toHaveLength(1);
        expect(messages[0]?.amount_text).toBe("$2.00");
        expect(messages[0]?.message_text).toBe("");
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
