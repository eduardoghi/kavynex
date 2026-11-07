import { describe, expect, it } from "vitest";
import { describeChannelDeletion, describeMediaDeletion } from "./channel-deletion-copy";

describe("describeChannelDeletion", () => {
    it("keeps the wording that is true of any channel while the count is unknown", () => {
        expect(describeChannelDeletion(null, true)).toBe(
            "This permanently deletes all of this channel's saved videos, audio, thumbnails and live chat replays from disk, and removes its comments. This cannot be undone."
        );
    });

    it("says the files go to the trash for thirty days unless they are deleted right away", () => {
        // The trash is the default. A confirmation calling the deletion permanent told the user
        // something false, and could talk them out of a deletion they could have taken back.
        expect(describeChannelDeletion(null, false)).toBe(
            "This moves all of this channel's saved videos, audio, thumbnails and live chat replays to the library's trash, where they stay for 30 days, and removes its comments, which the trash does not keep."
        );
        expect(describeChannelDeletion(27, false)).toContain("to the library's trash");
        expect(describeChannelDeletion(27, false)).not.toContain("cannot be undone");
    });

    it("says an empty channel loses only itself and its images", () => {
        expect(describeChannelDeletion(0, true)).toBe(
            "This channel has no saved media. Deleting it removes the channel and its images. This cannot be undone."
        );
        expect(describeChannelDeletion(0, false)).toBe(
            "This channel has no saved media. Deleting it removes the channel and moves its images to the library's trash, where they stay for 30 days."
        );
    });

    it("names the one file when there is one", () => {
        expect(describeChannelDeletion(1, true)).toBe(
            "This permanently deletes the channel's one saved media file, its thumbnail and live chat replay from disk, and removes its comments. This cannot be undone."
        );
    });

    it("names the count, formatted, when there are many", () => {
        expect(describeChannelDeletion(27, true)).toContain("all 27 of the channel's saved videos");
        // The scale is the point, so a four-digit count gets its separator rather than reading as
        // a number the eye has to parse.
        expect(describeChannelDeletion(1075, false)).toContain("all 1,075 of the channel's");
    });
});

describe("describeMediaDeletion", () => {
    it("follows the same setting", () => {
        expect(describeMediaDeletion(false)).toBe(
            "This moves the media file, its thumbnail and live chat replay to the library's trash, where they stay for 30 days, and removes its saved comments, which the trash does not keep."
        );
        expect(describeMediaDeletion(true)).toBe(
            "This permanently deletes the media file, its thumbnail and live chat replay from disk, and removes its saved comments. This cannot be undone."
        );
    });
});
