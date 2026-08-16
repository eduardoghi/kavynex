import { describe, expect, it } from "vitest";
import {
    advanceYtDlpProgress,
    parseYtDlpProgress,
    type YtDlpProgress,
} from "./yt-dlp-progress";

describe("parseYtDlpProgress", () => {
    it("reads the percentage out of a download line", () => {
        // The shape `--newline --progress` writes, which is what the backend passes.
        expect(parseYtDlpProgress("[download]   4.2% of  123.45MiB at    1.23MiB/s ETA 01:39")).toEqual(
            { phase: "downloading", percent: 4.2 }
        );
    });

    it("reads the completion line, which carries no decimal", () => {
        expect(parseYtDlpProgress("[download] 100% of  123.45MiB in 00:01:39")).toEqual({
            phase: "downloading",
            percent: 100,
        });
    });

    it("reads a fragmented download's percentage", () => {
        // DASH formats report fragments after the ETA; the percentage is in the same position.
        expect(
            parseYtDlpProgress("[download]  12.5% of ~ 50.00MiB at 900.00KiB/s ETA 00:52 (frag 3/24)")
                ?.percent
        ).toBe(12.5);
    });

    it("keeps the downloading phase for a download line with no percentage", () => {
        // `Destination:` and `Resuming` say which stage the run is in even though they carry no
        // number, and answering null for the whole line would drop the phase back to the previous
        // one, which is how a merge would end up labelled as a download.
        for (const line of [
            "[download] Destination: video.f137.mp4",
            "[download] Resuming download at byte 1048576",
        ]) {
            expect(parseYtDlpProgress(line)).toEqual({ phase: "downloading", percent: null });
        }
    });

    it("names each post-processing stage", () => {
        const stages: ReadonlyArray<readonly [string, YtDlpProgress["phase"]]> = [
            ['[Merger] Merging formats into "video.mp4"', "merging"],
            ["[ExtractAudio] Destination: audio.m4a", "extracting-audio"],
            ['[EmbedThumbnail] mutagen: Adding thumbnail to "audio.m4a"', "embedding-thumbnail"],
            ['[Metadata] Adding metadata to "video.mp4"', "writing-metadata"],
            ["[ThumbnailsConvertor] Converting thumbnail to jpg", "converting-thumbnail"],
        ];

        for (const [line, phase] of stages) {
            expect(parseYtDlpProgress(line)).toEqual({ phase, percent: null });
        }
    });

    it("ignores a line that reports no progress at all", () => {
        for (const line of [
            "",
            "   ",
            "[youtube] abc123: Downloading webpage",
            "WARNING: Requested format is not available",
            "ERROR: unable to download video data",
        ]) {
            expect(parseYtDlpProgress(line)).toBeNull();
        }
    });

    it("does not read a percentage that is not the progress field", () => {
        // The anchor is what makes this hold: a percent sign inside a filename or a message is not
        // progress, and a bar driven from one would jump around for no reason.
        expect(parseYtDlpProgress('[download] Destination: 50% off sale.mp4')).toEqual({
            phase: "downloading",
            percent: null,
        });
        expect(parseYtDlpProgress("[youtube] Extracting 80% of nothing")).toBeNull();
    });

    it("clamps a value outside the range instead of trusting it", () => {
        // Parsed out of an external tool's output. A bar past 100 renders wrong rather than
        // throwing, which is the failure nobody reports.
        expect(parseYtDlpProgress("[download] 999% of 1.00MiB")?.percent).toBe(100);
    });
});

describe("advanceYtDlpProgress", () => {
    const downloading: YtDlpProgress = { phase: "downloading", percent: 88 };

    it("keeps the current state for a line that reports nothing", () => {
        expect(advanceYtDlpProgress(downloading, "[youtube] abc: Downloading webpage")).toBe(
            downloading
        );
    });

    it("keeps the shown percentage across a download line that carries none", () => {
        // Otherwise the bar would blink to indeterminate on every `Destination:` line, which yt-dlp
        // writes in the middle of a run.
        expect(advanceYtDlpProgress(downloading, "[download] Destination: video.f140.m4a")).toBe(
            downloading
        );
    });

    it("clears the percentage when the stage changes", () => {
        // The reading this exists to prevent: the merge inheriting the download's 100% shows a full
        // bar while FFmpeg works silently for minutes, which is a finished-then-frozen run rather
        // than a working one.
        expect(advanceYtDlpProgress(downloading, '[Merger] Merging formats into "video.mp4"')).toEqual(
            { phase: "merging", percent: null }
        );
    });

    it("starts from nothing", () => {
        expect(advanceYtDlpProgress(null, "[download]   0.0% of 100.00MiB")).toEqual({
            phase: "downloading",
            percent: 0,
        });
        expect(advanceYtDlpProgress(null, "[youtube] abc: Downloading webpage")).toBeNull();
    });

    it("follows a second file back down from 100", () => {
        // A video+audio selection downloads two files, so the percentage legitimately restarts. The
        // phase label is what carries that; the number is per file and says so in its doc comment.
        const done: YtDlpProgress = { phase: "downloading", percent: 100 };

        expect(advanceYtDlpProgress(done, "[download]   0.4% of  9.00MiB")?.percent).toBe(0.4);
    });
});
