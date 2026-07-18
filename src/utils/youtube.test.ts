import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
    buildYoutubeWatchUrl,
    isValidNormalizedYoutubeHandle,
    normalizeYoutubeHandle,
} from "./youtube";

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

    it("builds the watch url for a video id", () => {
        expect(buildYoutubeWatchUrl("dQw4w9WgXcQ")).toBe(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
        expect(buildYoutubeWatchUrl("  dQw4w9WgXcQ  ")).toBe(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
    });

    it("returns an empty string for a blank video id", () => {
        expect(buildYoutubeWatchUrl("")).toBe("");
        expect(buildYoutubeWatchUrl("   ")).toBe("");
    });

    it("percent-encodes the video id so it cannot break out of the query value", () => {
        expect(buildYoutubeWatchUrl("a b&list=x")).toBe(
            "https://www.youtube.com/watch?v=a%20b%26list%3Dx"
        );
    });
});

// The backend has its own copy of this rule (is_valid_youtube_handle in
// src-tauri/src/utils/validation.rs) that rejects a malformed handle regardless of what this
// client check let through. The two are independent implementations that must agree on every
// normalized handle: if they drift, an input this side accepts comes back as a raw backend error
// instead of the friendly one the UI expects. Both sides assert against the same shared fixture so
// a divergence fails a test here (and the mirrored one in validation.rs) rather than reaching a
// user. Add a case to shared/youtube-handle-cases.json and both checks pick it up.
describe("isValidNormalizedYoutubeHandle shared parity fixture", () => {
    // Resolved from the repo root (vitest's cwd), not import.meta.url: vitest does not serve the
    // test module as a file: URL, so fileURLToPath would reject it.
    const fixture = JSON.parse(
        readFileSync(resolve(process.cwd(), "shared/youtube-handle-cases.json"), "utf-8")
    ) as { valid: string[]; invalid: string[] };

    it.each(fixture.valid)("accepts %j", (handle) => {
        expect(isValidNormalizedYoutubeHandle(handle)).toBe(true);
    });

    it.each(fixture.invalid)("rejects %j", (handle) => {
        expect(isValidNormalizedYoutubeHandle(handle)).toBe(false);
    });
});