import { describe, expect, it } from "vitest";
import { describeChannelDeletion } from "./channel-deletion-copy";

describe("describeChannelDeletion", () => {
    it("keeps the wording that is true of any channel while the count is unknown", () => {
        expect(describeChannelDeletion(null)).toBe(
            "This permanently deletes all of this channel's saved videos, audio, thumbnails and live chat replays from disk, and removes its comments. This cannot be undone."
        );
    });

    it("says an empty channel loses only itself and its avatar", () => {
        expect(describeChannelDeletion(0)).toBe(
            "This channel has no saved media. Deleting it removes the channel and its avatar. This cannot be undone."
        );
    });

    it("names the one file when there is one", () => {
        expect(describeChannelDeletion(1)).toBe(
            "This permanently deletes the channel's one saved media file, its thumbnail and live chat replay from disk, and removes its comments. This cannot be undone."
        );
    });

    it("names the count, formatted, when there are many", () => {
        expect(describeChannelDeletion(27)).toContain("all 27 of the channel's saved videos");
        // The scale is the point, so a four-digit count gets its separator rather than reading as
        // a number the eye has to parse.
        expect(describeChannelDeletion(1075)).toContain("all 1,075 of the channel's");
    });
});
