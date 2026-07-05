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

    it("returns empty for blank input", () => {
        expect(normalizeYoutubeHandle("")).toBe("");
        expect(normalizeYoutubeHandle("   ")).toBe("");
    });

    it("returns empty when only the domain or slashes remain", () => {
        expect(normalizeYoutubeHandle("https://www.youtube.com/")).toBe("");
        expect(normalizeYoutubeHandle("/")).toBe("");
    });

    it("returns empty for @ without a handle", () => {
        expect(normalizeYoutubeHandle("@")).toBe("");
        expect(normalizeYoutubeHandle("@   ")).toBe("");
    });

    it("strips http and non-www url prefixes", () => {
        expect(normalizeYoutubeHandle("http://youtube.com/@abc")).toBe("@abc");
        expect(normalizeYoutubeHandle("https://youtube.com/@abc")).toBe("@abc");
    });

    it("only strips the url prefix at the start of the value", () => {
        expect(normalizeYoutubeHandle("see https://youtube.com/@abc")).toBe(
            "@see https://youtube.com/@abc"
        );
        expect(normalizeYoutubeHandle("my.youtube.com/abc")).toBe("@my.youtube.com/abc");
    });

    it("trims whitespace left after removing the url prefix", () => {
        expect(normalizeYoutubeHandle("youtube.com/ @abc")).toBe("@abc");
    });

    it("removes every trailing slash", () => {
        expect(normalizeYoutubeHandle("@abc//")).toBe("@abc");
    });

    it("preserves c and user path formats", () => {
        expect(normalizeYoutubeHandle("c/abc")).toBe("c/abc");
        expect(normalizeYoutubeHandle("user/abc")).toBe("user/abc");
    });

    it("trims the identifier and keeps nested path segments", () => {
        expect(normalizeYoutubeHandle("channel/ abc")).toBe("channel/abc");
        expect(normalizeYoutubeHandle("channel/a/b")).toBe("channel/a/b");
    });

    it("returns empty when the path identifier is only whitespace", () => {
        expect(normalizeYoutubeHandle("channel/ /")).toBe("");
    });

    it("trims the handle after stripping the leading @", () => {
        expect(normalizeYoutubeHandle("@ abc")).toBe("@abc");
    });

    it("trims the handle when there is no leading @", () => {
        expect(normalizeYoutubeHandle("abc /")).toBe("@abc");
    });

    it("validates normalized handles correctly", () => {
        expect(isValidNormalizedYoutubeHandle("@Hardwareunboxed")).toBe(true);
        expect(isValidNormalizedYoutubeHandle("channel/abc123")).toBe(true);
        expect(isValidNormalizedYoutubeHandle("user/test-user")).toBe(true);

        expect(isValidNormalizedYoutubeHandle("@")).toBe(false);
        expect(isValidNormalizedYoutubeHandle("channel/")).toBe(false);
        expect(isValidNormalizedYoutubeHandle("invalid value")).toBe(false);
    });

    it("rejects empty values before matching", () => {
        expect(isValidNormalizedYoutubeHandle("")).toBe(false);
        expect(isValidNormalizedYoutubeHandle("   ")).toBe(false);
    });

    it("trims the value and the handle before validating", () => {
        expect(isValidNormalizedYoutubeHandle("  @abc  ")).toBe(true);
        expect(isValidNormalizedYoutubeHandle("@ abc")).toBe(true);
    });

    it("requires the whole handle to be valid characters", () => {
        expect(isValidNormalizedYoutubeHandle("@a b")).toBe(false);
    });

    it("requires the path prefix to span the whole value", () => {
        expect(isValidNormalizedYoutubeHandle("xchannel/abc")).toBe(false);
        expect(isValidNormalizedYoutubeHandle("channel/abc\nmore")).toBe(false);
    });
});