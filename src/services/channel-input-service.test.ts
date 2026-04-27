import { describe, expect, it } from "vitest";
import {
    requireLibraryPath,
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
        const result = validateChannelId(10);

        expect(result).toEqual({
            channelId: 10,
        });
    });

    it("rejects invalid channel id", () => {
        expect(() => validateChannelId(0)).toThrow(
            "Channel id is invalid."
        );
    });
});

describe("requireLibraryPath", () => {
    it("normalizes valid library path", () => {
        const result = requireLibraryPath("  /library  ");

        expect(result).toBe("/library");
    });

    it("rejects empty library path", () => {
        expect(() => requireLibraryPath("   ")).toThrow(
            "Library folder must be configured for this operation."
        );
    });

    it("uses custom message when provided", () => {
        expect(() =>
            requireLibraryPath("   ", "Custom library path message.")
        ).toThrow("Custom library path message.");
    });
});