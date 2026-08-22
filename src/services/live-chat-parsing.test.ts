import { describe, expect, it } from "vitest";
import { parseLiveChatLine } from "./live-chat-parsing";

// The parser's contract, driven directly rather than through the read path.
//
// `live-chat-service.test.ts` covers the same code from the other side, feeding whole files through
// a mocked stream, and those tests stay: they are how the batching, the offset ordering and the
// warn-and-continue behavior are pinned. What they cannot state is what *one line* is worth on its
// own, which is the whole of this module's job, and driving it directly is why the parser was split
// out of the service in the first place.
//
// Every case below is a line shape that arrives from yt-dlp rather than from this app, so the
// property under test is always the same one: an input the parser does not recognize degrades to
// nothing rather than throwing.

function textMessageLine(renderer: Record<string, unknown>, offset = "0"): string {
    return JSON.stringify({
        replayChatItemAction: {
            videoOffsetTimeMsec: offset,
            actions: [{ addChatItemAction: { item: { liveChatTextMessageRenderer: renderer } } }],
        },
    });
}

describe("parseLiveChatLine", () => {
    it("turns one text message line into one message", () => {
        const messages = parseLiveChatLine(
            textMessageLine(
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

        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            kind: "message",
            message_id: "msg1",
            author_name: "@alice",
            author_channel_id: "UC123abc",
            message_text: "hello",
            timestamp_text: "-11:30",
            message_offset_ms: 1500,
        });
    });

    it("yields nothing for a well-formed line that carries no message", () => {
        // Each of these is an ordinary record in a replay file, not a failure: a blank line between
        // records, an object with no replay action, a heartbeat whose action list is empty, and an
        // action carrying a renderer this app does not display. All of them have to answer "no
        // messages" quietly. The caller counts what it *cannot* parse and warns about the total, so
        // treating these as failures would put a warning on every ordinary replay.
        const empty = [
            "",
            "   ",
            JSON.stringify({}),
            JSON.stringify({ replayChatItemAction: { actions: [] } }),
            JSON.stringify({
                replayChatItemAction: {
                    videoOffsetTimeMsec: "0",
                    actions: [{ addChatItemAction: { item: { liveChatSomethingElse: {} } } }],
                },
            }),
        ];

        for (const line of empty) {
            expect(parseLiveChatLine(line), `should yield nothing: ${line}`).toEqual([]);
        }
    });

    it("throws on a line that is not parseable JSON, which is what the caller counts", () => {
        // The other half of the contract, and the distinction the caller depends on. A line that
        // will not parse is a corrupt file or a shape yt-dlp/YouTube changed, which
        // readLiveChatMessagesFromFile tallies and warns about once. A signal that was lost while
        // that loop silently swallowed every failure. Returning an empty array here instead would
        // make a format drift indistinguishable from a replay of heartbeats.
        for (const line of ["not json at all", "{", "[unclosed"]) {
            expect(() => parseLiveChatLine(line), `should throw: ${line}`).toThrow();
        }
    });

    it("keeps a message whose author fields are missing rather than dropping it", () => {
        // A message with no author name still happened and still has text, so it belongs in the
        // replay. Dropping it would silently thin out the transcript; the defaults are what let the
        // renderer show it without a special case.
        const messages = parseLiveChatLine(
            textMessageLine({ id: "msg2", message: { runs: [{ text: "anon" }] } })
        );

        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            message_text: "anon",
            author_channel_id: null,
            author_thumbnail: null,
            author_badges: [],
        });
    });

    it("reads the offset as a number and falls back to zero when it is not one", () => {
        // The offset is what the playback-time window seeks against, so a non-numeric value has to
        // become 0 rather than NaN. A NaN offset compares false against every playback position and
        // makes the message invisible for the whole replay.
        const withOffset = parseLiveChatLine(
            textMessageLine({ id: "a", message: { runs: [{ text: "x" }] } }, "4200")
        );
        expect(withOffset[0]?.message_offset_ms).toBe(4200);

        const withoutOffset = parseLiveChatLine(
            textMessageLine({ id: "b", message: { runs: [{ text: "x" }] } }, "not-a-number")
        );
        expect(withoutOffset[0]?.message_offset_ms).toBe(0);
    });

    it("joins the runs of a message into its text", () => {
        // YouTube splits a message across runs at every emoji and link boundary, so a parser that
        // read only the first run would truncate most real messages at the first emoji.
        const messages = parseLiveChatLine(
            textMessageLine({
                id: "msg3",
                message: { runs: [{ text: "hello " }, { text: "world" }] },
                authorName: { simpleText: "@bob" },
            })
        );

        expect(messages[0]?.message_text).toBe("hello world");
    });

    it("normalizes the author photo url the same way as emoji and sticker images", () => {
        // The author photo is the third image url the parser reads from a replay file, and it ends
        // up in an <img src> like the other two. A protocol-relative url is upgraded to https; a
        // non-http(s) scheme, the shape a tampered file would use to sidestep the remote image
        // toggle, is dropped. The avatar renderers guard this again, but that guard does not
        // upgrade "//host", and a value the parser emits should not depend on it.
        const thumbnail = (url: string) =>
            parseLiveChatLine(
                textMessageLine({
                    id: "msg4",
                    message: { runs: [{ text: "hi" }] },
                    authorName: { simpleText: "@carol" },
                    authorPhoto: { thumbnails: [{ url: "//yt3.ggpht.com/small=s32" }, { url }] },
                })
            )[0]?.author_thumbnail;

        expect(thumbnail(" https://yt3.ggpht.com/a=s64 ")).toBe("https://yt3.ggpht.com/a=s64");
        expect(thumbnail("//yt3.ggpht.com/a=s64")).toBe("https://yt3.ggpht.com/a=s64");
        expect(thumbnail("javascript:alert(1)")).toBeNull();
        expect(thumbnail("data:image/png;base64,AAAA")).toBeNull();
        expect(thumbnail("file:///C:/Users/x/avatar.png")).toBeNull();
        expect(thumbnail("")).toBeNull();
    });
});
