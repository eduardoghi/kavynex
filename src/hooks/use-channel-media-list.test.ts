import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MediaRow } from "../types/media";
import type { MediaPage } from "../types/generated/MediaPage";
import {
    DEFAULT_MEDIA_QUERY_FILTERS,
    type MediaQueryFilters,
} from "../utils/media-library-filters";
import { useChannelMediaList } from "./use-channel-media-list";

vi.mock("../services", () => ({
    listChannelMediaPage: vi.fn(),
}));

vi.mock("../utils/error-message", () => ({
    resolveErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { listChannelMediaPage } from "../services";
import { logError } from "../utils/app-logger";

function createMediaRow(overrides: Partial<MediaRow> = {}): MediaRow {
    return {
        id: 1,
        channel_id: 10,
        title: "Item 1",
        file_path: "media/item-1.mp4",
        thumbnail_path: null,
        media_type: "video",
        youtube_video_id: null,
        watched_at: null,
        published_at: null,
        duration_seconds: 0,
        progress_seconds: 0,
        has_comments: 0,
        comments_count: 0,
        is_live: 0,
        has_live_chat: 0,
        live_chat_file_path: null,
        created_at: "2026-03-29T10:00:00.000Z",
        ...overrides,
    };
}

function page(items: MediaRow[], total: number): MediaPage {
    return { items, total };
}

const filteredQuery: MediaQueryFilters = {
    ...DEFAULT_MEDIA_QUERY_FILTERS,
    watched: "watched",
};

describe("useChannelMediaList", () => {
    const onError = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("loads the first page for the selected channel with limit/offset", async () => {
        vi.mocked(listChannelMediaPage).mockResolvedValue(
            page([createMediaRow({ id: 1, title: "Item 1" })], 3)
        );

        const { result } = renderHook(() =>
            useChannelMediaList({ selectedChannelId: 10, onError })
        );

        await act(async () => {
            await result.current.applyQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        expect(listChannelMediaPage).toHaveBeenCalledWith(
            10,
            expect.objectContaining({ limit: 100, offset: 0 })
        );
        expect(result.current.mediaItems).toHaveLength(1);
        expect(result.current.total).toBe(3);
        // The first (unfiltered) load also captures the channel-wide total.
        expect(result.current.channelTotal).toBe(3);
        expect(result.current.hasMore).toBe(true);
        expect(result.current.isLoadingMedia).toBe(false);
        expect(onError).not.toHaveBeenCalled();
    });

    it("does not overwrite the channel total on a filtered load", async () => {
        vi.mocked(listChannelMediaPage).mockResolvedValueOnce(page([createMediaRow()], 5));

        const { result } = renderHook(() =>
            useChannelMediaList({ selectedChannelId: 10, onError })
        );

        await act(async () => {
            await result.current.applyQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        expect(result.current.channelTotal).toBe(5);

        vi.mocked(listChannelMediaPage).mockResolvedValueOnce(page([createMediaRow()], 1));

        await act(async () => {
            await result.current.applyQuery(filteredQuery);
        });

        // total reflects the filtered match count, but the channel total stays at its unfiltered value.
        expect(result.current.total).toBe(1);
        expect(result.current.channelTotal).toBe(5);
    });

    it("clears when the channel is null and does not query", async () => {
        const { result } = renderHook(() =>
            useChannelMediaList({ selectedChannelId: null, onError })
        );

        await act(async () => {
            await result.current.applyQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        expect(result.current.mediaItems).toEqual([]);
        expect(result.current.total).toBe(0);
        expect(listChannelMediaPage).not.toHaveBeenCalled();
    });

    it("reports a load error", async () => {
        vi.mocked(listChannelMediaPage).mockRejectedValue(new Error("boom"));

        const { result } = renderHook(() =>
            useChannelMediaList({ selectedChannelId: 10, onError })
        );

        await act(async () => {
            await result.current.applyQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        expect(onError).toHaveBeenCalledWith("Failed to load channel media.");
        expect(result.current.mediaItems).toEqual([]);
        expect(result.current.isLoadingMedia).toBe(false);
        expect(logError).toHaveBeenCalledWith(
            "media-list",
            "Failed to load channel media.",
            expect.any(Error),
            { channelId: 10 }
        );
    });

    it("appends the next page on loadMore", async () => {
        vi.mocked(listChannelMediaPage).mockResolvedValueOnce(
            page([createMediaRow({ id: 1, title: "Item 1" })], 2)
        );

        const { result } = renderHook(() =>
            useChannelMediaList({ selectedChannelId: 10, onError })
        );

        await act(async () => {
            await result.current.applyQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        expect(result.current.hasMore).toBe(true);

        vi.mocked(listChannelMediaPage).mockResolvedValueOnce(
            page([createMediaRow({ id: 2, title: "Item 2" })], 2)
        );

        await act(async () => {
            await result.current.loadMore();
        });

        // The second call uses the running offset (the number of already-loaded rows).
        expect(listChannelMediaPage).toHaveBeenLastCalledWith(
            10,
            expect.objectContaining({ offset: 1 })
        );
        expect(result.current.mediaItems).toHaveLength(2);
        expect(result.current.mediaItems[1]?.title).toBe("Item 2");
        expect(result.current.hasMore).toBe(false);
    });

    it("does not loadMore past the total", async () => {
        vi.mocked(listChannelMediaPage).mockResolvedValueOnce(
            page([createMediaRow({ id: 1 })], 1)
        );

        const { result } = renderHook(() =>
            useChannelMediaList({ selectedChannelId: 10, onError })
        );

        await act(async () => {
            await result.current.applyQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        expect(result.current.hasMore).toBe(false);
        vi.mocked(listChannelMediaPage).mockClear();

        await act(async () => {
            await result.current.loadMore();
        });

        expect(listChannelMediaPage).not.toHaveBeenCalled();
    });

    it("decrements the totals when items are removed", async () => {
        vi.mocked(listChannelMediaPage).mockResolvedValueOnce(
            page([createMediaRow({ id: 1 }), createMediaRow({ id: 2 })], 2)
        );

        const { result } = renderHook(() =>
            useChannelMediaList({ selectedChannelId: 10, onError })
        );

        await act(async () => {
            await result.current.applyQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        expect(result.current.total).toBe(2);
        expect(result.current.channelTotal).toBe(2);

        act(() => {
            result.current.handleItemsRemoved(1);
        });

        expect(result.current.total).toBe(1);
        expect(result.current.channelTotal).toBe(1);
    });

    it("reloadMedia re-fetches the first page with the last applied filters", async () => {
        vi.mocked(listChannelMediaPage).mockResolvedValueOnce(page([createMediaRow()], 1));

        const { result } = renderHook(() =>
            useChannelMediaList({ selectedChannelId: 10, onError })
        );

        await act(async () => {
            await result.current.applyQuery(filteredQuery);
        });

        vi.mocked(listChannelMediaPage).mockResolvedValueOnce(page([createMediaRow()], 1));

        await act(async () => {
            await result.current.reloadMedia();
        });

        expect(listChannelMediaPage).toHaveBeenLastCalledWith(
            10,
            expect.objectContaining({ watched: "watched", offset: 0 })
        );
    });

    it("clears media explicitly", async () => {
        vi.mocked(listChannelMediaPage).mockResolvedValueOnce(page([createMediaRow()], 1));

        const { result } = renderHook(() =>
            useChannelMediaList({ selectedChannelId: 10, onError })
        );

        await act(async () => {
            await result.current.applyQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        expect(result.current.mediaItems).toHaveLength(1);

        act(() => {
            result.current.clearMedia();
        });

        expect(result.current.mediaItems).toEqual([]);
        expect(result.current.total).toBe(0);
        expect(result.current.isLoadingMedia).toBe(false);
    });

    it("ignores a stale result that resolves after clearMedia", async () => {
        let resolveFirst: ((value: MediaPage) => void) | null = null;

        vi.mocked(listChannelMediaPage).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveFirst = resolve;
                })
        );

        const { result } = renderHook(() =>
            useChannelMediaList({ selectedChannelId: 10, onError })
        );

        await act(async () => {
            void result.current.applyQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        act(() => {
            result.current.clearMedia();
        });

        await act(async () => {
            resolveFirst?.(page([createMediaRow({ title: "Stale" })], 1));
        });

        await waitFor(() => {
            expect(result.current.mediaItems).toEqual([]);
        });
    });

    it("keeps only the latest result when switching channels quickly", async () => {
        let resolveFirst: ((value: MediaPage) => void) | null = null;
        let resolveSecond: ((value: MediaPage) => void) | null = null;

        vi.mocked(listChannelMediaPage)
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveFirst = resolve;
                    })
            )
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveSecond = resolve;
                    })
            );

        const { result, rerender } = renderHook(
            (props: { selectedChannelId: number | null }) =>
                useChannelMediaList({ selectedChannelId: props.selectedChannelId, onError }),
            { initialProps: { selectedChannelId: 10 } }
        );

        await act(async () => {
            void result.current.applyQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        await act(async () => {
            rerender({ selectedChannelId: 20 });
        });

        await act(async () => {
            void result.current.applyQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        await act(async () => {
            resolveSecond?.(page([createMediaRow({ id: 2, channel_id: 20 })], 1));
        });

        await waitFor(() => {
            expect(result.current.mediaItems).toHaveLength(1);
            expect(result.current.mediaItems[0]?.channel_id).toBe(20);
        });

        // The first (channel 10) load resolving late must not clobber the channel 20 result.
        await act(async () => {
            resolveFirst?.(page([createMediaRow({ id: 1, channel_id: 10 })], 1));
        });

        expect(result.current.mediaItems).toHaveLength(1);
        expect(result.current.mediaItems[0]?.channel_id).toBe(20);
    });

    it("starts empty and not loading", () => {
        const { result } = renderHook(() =>
            useChannelMediaList({ selectedChannelId: 10, onError })
        );

        expect(result.current.isLoadingMedia).toBe(false);
        expect(result.current.mediaItems).toEqual([]);
        expect(result.current.total).toBe(0);
        expect(result.current.hasMore).toBe(false);
    });
});
