import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FORMATS_PAUSE_MS, pickBatchFormatId, useBatchFormats } from "./use-batch-formats";
import { buildMergedFormats } from "../services/yt-dlp-format-rules";
import type { YtDlpFormat, YtDlpFormatsResult } from "../types/media";

vi.mock("../services/media-download-service", () => ({
    listYtDlpFormats: vi.fn(),
    cancelMediaDownload: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { cancelMediaDownload, listYtDlpFormats } from "../services/media-download-service";

function format(overrides: Partial<YtDlpFormat>): YtDlpFormat {
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

const RAW_FORMATS = [
    format({ format_id: "137", has_audio: false, height: 1080 }),
    format({ format_id: "136", has_audio: false, height: 720 }),
    format({ format_id: "140", has_video: false, media_type: "audio", abr: 128 }),
];

function listing(id: string): YtDlpFormatsResult {
    return {
        suggested_title: `Title ${id}`,
        youtube_video_id: id,
        formats: RAW_FORMATS,
        terminal_logs: [],
    };
}

const MEDIA = [
    { youtubeVideoId: "aaaaaaaaaaa", title: "A" },
    { youtubeVideoId: "bbbbbbbbbbb", title: "B" },
];

const NO_COOKIES = { cookiesBrowser: null, cookiesPath: null };

describe("pickBatchFormatId", () => {
    const formats = buildMergedFormats(RAW_FORMATS);

    it("picks by the quality given", () => {
        expect(pickBatchFormatId(formats, "best")).toBe("137+140");
        expect(pickBatchFormatId(formats, "720")).toBe("136+140");
        expect(pickBatchFormatId(formats, "360")).toBe("136+140");
        expect(pickBatchFormatId(formats, "audio")).toBe("140");
    });
});

describe("useBatchFormats", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        vi.mocked(listYtDlpFormats).mockImplementation(async (url: string) =>
            listing(url.slice(-11))
        );
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("lists each media in turn, a pause apart, and pre-selects one by the quality", async () => {
        const { result } = renderHook(() => useBatchFormats());

        let pending: Promise<void> = Promise.resolve();
        act(() => {
            pending = result.current.loadAll(
                MEDIA,
                { ...NO_COOKIES, cookiesBrowser: "firefox" },
                "720"
            );
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });

        expect(listYtDlpFormats).toHaveBeenCalledTimes(1);
        expect(listYtDlpFormats).toHaveBeenCalledWith(
            "https://www.youtube.com/watch?v=aaaaaaaaaaa",
            "firefox",
            null,
            expect.stringMatching(/^batch-formats-/)
        );

        await act(async () => {
            await vi.advanceTimersByTimeAsync(FORMATS_PAUSE_MS);
            await pending;
        });

        expect(listYtDlpFormats).toHaveBeenCalledTimes(2);
        expect(result.current.isLoading).toBe(false);
        expect(result.current.entries.get("aaaaaaaaaaa")).toMatchObject({
            status: "loaded",
            selectedFormatId: "136+140",
            title: "Title aaaaaaaaaaa",
        });
    });

    it("changes one media's format, or every one's by a rule", async () => {
        const { result } = renderHook(() => useBatchFormats());

        let pending: Promise<void> = Promise.resolve();
        act(() => {
            pending = result.current.loadAll(MEDIA, NO_COOKIES, "best");
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(FORMATS_PAUSE_MS);
            await pending;
        });

        act(() => {
            result.current.selectFormat("aaaaaaaaaaa", "140");
        });
        expect(result.current.entries.get("aaaaaaaaaaa")?.selectedFormatId).toBe("140");
        expect(result.current.entries.get("bbbbbbbbbbb")?.selectedFormatId).toBe("137+140");

        act(() => {
            result.current.preselectAll("audio");
        });
        expect(result.current.entries.get("bbbbbbbbbbb")?.selectedFormatId).toBe("140");
    });

    it("says why a media's formats failed to load, and loads them again on retry", async () => {
        vi.mocked(listYtDlpFormats).mockRejectedValueOnce(new Error("HTTP Error 429"));
        const { result } = renderHook(() => useBatchFormats());

        let pending: Promise<void> = Promise.resolve();
        act(() => {
            pending = result.current.loadAll([MEDIA[0]!], NO_COOKIES, "best");
        });
        await act(async () => {
            await pending;
        });

        expect(result.current.entries.get("aaaaaaaaaaa")?.status).toBe("failed");
        expect(result.current.entries.get("aaaaaaaaaaa")?.error).not.toBeNull();

        await act(async () => {
            await result.current.retry(MEDIA[0]!, NO_COOKIES, "best");
        });

        expect(result.current.entries.get("aaaaaaaaaaa")?.status).toBe("loaded");
    });

    it("forgets what was listed and stops a listing on reset", async () => {
        vi.mocked(listYtDlpFormats).mockReturnValueOnce(new Promise(() => {}));
        const { result } = renderHook(() => useBatchFormats());

        act(() => {
            void result.current.loadAll(MEDIA, NO_COOKIES, "best");
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        const runId = vi.mocked(listYtDlpFormats).mock.calls[0]?.[3];

        act(() => {
            result.current.reset();
        });

        expect(cancelMediaDownload).toHaveBeenCalledWith(runId);
        expect(result.current.entries.size).toBe(0);
        expect(result.current.isLoading).toBe(false);
    });
});
