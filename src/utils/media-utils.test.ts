import { describe, expect, it } from "vitest";
import {
    mediaTypeFromFile,
    resolveStoredPath,
    extensionFromPath,
} from "./media-utils";

describe("media-utils", () => {
    it("detects audio media type from file extension", () => {
        expect(mediaTypeFromFile("C:/media/music.mp3")).toBe("audio");
        expect(mediaTypeFromFile("C:/media/video.mp4")).toBe("video");
    });

    it("extracts file extension correctly", () => {
        expect(extensionFromPath("/tmp/test.webm")).toBe("webm");
        expect(extensionFromPath("/tmp/noext")).toBe("");
    });

    it("resolves relative stored path against library path", () => {
        expect(resolveStoredPath("video/media_abc.mp4", "/library/base")).toBe(
            "/library/base/video/media_abc.mp4"
        );
    });

    it("keeps absolute stored path as absolute", () => {
        expect(resolveStoredPath("C:\\library\\video\\file.mp4", "/library/base")).toBe(
            "C:/library/video/file.mp4"
        );
    });

    it("returns null for empty stored path", () => {
        expect(resolveStoredPath("", "/library/base")).toBeNull();
        expect(resolveStoredPath(null, "/library/base")).toBeNull();
    });
});