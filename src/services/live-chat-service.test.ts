import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    getVisibleLiveChatMessages,
    readLiveChatMessagesFromFile,
    type LiveChatMessageItem,
} from "./live-chat-service";
import { streamLiveChatFile } from "../lib/tauri-client";
import { logWarn } from "../utils/app-logger";

vi.mock("../lib/tauri-client", () => ({
    invokeCommand: vi.fn(),
    invokeVoid: vi.fn(),
    streamLiveChatFile: vi.fn(),
}));

vi.mock("../utils/app-logger", () => ({
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
}));

// Simulate the backend streaming the whole replay: the file's lines are delivered as a single
// batch to the parse callback, exactly as streamLiveChatFile would deliver them over the channel.
function mockFile(content: string): void {
    vi.mocked(streamLiveChatFile).mockImplementation(async (_relativePath, onLines) => {
        onLines(content.split(/\r?\n/));
    });
}

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
    });

    it("parses author_channel_id from authorExternalChannelId", async () => {
        mockFile(
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
        mockFile(
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
        mockFile(
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
        mockFile(
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
        mockFile(
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
        mockFile(
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
        mockFile(
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
        mockFile(
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
        mockFile(
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

    it("rejects a sticker image url that is not http(s)", async () => {
        mockFile(
            rawItemLine({
                liveChatPaidStickerRenderer: {
                    id: "st2",
                    authorName: { simpleText: "@fan" },
                    purchaseAmountText: { simpleText: "$1.00" },
                    // A tampered replay file trying to smuggle a non-image scheme into <img src>.
                    sticker: { thumbnails: [{ url: "javascript:alert(1)" }] },
                },
            })
        );

        const messages = await readLiveChatMessagesFromFile("live_chat/x.json");

        expect(messages[0]?.sticker_image_url).toBeNull();
    });

    it("parses a custom emoji as an image part", async () => {
        mockFile(
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
        mockFile(
            rawLine({
                message: { runs: [{ emoji: { emojiId: "📍", shortcuts: [":round_pushpin:"] } }] },
                authorName: { simpleText: "@x" },
            })
        );

        const messages = await readLiveChatMessagesFromFile("live_chat/x.json");

        expect(messages[0]?.message_parts).toEqual([{ type: "text", text: "📍" }]);
        expect(messages[0]?.message_text).toBe("📍");
    });

    it("parses a pinned banner message", async () => {
        mockFile(
            JSON.stringify({
                replayChatItemAction: {
                    videoOffsetTimeMsec: "0",
                    actions: [
                        {
                            addBannerToLiveChatCommand: {
                                bannerRenderer: {
                                    liveChatBannerRenderer: {
                                        header: {
                                            liveChatBannerHeaderRenderer: {
                                                text: {
                                                    runs: [
                                                        { text: "Pinned by " },
                                                        { text: "@creator" },
                                                    ],
                                                },
                                            },
                                        },
                                        contents: {
                                            liveChatTextMessageRenderer: {
                                                id: "p1",
                                                authorName: { simpleText: "@creator" },
                                                message: { runs: [{ text: "read the rules" }] },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    ],
                },
            })
        );

        const messages = await readLiveChatMessagesFromFile("live_chat/x.json");

        expect(messages[0]).toMatchObject({
            kind: "pinned",
            author_name: "@creator",
            message_text: "read the rules",
            pinned_header: "Pinned by @creator",
        });
    });

    it("returns null author_channel_id when absent", async () => {
        mockFile(
            rawLine({
                message: { runs: [{ text: "hi" }] },
                authorName: { simpleText: "bob" },
            })
        );

        const messages = await readLiveChatMessagesFromFile("live_chat/x.json");

        expect(messages[0]?.author_channel_id).toBeNull();
    });

    it("skips a corrupt line, keeps the valid ones, and warns about the loss", async () => {
        const valid = rawLine({
            message: { runs: [{ text: "hello" }] },
            authorName: { simpleText: "@alice" },
        });
        // A truncated/corrupt JSON line between two valid ones (the shape yt-dlp/YouTube drift
        // would produce). It must be dropped without aborting the replay, and reported.
        mockFile(`${valid}\n{not valid json\n${valid}`);

        const messages = await readLiveChatMessagesFromFile("live_chat/x.json");

        expect(messages).toHaveLength(2);
        expect(logWarn).toHaveBeenCalledTimes(1);
        expect(vi.mocked(logWarn).mock.calls[0]?.[2]).toMatchObject({
            liveChatFilePath: "live_chat/x.json",
            failedLines: 1,
            parsedLines: 2,
        });
    });

    it("does not warn when every line parses cleanly", async () => {
        mockFile(
            rawLine({
                message: { runs: [{ text: "hi" }] },
                authorName: { simpleText: "@a" },
            })
        );

        await readLiveChatMessagesFromFile("live_chat/x.json");

        expect(logWarn).not.toHaveBeenCalled();
    });
});

describe("getVisibleLiveChatMessages", () => {
    function messageAtOffset(offsetMs: number): LiveChatMessageItem {
        return {
            kind: "message",
            message_id: `m-${offsetMs}`,
            message_offset_ms: offsetMs,
            author_name: "Author",
            author_channel_id: null,
            author_thumbnail: null,
            author_badges: [],
            message_text: `msg ${offsetMs}`,
            message_parts: [],
            timestamp_text: null,
            amount_text: null,
            superchat_body_color: null,
            superchat_text_color: null,
            sticker_image_url: null,
            pinned_header: null,
        };
    }

    const messages = [0, 1000, 2000, 3000, 4000].map(messageAtOffset);

    it("returns only messages at or before the playback time (offset is inclusive)", () => {
        const visible = getVisibleLiveChatMessages(messages, 2);

        expect(visible.map((message) => message.message_offset_ms)).toEqual([0, 1000, 2000]);
    });

    it("returns nothing before the first message", () => {
        expect(getVisibleLiveChatMessages(messages, 0)).toHaveLength(1);
        expect(getVisibleLiveChatMessages([], 10)).toEqual([]);
    });

    it("returns every message once playback passes the last offset", () => {
        expect(getVisibleLiveChatMessages(messages, 99)).toHaveLength(messages.length);
    });

    it("keeps only the most recent 200 messages", () => {
        const many = Array.from({ length: 250 }, (_, index) => messageAtOffset(index));

        const visible = getVisibleLiveChatMessages(many, 1000);

        expect(visible).toHaveLength(200);
        // The window is the tail, so it ends at the newest message and starts 200 back.
        expect(visible[0]?.message_offset_ms).toBe(50);
        expect(visible[visible.length - 1]?.message_offset_ms).toBe(249);
    });

    it("clamps negative playback time to zero", () => {
        expect(getVisibleLiveChatMessages(messages, -5)).toHaveLength(1);
    });
});
