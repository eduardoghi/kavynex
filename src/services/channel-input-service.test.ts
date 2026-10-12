import { describe, expect, it } from "vitest";
import {
    validateChannelId,
    validateCreateChannelInput,
} from "./channel-input-service";

describe("validateCreateChannelInput", () => {
    it("normalizes valid channel input", () => {
        const result = validateCreateChannelInput({
            name: "  Hardware Unboxed  ",
            youtubeHandle: "  https://www.youtube.com/@Hardwareunboxed  ",
        });

        expect(result).toEqual({
            name: "Hardware Unboxed",
            youtubeHandle: "@Hardwareunboxed",
            avatarPath: null,
        });
    });

    it("rejects empty channel name", () => {
        expect(() =>
            validateCreateChannelInput({
                name: "   ",
                youtubeHandle: "@Hardwareunboxed",
            })
        ).toThrow("Channel name is required.");
    });

    it("rejects empty youtube handle", () => {
        expect(() =>
            validateCreateChannelInput({
                name: "Hardware Unboxed",
                youtubeHandle: "   ",
            })
        ).toThrow("YouTube handle is required.");
    });

    it("accepts normalized path-based handles", () => {
        const result = validateCreateChannelInput({
            name: "Channel A",
            youtubeHandle: "youtube.com/channel/abc123",
        });

        expect(result).toEqual({
            name: "Channel A",
            youtubeHandle: "channel/abc123",
            avatarPath: null,
        });
    });
});

describe("validateChannelId", () => {
    it("accepts valid channel id", () => {
        expect(() => validateChannelId(10)).not.toThrow();
    });

    it("rejects invalid channel id", () => {
        expect(() => validateChannelId(0)).toThrow(
            "Channel id is invalid."
        );
    });
});
