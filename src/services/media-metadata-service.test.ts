import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/media-utils", () => ({
    fileSrcFromStoredPath: vi.fn(() => "asset://localhost/media.mp4"),
}));

import { readMediaDurationInSeconds } from "./media-metadata-service";
import { fileSrcFromStoredPath } from "../utils/media-utils";

// A minimal stand-in for the HTMLMediaElement the service creates: the test drives its metadata /
// error events by hand (jsdom never fires them for a src that loads nothing) and inspects the
// cleanup calls. Every media element the service creates in a test is captured in `created`.
type StubMedia = {
    preload: string;
    duration: number;
    src: string;
    onloadedmetadata: null | (() => void);
    onerror: null | (() => void);
    removeAttribute: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
};

let created: StubMedia[] = [];

function makeStub(): StubMedia {
    return {
        preload: "",
        duration: Number.NaN,
        src: "",
        onloadedmetadata: null,
        onerror: null,
        removeAttribute: vi.fn(),
        load: vi.fn(),
    };
}

// The most recently created media element, asserted present so the tests read without non-null
// assertions (which the codebase avoids). The service creates exactly one element per non-blank
// call, so this is that call's element.
function lastCreated(): StubMedia {
    const media = created[created.length - 1];

    if (!media) {
        throw new Error("expected a media element to have been created");
    }

    return media;
}

describe("readMediaDurationInSeconds", () => {
    beforeEach(() => {
        created = [];
        vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
            const stub = makeStub();
            created.push(stub);
            // Only video/audio are ever requested by the service; the tag is carried through so a
            // test can assert the right element type was created.
            (stub as unknown as { tagName: string }).tagName = tag.toUpperCase();
            return stub as unknown as HTMLElement;
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("returns null without touching the DOM when either path is blank", async () => {
        expect(await readMediaDurationInSeconds("   ", "/lib", "video")).toBeNull();
        expect(await readMediaDurationInSeconds("video/a.mp4", "  ", "video")).toBeNull();
        expect(document.createElement).not.toHaveBeenCalled();
        expect(fileSrcFromStoredPath).not.toHaveBeenCalled();
    });

    it("creates a <video> element for video and an <audio> element for audio", async () => {
        void readMediaDurationInSeconds("video/a.mp4", "/lib", "video");
        void readMediaDurationInSeconds("audio/a.m4a", "/lib", "audio");

        expect(document.createElement).toHaveBeenNthCalledWith(1, "video");
        expect(document.createElement).toHaveBeenNthCalledWith(2, "audio");
    });

    it("resolves the floored duration once metadata loads", async () => {
        const promise = readMediaDurationInSeconds("video/a.mp4", "/lib", "video");
        const media = lastCreated();

        media.duration = 12.9;
        media.onloadedmetadata?.();

        await expect(promise).resolves.toBe(12);
        // The source is cleared and the element unloaded so it is not left holding the file.
        expect(media.removeAttribute).toHaveBeenCalledWith("src");
        expect(media.load).toHaveBeenCalled();
    });

    it("resolves null for a non-finite or non-positive duration", async () => {
        for (const badDuration of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
            const promise = readMediaDurationInSeconds("video/a.mp4", "/lib", "video");
            const media = lastCreated();

            media.duration = badDuration;
            media.onloadedmetadata?.();

            await expect(promise).resolves.toBeNull();
        }
    });

    it("resolves null when the element errors", async () => {
        const promise = readMediaDurationInSeconds("video/a.mp4", "/lib", "video");
        const media = lastCreated();

        media.onerror?.();

        await expect(promise).resolves.toBeNull();
    });

    it("settles only once, ignoring a later event", async () => {
        const promise = readMediaDurationInSeconds("video/a.mp4", "/lib", "video");
        const media = lastCreated();

        media.duration = 30;
        media.onloadedmetadata?.();
        // A late error after the value already resolved must not change or re-resolve it, and
        // cleanup must have detached the handler.
        expect(media.onerror).toBeNull();

        await expect(promise).resolves.toBe(30);
        expect(media.load).toHaveBeenCalledTimes(1);
    });
});
