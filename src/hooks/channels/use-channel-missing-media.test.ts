import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChannelMissingMedia } from "./use-channel-missing-media";
import type { MissingChannelMedia } from "../../types/generated/MissingChannelMedia";

vi.mock("../../services/media-download-service", () => ({
    listChannelMissingMedia: vi.fn(),
    cancelMediaDownload: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/channel-service", () => ({
    setChannelMediaIgnored: vi.fn(),
}));

vi.mock("../../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import {
    cancelMediaDownload,
    listChannelMissingMedia,
} from "../../services/media-download-service";
import { setChannelMediaIgnored } from "../../services/channel-service";
import { logError } from "../../utils/app-logger";

const LISTING: MissingChannelMedia = {
    missing: [
        {
            youtube_video_id: "aaaaaaaaaaa",
            title: "A video",
            kind: "video",
            duration_seconds: 61,
            published_at: 1_700_000_000,
        },
    ],
    ignored: [],
    listed: 3,
};

describe("useChannelMissingMedia", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(listChannelMissingMedia).mockReset();
    });

    it("lists the channel under a run id of its own", async () => {
        vi.mocked(listChannelMissingMedia).mockResolvedValueOnce(LISTING);
        const { result } = renderHook(() => useChannelMissingMedia(10));

        await act(async () => {
            await result.current.check();
        });

        expect(listChannelMissingMedia).toHaveBeenCalledWith(
            10,
            expect.stringMatching(/^channel-listing-/)
        );
        expect(result.current.result).toEqual(LISTING);
        expect(result.current.isLoading).toBe(false);
        expect(result.current.error).toBeNull();
    });

    it("says why a listing failed, and logs it", async () => {
        vi.mocked(listChannelMissingMedia).mockRejectedValueOnce(new Error("HTTP Error 429"));
        const { result } = renderHook(() => useChannelMissingMedia(10));

        await act(async () => {
            await result.current.check();
        });

        expect(result.current.error).not.toBeNull();
        expect(logError).toHaveBeenCalledTimes(1);
    });

    it("stops the listing it started, and reports nothing for it", async () => {
        let reject: (reason: unknown) => void = () => {};
        vi.mocked(listChannelMissingMedia).mockReturnValueOnce(
            new Promise<MissingChannelMedia>((_, rejectWith) => {
                reject = rejectWith;
            })
        );
        const { result } = renderHook(() => useChannelMissingMedia(10));

        let pending: Promise<void> = Promise.resolve();
        act(() => {
            pending = result.current.check();
        });
        expect(result.current.isLoading).toBe(true);
        const runId = vi.mocked(listChannelMissingMedia).mock.calls[0]?.[1];

        act(() => {
            result.current.cancel();
        });

        expect(cancelMediaDownload).toHaveBeenCalledWith(runId);
        expect(result.current.isLoading).toBe(false);

        await act(async () => {
            reject({ code: "YT_DLP_DOWNLOAD_CANCELLED", message: "cancelled" });
            await pending;
        });

        expect(result.current.error).toBeNull();
        expect(logError).not.toHaveBeenCalled();
    });

    it("stops a listing still running when the channel page goes", () => {
        vi.mocked(listChannelMissingMedia).mockReturnValueOnce(new Promise(() => {}));
        const { result, unmount } = renderHook(() => useChannelMissingMedia(10));

        act(() => {
            void result.current.check();
        });
        unmount();

        expect(cancelMediaDownload).toHaveBeenCalledTimes(1);
    });

    it("moves a media to the ignored list and back, saving each move", async () => {
        vi.mocked(listChannelMissingMedia).mockResolvedValueOnce(LISTING);
        vi.mocked(setChannelMediaIgnored).mockResolvedValue(undefined);
        const media = LISTING.missing[0]!;
        const { result } = renderHook(() => useChannelMissingMedia(10));

        await act(async () => {
            await result.current.check();
        });
        await act(async () => {
            await result.current.setIgnored(media, true);
        });

        expect(setChannelMediaIgnored).toHaveBeenLastCalledWith(10, "aaaaaaaaaaa", true);
        expect(result.current.result?.missing).toEqual([]);
        expect(result.current.result?.ignored).toEqual([media]);

        await act(async () => {
            await result.current.setIgnored(media, false);
        });

        expect(setChannelMediaIgnored).toHaveBeenLastCalledWith(10, "aaaaaaaaaaa", false);
        expect(result.current.result?.missing).toEqual([media]);
        expect(result.current.result?.ignored).toEqual([]);
    });

    it("puts a media back where it was when ignoring it cannot be saved", async () => {
        vi.mocked(listChannelMissingMedia).mockResolvedValueOnce(LISTING);
        vi.mocked(setChannelMediaIgnored).mockRejectedValueOnce(new Error("database is locked"));
        const { result } = renderHook(() => useChannelMissingMedia(10));

        await act(async () => {
            await result.current.check();
        });
        await act(async () => {
            await result.current.setIgnored(LISTING.missing[0]!, true);
        });

        expect(result.current.result?.missing).toEqual(LISTING.missing);
        expect(result.current.result?.ignored).toEqual([]);
        expect(result.current.ignoreError).not.toBeNull();
    });

    it("marks the media opened for import, until the next listing", async () => {
        vi.mocked(listChannelMissingMedia).mockResolvedValue(LISTING);
        const { result } = renderHook(() => useChannelMissingMedia(10));

        await act(async () => {
            await result.current.check();
        });
        act(() => {
            result.current.markOpened("aaaaaaaaaaa");
        });

        expect(result.current.openedIds.has("aaaaaaaaaaa")).toBe(true);

        await act(async () => {
            await result.current.check();
        });

        expect(result.current.openedIds.size).toBe(0);
    });
});
