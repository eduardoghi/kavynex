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

    function rawItemLine(item: Record<string, unknown>, offset = "0"): string {
        return JSON.stringify({
            replayChatItemAction: {
                videoOffsetTimeMsec: offset,
                actions: [{ addChatItemAction: { item } }],
            },
        });
    }

    it("parses a new member (membership) event", async () => {
        vi.mocked(readTextFile).mockResolvedValue(
            rawItemLine(
                {
                    liveChatMembershipItemRenderer: {
                        id: "m1",
                        authorName: { simpleText: "@newbie" },
                        headerSubtext: {
                            runs: [{ text: "Welcome to " }, { text: "Level 1" }, { text: "!" }],
                        },
                        timestampText: { simpleText: "10:47" },
                    },
                },
                "1000"
            )
        );

        const messages = await readLiveChatMessagesFromFile("live_chat/x.json");

        expect(messages[0]).toMatchObject({
            kind: "membership",
            author_name: "@newbie",
            message_text: "Welcome to Level 1!",
            message_offset_ms: 1000,
        });
    });

    it("parses a gift membership redemption", async () => {
        vi.mocked(readTextFile).mockResolvedValue(
            rawItemLine({
                liveChatSponsorshipsGiftRedemptionAnnouncementRenderer: {
                    authorName: { simpleText: "@lucky" },
                    message: {
                        runs: [{ text: "received a gift membership by " }, { text: "@santa" }],
                    },
                },
            })
        );

        const messages = await readLiveChatMessagesFromFile("live_chat/x.json");

        expect(messages[0]).toMatchObject({
            kind: "membership",
            author_name: "@lucky",
            message_text: "received a gift membership by @santa",
        });
    });

    it("keeps spaces between gift purchase runs", async () => {
        vi.mocked(readTextFile).mockResolvedValue(
            rawItemLine({
                liveChatSponsorshipsGiftPurchaseAnnouncementRenderer: {
                    authorExternalChannelId: "UCabc",
                    header: {
                        liveChatSponsorshipsHeaderRenderer: {
                            authorName: { simpleText: "@kadu97" },
                            primaryText: {
                                runs: [
                                    { text: "Sent " },
                                    { text: "5" },
                                    { text: " " },
                                    { text: "Coruja do Carvalho 2" },
                                    { text: " gift memberships" },
                                ],
                            },
                        },
                    },
                },
            })
        );

        const messages = await readLiveChatMessagesFromFile("live_chat/x.json");

        expect(messages[0]).toMatchObject({
            kind: "membership",
            author_name: "@kadu97",
            message_text: "Sent 5 Coruja do Carvalho 2 gift memberships",
        });
    });

    it("parses a super sticker with image and amount", async () => {
        vi.mocked(readTextFile).mockResolvedValue(
            rawItemLine({
                liveChatPaidStickerRenderer: {
                    id: "st1",
                    authorName: { simpleText: "@fan" },
                    purchaseAmountText: { simpleText: "$2.99" },
                    sticker: { thumbnails: [{ url: "//lh3.googleusercontent.com/abc=s72" }] },
                    backgroundColor: 4280150454,
                },
            })
        );

        const messages = await readLiveChatMessagesFromFile("live_chat/x.json");

        expect(messages[0]).toMatchObject({
            kind: "sticker",
            author_name: "@fan",
            amount_text: "$2.99",
            sticker_image_url: "https://lh3.googleusercontent.com/abc=s72",
        });
    });

    it("parses a custom emoji as an image part", async () => {
        vi.mocked(readTextFile).mockResolvedValue(
            rawLine({
                message: {
                    runs: [
                        { text: "gg " },
                        {
                            emoji: {
                                isCustomEmoji: true,
                                shortcuts: [":face-blue-smiling:"],
                                image: { thumbnails: [{ url: "//yt3.ggpht.com/e=s48" }] },
                            },
                        },
                    ],
                },
                authorName: { simpleText: "@x" },
            })
        );

        const messages = await readLiveChatMessagesFromFile("live_chat/x.json");

        expect(messages[0]?.message_parts).toEqual([
            { type: "text", text: "gg " },
            {
                type: "emoji",
                url: "https://yt3.ggpht.com/e=s48",
                label: ":face-blue-smiling:",
            },
        ]);
    });

    it("keeps a standard emoji as its unicode character", async () => {
        vi.mocked(readTextFile).mockResolvedValue(
            rawLine({
                message: { runs: [{ emoji: { emojiId: "📍", shortcuts: [":round_pushpin:"] } }] },
                authorName: { simpleText: "@x" },
            })
        );

        const messages = await readLiveChatMessagesFromFile("live_chat/x.json");

        expect(messages[0]?.message_parts).toEqual([{ type: "text", text: "📍" }]);
        expect(messages[0]?.message_text).toBe("📍");
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
