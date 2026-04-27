import { describe, expect, it } from "vitest";
import { isValidNormalizedYoutubeHandle, normalizeYoutubeHandle } from "./youtube";

describe("youtube utils", () => {
    it("normalizes plain handle to @handle", () => {
        expect(normalizeYoutubeHandle("LinusTechTips")).toBe("@LinusTechTips");
    });

    it("normalizes full youtube handle url", () => {
        expect(normalizeYoutubeHandle("https://www.youtube.com/@Hardwareunboxed")).toBe("@Hardwareunboxed");
    });

    it("preserves channel path format", () => {
        expect(normalizeYoutubeHandle("youtube.com/channel/abc123")).toBe("channel/abc123");
    });

    it("returns empty for invalid path-only prefix", () => {
        expect(normalizeYoutubeHandle("channel/")).toBe("");
        expect(normalizeYoutubeHandle("user/")).toBe("");
        expect(normalizeYoutubeHandle("c/")).toBe("");
        expect(normalizeYoutubeHandle("channel")).toBe("");
        expect(normalizeYoutubeHandle("user")).toBe("");
        expect(normalizeYoutubeHandle("c")).toBe("");
    });

    it("validates normalized handles correctly", () => {
        expect(isValidNormalizedYoutubeHandle("@Hardwareunboxed")).toBe(true);
        expect(isValidNormalizedYoutubeHandle("channel/abc123")).toBe(true);
        expect(isValidNormalizedYoutubeHandle("user/test-user")).toBe(true);

        expect(isValidNormalizedYoutubeHandle("@")).toBe(false);
        expect(isValidNormalizedYoutubeHandle("channel/")).toBe(false);
        expect(isValidNormalizedYoutubeHandle("invalid value")).toBe(false);
    });
});