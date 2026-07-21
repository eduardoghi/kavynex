import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import type { YtDlpFormat } from "../types/media";
import {
    buildCompactLabel,
    buildMergedFormats,
    inferPreferredFormatId,
    inferSelectedMediaType,
    isValidYtDlpFormatId,
} from "./yt-dlp-format-rules";

// The backend's shape, which carries no label - buildMergedFormats is what adds one.
function format(overrides: Partial<YtDlpFormat> = {}): YtDlpFormat {
    return {
        format_id: "0",
        ext: "mp4",
        media_type: "video",
        has_video: true,
        has_audio: true,
        filesize_bytes: null,
        height: null,
        abr: null,
        tbr: null,
        vcodec: null,
        protocol: null,
        ...overrides,
    };
}

describe("buildCompactLabel", () => {
    it("labels a merged video with resolution, ext and codec", () => {
        const label = buildCompactLabel(
            "merged",
            format({ height: 1080, ext: "mp4", vcodec: "avc1.640028" })
        );
        expect(label).toBe("Merged · 1080p · MP4 · AVC (H.264)");
    });

    it("labels an audio-only format with the preferred ext and bitrate", () => {
        const label = buildCompactLabel(
            "audio_only",
            format({ ext: "m4a", abr: 128, has_video: false }),
            "M4A"
        );
        expect(label).toBe("Audio only · M4A · 128 kbps");
    });

    it("marks DRC audio and appends the protocol", () => {
        const label = buildCompactLabel(
            "audio_only",
            format({ format_id: "251-drc", ext: "webm", abr: 160, protocol: "https" })
        );
        expect(label).toContain("DRC");
        expect(label).toContain("HTTPS");
    });
});

describe("buildMergedFormats", () => {
    it("synthesizes a merged video+audio option from separate streams", () => {
        const merged = buildMergedFormats([
            format({ format_id: "137", height: 1080, has_video: true, has_audio: false }),
            format({ format_id: "140", ext: "m4a", abr: 128, has_video: false, has_audio: true }),
        ]);

        // The first entry is the synthesized merged selector (rank 0), combining both ids.
        expect(merged[0]!.format_id).toBe("137+140");
        expect(merged[0]!.has_video).toBe(true);
        expect(merged[0]!.has_audio).toBe(true);
    });

    it("prefers m4a and higher bitrate audio as the merge partner", () => {
        const merged = buildMergedFormats([
            format({ format_id: "137", height: 1080, has_video: true, has_audio: false }),
            format({ format_id: "251", ext: "webm", abr: 160, has_video: false, has_audio: true }),
            format({ format_id: "140", ext: "m4a", abr: 128, has_video: false, has_audio: true }),
        ]);

        // m4a wins the boost over the higher-bitrate webm, so the merge uses 140.
        expect(merged[0]!.format_id).toBe("137+140");
    });

    it("orders video-only options by descending resolution", () => {
        const merged = buildMergedFormats([
            format({ format_id: "a", height: 720, has_video: true, has_audio: false }),
            format({ format_id: "b", height: 2160, has_video: true, has_audio: false }),
            format({ format_id: "c", height: 1080, has_video: true, has_audio: false }),
        ]);

        // No audio means no merged entries; video-only ranked by resolution desc.
        expect(merged.map((f) => f.height)).toEqual([2160, 1080, 720]);
    });

    it("sums the merged size only when both tracks report one", () => {
        const merged = buildMergedFormats([
            format({
                format_id: "137",
                height: 1080,
                has_video: true,
                has_audio: false,
                filesize_bytes: 50_000_000,
            }),
            format({
                format_id: "140",
                ext: "m4a",
                abr: 128,
                has_video: false,
                has_audio: true,
                filesize_bytes: 500_000,
            }),
        ]);

        expect(merged[0]!.filesize_bytes).toBe(50_500_000);
    });

    it("reports an unknown merged size when a track has no filesize", () => {
        // yt-dlp routinely omits filesize on DASH video-only formats. Coalescing the missing
        // side to 0 made the merged entry report the size of its audio alone - a 1080p option
        // rendered as "500 KB". Unknown is the honest answer.
        const merged = buildMergedFormats([
            format({
                format_id: "137",
                height: 1080,
                has_video: true,
                has_audio: false,
                filesize_bytes: null,
            }),
            format({
                format_id: "140",
                ext: "m4a",
                abr: 128,
                has_video: false,
                has_audio: true,
                filesize_bytes: 500_000,
            }),
        ]);

        expect(merged[0]!.format_id).toBe("137+140");
        expect(merged[0]!.filesize_bytes).toBeNull();
    });

    it("drops duplicate format ids", () => {
        const merged = buildMergedFormats([
            format({ format_id: "137", height: 1080, has_video: true, has_audio: false }),
            format({ format_id: "137", height: 1080, has_video: true, has_audio: false }),
        ]);

        expect(merged.filter((f) => f.format_id === "137")).toHaveLength(1);
    });
});

