import { describe, expect, it } from "vitest";
import type { YtDlpFormat } from "../types/media";
import {
    buildFormatBadgeLabel,
    buildFormatBadgeTone,
    getBadgeStyle,
} from "./yt-dlp-format-badge";

function makeFormat(overrides: Partial<YtDlpFormat> = {}): YtDlpFormat {
    return {
        format_id: "137",
        display_name: "Video + Audio",
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

describe("buildFormatBadgeLabel", () => {
    it("returns the empty-state label when no format is selected", () => {
        expect(buildFormatBadgeLabel(null)).toBe("NO FORMAT SELECTED");
    });

    it("maps the display_name prefix (case/space insensitive) to a label", () => {
        expect(buildFormatBadgeLabel(makeFormat({ display_name: "merged (137+140)" }))).toBe(
            "MERGED"
        );
        expect(buildFormatBadgeLabel(makeFormat({ display_name: "  native hls " }))).toBe("NATIVE");
        expect(buildFormatBadgeLabel(makeFormat({ display_name: "Video only 1080p" }))).toBe(
            "VIDEO ONLY"
        );
        expect(buildFormatBadgeLabel(makeFormat({ display_name: "Audio only" }))).toBe("AUDIO ONLY");
    });

    it("falls back to the track composition when the display_name has no known prefix", () => {
        expect(
            buildFormatBadgeLabel(
                makeFormat({ display_name: "1080p", has_video: true, has_audio: true })
            )
        ).toBe("VIDEO + AUDIO");
        expect(
            buildFormatBadgeLabel(
                makeFormat({ display_name: "1080p", has_video: true, has_audio: false })
            )
        ).toBe("VIDEO ONLY");
        expect(
            buildFormatBadgeLabel(
                makeFormat({ display_name: "128kbps", has_video: false, has_audio: true })
            )
        ).toBe("AUDIO ONLY");
    });
});

describe("buildFormatBadgeTone", () => {
    it("returns the neutral tone when no format is selected", () => {
        expect(buildFormatBadgeTone(null)).toBe("neutral");
    });

    it("maps known display_name prefixes to their tones", () => {
        expect(buildFormatBadgeTone(makeFormat({ display_name: "Merged" }))).toBe("violet");
        expect(buildFormatBadgeTone(makeFormat({ display_name: "Native" }))).toBe("green");
        expect(buildFormatBadgeTone(makeFormat({ display_name: "Video only" }))).toBe("blue");
        expect(buildFormatBadgeTone(makeFormat({ display_name: "Audio only" }))).toBe("orange");
    });

    it("falls back to the track composition for an unknown display_name", () => {
        expect(
            buildFormatBadgeTone(
                makeFormat({ display_name: "1080p", has_video: true, has_audio: true })
            )
        ).toBe("green");
        expect(
            buildFormatBadgeTone(
                makeFormat({ display_name: "1080p", has_video: true, has_audio: false })
            )
        ).toBe("blue");
        expect(
            buildFormatBadgeTone(
                makeFormat({ display_name: "128kbps", has_video: false, has_audio: true })
            )
        ).toBe("orange");
    });
});

describe("getBadgeStyle", () => {
    it("returns a distinct style for each known tone", () => {
        const tones = ["violet", "blue", "green", "orange", "red", "yellow"] as const;
        const backgrounds = tones.map((tone) => getBadgeStyle(tone).background);

        // Every known tone maps to its own background color (no accidental duplication).
        expect(new Set(backgrounds).size).toBe(tones.length);

        for (const tone of tones) {
            const style = getBadgeStyle(tone);
            expect(style.background).toBeTruthy();
            expect(style.borderColor).toBeTruthy();
            expect(style.color).toBeTruthy();
        }
    });

    it("falls back to the neutral style for the neutral tone", () => {
        const neutral = getBadgeStyle("neutral");
        expect(neutral.background).toBe("rgba(255,255,255,0.055)");
        expect(neutral.color).toBe("rgba(255,255,255,0.66)");
    });
});
