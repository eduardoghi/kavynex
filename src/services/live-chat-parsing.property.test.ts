import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseLiveChatLine } from "./live-chat-parsing";

// A replay file is YouTube's JSON as yt-dlp wrote it, and its shape drifts. The parser's contract is
// that only a line that is not JSON throws. Any JSON at all, in any shape, yields a list of messages,
// possibly empty, so one odd action cannot cost the rest of the replay.

// Objects shaped like a replay line, with arbitrary JSON where the renderers would be, so the
// generated input reaches the code that digs into them rather than stopping at the top level.
const rendererNames = [
    "liveChatTextMessageRenderer",
    "liveChatPaidMessageRenderer",
    "liveChatPaidStickerRenderer",
    "liveChatMembershipItemRenderer",
    "liveChatSponsorshipsGiftPurchaseAnnouncementRenderer",
    "liveChatSponsorshipsGiftRedemptionAnnouncementRenderer",
    "liveChatViewerEngagementMessageRenderer",
    "liveChatBannerRenderer",
];

const itemArbitrary = fc.dictionary(fc.constantFrom(...rendererNames), fc.jsonValue(), {
    maxKeys: 2,
});

const actionArbitrary = fc.oneof(
    fc.jsonValue(),
    fc.record({ addChatItemAction: fc.record({ item: itemArbitrary }) }),
    fc.record({
        addBannerToLiveChatCommand: fc.record({
            bannerRenderer: fc.record({ liveChatBannerRenderer: fc.jsonValue() }),
        }),
    })
);

const lineArbitrary = fc.record({
    replayChatItemAction: fc.record({
        actions: fc.oneof(fc.array(actionArbitrary, { maxLength: 4 }), fc.jsonValue()),
        videoOffsetTimeMsec: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
    }),
    videoOffsetTimeMsec: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
});

describe("live chat line properties", () => {
    it("never throws on a line that is JSON, whatever its shape", () => {
        fc.assert(
            fc.property(fc.oneof(fc.jsonValue(), lineArbitrary), (value) => {
                expect(Array.isArray(parseLiveChatLine(JSON.stringify(value)))).toBe(true);
            }),
            { numRuns: 500 }
        );
    });

    it("reads a line the same with or without the whitespace around it", () => {
        fc.assert(
            fc.property(lineArbitrary, fc.constantFrom("", " ", "\t", "\r"), (value, pad) => {
                const line = JSON.stringify(value);
                expect(parseLiveChatLine(`${pad}${line}${pad}`)).toEqual(parseLiveChatLine(line));
            })
        );
    });
});