describe("inferPreferredFormatId", () => {
    it("prefers a merged selector, then a native format, then the first", () => {
        expect(
            inferPreferredFormatId([
                format({ format_id: "137", has_audio: false }),
                format({ format_id: "137+140" }),
            ])
        ).toBe("137+140");

        expect(
            inferPreferredFormatId([
                format({ format_id: "18", has_video: true, has_audio: true }),
                format({ format_id: "137", has_audio: false }),
            ])
        ).toBe("18");

        expect(
            inferPreferredFormatId([format({ format_id: "251", has_video: false, has_audio: true })])
        ).toBe("251");
    });

    it("returns an empty string with no formats", () => {
        expect(inferPreferredFormatId([])).toBe("");
    });
});

describe("inferSelectedMediaType", () => {
    it("returns the selected format's media type", () => {
        const formats = [
            format({ format_id: "137", media_type: "video" }),
            format({ format_id: "140", media_type: "audio" }),
        ];
        expect(inferSelectedMediaType(formats, "140")).toBe("audio");
    });

    it("falls back to the first format, then to video", () => {
        expect(inferSelectedMediaType([format({ media_type: "audio" })], "missing")).toBe("audio");
        expect(inferSelectedMediaType([], "anything")).toBe("video");
    });
});

// The backend has its own copy of this rule (is_valid_format_id in
// src-tauri/src/services/yt_dlp_download/mod.rs) that rejects a malformed format id regardless of
// what this client check lets through. The two are independent implementations that must agree on
// every id: buildMergedFormats builds the `<video>+<audio>` selector, and if the two rules drifted a
// selector this side produced could come back as a raw backend error instead of the resolved
// download. Both sides assert against the same shared fixture so a divergence fails a test here (and
// the mirrored one in yt_dlp_download/mod.rs) rather than reaching a user. Add a case to
// shared/yt-dlp-format-id-cases.json and both checks pick it up.
describe("isValidYtDlpFormatId shared parity fixture", () => {
    // Resolved from the repo root (vitest's cwd), matching the youtube-handle parity test.
    const fixture = JSON.parse(
        readFileSync(resolve(process.cwd(), "shared/yt-dlp-format-id-cases.json"), "utf-8")
    ) as { valid: string[]; invalid: string[] };

    it.each(fixture.valid)("accepts %j", (id) => {
        expect(isValidYtDlpFormatId(id)).toBe(true);
    });

    it.each(fixture.invalid)("rejects %j", (id) => {
        expect(isValidYtDlpFormatId(id)).toBe(false);
    });
});

describe("buildMergedFormats produces backend-valid format ids", () => {
    it("every synthesized selector passes isValidYtDlpFormatId", () => {
        // Real yt-dlp format ids (alphanumeric plus `.`/`_`/`-`). buildMergedFormats joins a
        // video-only id and the preferred audio id with `+`; this pins that whatever it builds is a
        // selector the backend's is_valid_format_id accepts, so a change to the construction that
        // produced an invalid id would fail here instead of after the IPC round trip.
        const formats = [
            format({ format_id: "137", has_video: true, has_audio: false }),
            format({ format_id: "hls_1080", has_video: true, has_audio: false }),
            format({ format_id: "248", has_video: true, has_audio: false, ext: "webm" }),
            format({ format_id: "233-drc", has_video: false, has_audio: true, ext: "m4a" }),
            // A native (already-muxed) format is passed through unchanged; it must be valid too.
            format({ format_id: "18", has_video: true, has_audio: true }),
        ];

        const options = buildMergedFormats(formats);

        expect(options.length).toBeGreaterThan(0);
        // At least one genuinely merged (`+`-combined) selector was synthesized.
        expect(options.some((option) => option.format_id.includes("+"))).toBe(true);
        for (const option of options) {
            expect(isValidYtDlpFormatId(option.format_id)).toBe(true);
        }
    });
});
