import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BATCH_PAUSE_MS, useBatchImport, type BatchImportOptions } from "./use-batch-import";

vi.mock("../services/media-service", () => ({
    createMedia: vi.fn(),
}));

vi.mock("../services/media-download-service", () => ({
    cancelMediaDownload: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { createMedia } from "../services/media-service";
import { cancelMediaDownload } from "../services/media-download-service";

const ITEMS = [
    { youtubeVideoId: "aaaaaaaaaaa", title: "A", formatId: "137+140" },
    { youtubeVideoId: "bbbbbbbbbbb", title: "B", formatId: "18" },
    { youtubeVideoId: "ccccccccccc", title: "C", formatId: "140" },
];

const OPTIONS: BatchImportOptions = {
    downloadComments: true,
    downloadLiveChat: false,
    cookiesBrowser: null,
    cookiesPath: null,
};

function renderBatch() {
    const onReloadMedia = vi.fn().mockResolvedValue(undefined);
    const startRun = vi.fn();
    const appendManualLog = vi.fn();
    // The add-media flag, simplified. It runs the task, which is all a batch needs of it here.
    const runAddMediaSpy = vi.fn();
    const runAddMedia = async <T,>(task: () => Promise<T>): Promise<T | undefined> => {
        runAddMediaSpy();
        return task();
    };

    const rendered = renderHook(() =>
        useBatchImport({
            importMode: "copy",
            libraryPath: "/library",
            runAddMedia,
            startRun,
            appendManualLog,
            onReloadMedia,
        })
    );

    return { ...rendered, onReloadMedia, startRun, runAddMedia: runAddMediaSpy };
}

// Lets every pending promise and the pause between two media run.
async function runPauses(times: number): Promise<void> {
    for (let index = 0; index < times; index += 1) {
        await act(async () => {
            await vi.advanceTimersByTimeAsync(BATCH_PAUSE_MS);
        });
    }
}

describe("useBatchImport", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        vi.mocked(createMedia).mockResolvedValue({
            id: 1,
            comments: "saved",
            originalKept: false,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("adds each media in turn, in the format chosen for it, and reloads once", async () => {
        const { result, onReloadMedia, runAddMedia } = renderBatch();

        let pending: Promise<void> = Promise.resolve();
        act(() => {
            pending = result.current.start(10, ITEMS, OPTIONS);
        });
        await runPauses(3);
        await act(async () => {
            await pending;
        });

        expect(runAddMedia).toHaveBeenCalledTimes(1);
        expect(vi.mocked(createMedia).mock.calls.map(([input]) => input.ytDlpFormatId)).toEqual([
            "137+140",
            "18",
            "140",
        ]);
        expect(vi.mocked(createMedia).mock.calls[0]?.[0]).toMatchObject({
            channelId: 10,
            title: "A",
            sourceMode: "yt-dlp",
            sourceValue: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
            ytDlpYoutubeVideoId: "aaaaaaaaaaa",
            downloadComments: true,
            downloadLiveChat: false,
            cookiesBrowser: null,
            cookiesPath: null,
        });
        expect(result.current.items.map((item) => item.status)).toEqual(["done", "done", "done"]);
        expect(result.current.isRunning).toBe(false);
        expect(onReloadMedia).toHaveBeenCalledTimes(1);
    });

    it("waits between two media rather than starting the next at once", async () => {
        const { result } = renderBatch();

        act(() => {
            void result.current.start(10, ITEMS, OPTIONS);
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });

        expect(createMedia).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(BATCH_PAUSE_MS - 1);
        });
        expect(createMedia).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });
        expect(createMedia).toHaveBeenCalledTimes(2);
    });

    it("signs in the way the options say", async () => {
        const { result, startRun } = renderBatch();

        let pending: Promise<void> = Promise.resolve();
        act(() => {
            pending = result.current.start(10, [ITEMS[0]!], {
                ...OPTIONS,
                cookiesBrowser: "firefox",
            });
        });
        await act(async () => {
            await pending;
        });

        expect(vi.mocked(createMedia).mock.calls[0]?.[0]).toMatchObject({
            cookiesBrowser: "firefox",
            cookiesPath: null,
        });
        expect(startRun.mock.calls[0]?.[1]).toContain("--cookies-from-browser firefox");
    });

    it("reports a media that fails, goes on, and retries only the failed one", async () => {
        vi.mocked(createMedia)
            .mockRejectedValueOnce(new Error("HTTP Error 403"))
            .mockResolvedValue({ id: 2, comments: "failed", originalKept: false });
        const { result } = renderBatch();

        let pending: Promise<void> = Promise.resolve();
        act(() => {
            pending = result.current.start(10, ITEMS.slice(0, 2), OPTIONS);
        });
        await runPauses(2);
        await act(async () => {
            await pending;
        });

        expect(result.current.items[0]).toMatchObject({ status: "failed" });
        expect(result.current.items[0]?.message).not.toBeNull();
        expect(result.current.items[1]).toMatchObject({
            status: "done",
            message: "Added, but its comments could not be saved.",
        });

        await act(async () => {
            await result.current.retryFailed();
        });

        expect(createMedia).toHaveBeenCalledTimes(3);
        expect(vi.mocked(createMedia).mock.calls[2]?.[0]).toMatchObject({
            ytDlpYoutubeVideoId: "aaaaaaaaaaa",
            ytDlpFormatId: "137+140",
            downloadLiveChat: false,
        });
        expect(result.current.items).toHaveLength(1);
    });

    it("stops the media in progress and starts none of the rest", async () => {
        let rejectDownload: (reason: unknown) => void = () => {};
        vi.mocked(createMedia).mockReturnValueOnce(
            new Promise((_, reject) => {
                rejectDownload = reject;
            })
        );
        const { result } = renderBatch();

        let pending: Promise<void> = Promise.resolve();
        act(() => {
            pending = result.current.start(10, ITEMS, OPTIONS);
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        const downloadRunId = vi.mocked(createMedia).mock.calls[0]?.[0].ytDlpRunId;

        act(() => {
            result.current.stop();
        });

        expect(result.current.isStopping).toBe(true);
        expect(cancelMediaDownload).toHaveBeenCalledWith(downloadRunId);

        await act(async () => {
            rejectDownload({ code: "YT_DLP_DOWNLOAD_CANCELLED", message: "cancelled" });
            await pending;
        });

        expect(createMedia).toHaveBeenCalledTimes(1);
        expect(result.current.items.map((item) => item.status)).toEqual([
            "stopped",
            "stopped",
            "stopped",
        ]);
        expect(result.current.isRunning).toBe(false);
    });

    it("forgets a finished batch", async () => {
        const { result } = renderBatch();

        let pending: Promise<void> = Promise.resolve();
        act(() => {
            pending = result.current.start(10, [ITEMS[0]!], OPTIONS);
        });
        await act(async () => {
            await pending;
        });
        act(() => {
            result.current.clear();
        });

        expect(result.current.items).toEqual([]);
        expect(result.current.channelId).toBeNull();
    });
});
