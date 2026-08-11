import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MediaRow } from "../../types/media";
import type { MediaPage } from "../../types/generated/MediaPage";
import {
    DEFAULT_MEDIA_QUERY_FILTERS,
    type MediaQueryFilters,
} from "../../utils/media-library-filters";
import { useChannelMediaList } from "./use-channel-media-list";

vi.mock("../../services", () => ({
    listChannelMediaPage: vi.fn(),
}));

vi.mock("../../utils/error-message", () => ({
    resolveErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

vi.mock("../../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { listChannelMediaPage } from "../../services";
import { logError } from "../../utils/app-logger";

// The page size both sides are calibrated against. Resolved from the repo root (vitest's cwd), not
// import.meta.url, matching the other shared-fixture readers - vitest does not serve the test module
// as a file: URL, so fileURLToPath would reject it.
const SHARED_MEDIA_PAGE_SIZE = (
    JSON.parse(
        readFileSync(resolve(process.cwd(), "shared/media-page-size.json"), "utf-8")
    ) as { mediaPageSize: number }
).mediaPageSize;

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
        // `clearAllMocks` clears recorded calls but leaves a `mockResolvedValueOnce` queue in
        // place, so a test that queues more pages than it consumes hands the leftovers to the next
        // one - which then loads a page it never set up and fails somewhere unrelated to its own
        // subject. Resetting the queue keeps each test's pages its own.
        vi.mocked(listChannelMediaPage).mockReset();
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

        // Asserted against the shared fixture rather than a literal, because the backend sizes the
        // display-thumbnail command's per-call budgets from the same number (see
        // the_generation_budget_covers_a_full_page_of_the_grid in
        // src-tauri/src/services/thumbnail/display.rs). Changing the page size on this side alone
        // used to leave those budgets calibrated for the old one, which is how a generation budget
        // of 64 ended up serving a page of 100.
        expect(listChannelMediaPage).toHaveBeenCalledWith(
            10,
            expect.objectContaining({ limit: SHARED_MEDIA_PAGE_SIZE, offset: 0 })
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

    it("does not append a row the list already holds", async () => {
        // The shape a rename produces. `editTitle` updates the row in place without reloading, and
        // every ORDER BY in resolve_order_by tie-breaks on title_normalized, so the renamed row can
        // move under the loaded window and come back inside the next page. The grid keys by id, so
        // appending it a second time is a duplicate React key and a card drawn twice.
        vi.mocked(listChannelMediaPage)
            .mockResolvedValueOnce(
                page([createMediaRow({ id: 1 }), createMediaRow({ id: 2 })], 4)
            )
            // Page two repeats id 2 - the row that shifted - alongside a genuinely new one.
            .mockResolvedValueOnce(
                page([createMediaRow({ id: 2 }), createMediaRow({ id: 3 })], 4)
            );

        const { result } = renderHook(() =>
            useChannelMediaList({ selectedChannelId: 10, onError })
        );

        await act(async () => {
            await result.current.applyQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        await act(async () => {
            await result.current.loadMore();
        });

        expect(result.current.mediaItems.map((item) => item.id)).toEqual([1, 2, 3]);
    });

    it("advances the offset by the rows the backend returned, not by the rows it kept", async () => {
        // The failure deduplication introduces if the cursor is read off the list length: a page
        // whose rows were all dropped as duplicates leaves the length unchanged, so the next
        // loadMore asks for the same offset again - forever, on every scroll to the bottom.
        // A total of six leaves a page still to fetch after the duplicate one, which is what makes
        // the third request happen at all.
        vi.mocked(listChannelMediaPage)
            .mockResolvedValueOnce(
                page([createMediaRow({ id: 1 }), createMediaRow({ id: 2 })], 6)
            )
            // An entirely duplicate page: nothing is appended.
            .mockResolvedValueOnce(
                page([createMediaRow({ id: 1 }), createMediaRow({ id: 2 })], 6)
            )
            .mockResolvedValueOnce(
                page([createMediaRow({ id: 3 }), createMediaRow({ id: 4 })], 6)
            );

        const { result } = renderHook(() =>
            useChannelMediaList({ selectedChannelId: 10, onError })
        );

        await act(async () => {
            await result.current.applyQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        await act(async () => {
            await result.current.loadMore();
        });

        expect(result.current.mediaItems).toHaveLength(2);
        expect(listChannelMediaPage).toHaveBeenLastCalledWith(
            10,
            expect.objectContaining({ offset: 2 })
        );

        await act(async () => {
            await result.current.loadMore();
        });

        // The third request moved on rather than re-asking for offset 2.
        expect(listChannelMediaPage).toHaveBeenLastCalledWith(
            10,
            expect.objectContaining({ offset: 4 })
        );
        expect(result.current.mediaItems.map((item) => item.id)).toEqual([1, 2, 3, 4]);
    });

    it("moves the offset back when loaded rows are removed", async () => {
        // A deleted row leaves the backend's sorted set and the loaded prefix at the same time, so
        // the cursor has to shrink with them. Left alone it would skip one row of the next page for
        // every media deleted.
        vi.mocked(listChannelMediaPage)
            .mockResolvedValueOnce(
                page(
                    [createMediaRow({ id: 1 }), createMediaRow({ id: 2 }), createMediaRow({ id: 3 })],
                    6
                )
            )
            .mockResolvedValueOnce(page([createMediaRow({ id: 4 })], 5));

        const { result } = renderHook(() =>
            useChannelMediaList({ selectedChannelId: 10, onError })
        );

        await act(async () => {
            await result.current.applyQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        act(() => {
            result.current.setMediaItems((items) => items.filter((item) => item.id !== 2));
            result.current.handleItemsRemoved(1);
        });

        expect(result.current.total).toBe(5);

        await act(async () => {
            await result.current.loadMore();
        });

        expect(listChannelMediaPage).toHaveBeenLastCalledWith(
            10,
            expect.objectContaining({ offset: 2 })
        );
    });

    it("fetches the row a rename displaced past the window instead of skipping it", async () => {
        // The failure this closes, end to end. Three rows are loaded out of six, so the cursor sits
        // at 3. Renaming a loaded row moves it in the backend's sort - every ORDER BY ties on
        // title_normalized - and if it lands at or past position 3, the row that was first on the
        // next page shifts onto position 2. Asking for offset 3 then starts one row too late and
        // that row is never fetched: it is not on screen, and nothing would ever ask for it again.
        vi.mocked(listChannelMediaPage)
            .mockResolvedValueOnce(
                page(
                    [createMediaRow({ id: 1 }), createMediaRow({ id: 2 }), createMediaRow({ id: 3 })],
                    6
                )
            )
            // The backend's view after the rename: id 4 has shifted onto position 2, so a request
            // from offset 2 is what returns it.
            .mockResolvedValueOnce(
                page([createMediaRow({ id: 4 }), createMediaRow({ id: 5 })], 6)
            );

        const { result } = renderHook(() =>
            useChannelMediaList({ selectedChannelId: 10, onError })
        );

        await act(async () => {
            await result.current.applyQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        act(() => {
            result.current.handleItemReordered();
        });

        await act(async () => {
            await result.current.loadMore();
        });

        expect(listChannelMediaPage).toHaveBeenLastCalledWith(
            10,
            expect.objectContaining({ offset: 2 })
        );
        // The displaced row is on screen, and the cursor is back where the rows handed out put it.
        expect(result.current.mediaItems.map((item) => item.id)).toEqual([1, 2, 3, 4, 5]);
    });

    it("costs nothing when the rename did not move the row across the boundary", async () => {
        // The other direction, and why calling this on every rename is safe: refetching one
        // position earlier normally returns a row the list already holds, which the append's own
        // dedup drops. The cursor still advances by what the backend returned, so it cannot stall
        // and re-request the same offset forever - which is what taking it from the list length
        // would do.
        vi.mocked(listChannelMediaPage)
            .mockResolvedValueOnce(
                page(
                    [createMediaRow({ id: 1 }), createMediaRow({ id: 2 }), createMediaRow({ id: 3 })],
                    6
                )
            )
            .mockResolvedValueOnce(
                page([createMediaRow({ id: 3 }), createMediaRow({ id: 4 })], 6)
            );

        const { result } = renderHook(() =>
            useChannelMediaList({ selectedChannelId: 10, onError })
        );

        await act(async () => {
            await result.current.applyQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        act(() => {
            result.current.handleItemReordered();
        });

        await act(async () => {
            await result.current.loadMore();
        });

        expect(result.current.mediaItems.map((item) => item.id)).toEqual([1, 2, 3, 4]);
        // 2 + the 2 rows returned, not 3 + 2: the cursor counts what was handed out, so the
        // position given back is taken again rather than lost.
        expect(result.current.hasMore).toBe(true);

        vi.mocked(listChannelMediaPage).mockResolvedValueOnce(page([createMediaRow({ id: 5 })], 6));

        await act(async () => {
            await result.current.loadMore();
        });

        expect(listChannelMediaPage).toHaveBeenLastCalledWith(
            10,
            expect.objectContaining({ offset: 4 })
        );
    });

    it("does not take the cursor below zero", async () => {
        // A rename on the very first row of a channel small enough that nothing was paged. There is
        // no position to give back, and a negative offset would be rejected by the backend (which
        // floors it) after being a nonsense request.
        vi.mocked(listChannelMediaPage).mockResolvedValueOnce(page([], 0));

        const { result } = renderHook(() =>
            useChannelMediaList({ selectedChannelId: 10, onError })
        );

        await act(async () => {
            await result.current.applyQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        act(() => {
            result.current.handleItemReordered();
        });

        // Nothing to load, so nothing is asked for: the cursor is 0 and the total is 0.
        expect(result.current.hasMore).toBe(false);

        await act(async () => {
            await result.current.loadMore();
        });

        expect(listChannelMediaPage).toHaveBeenCalledTimes(1);
    });

    it("stops offering more once every row has been handed out", async () => {
        // hasMore reads the cursor rather than the list length, so a list left shorter than the
        // cursor by deduplication must not keep the grid asking for a page that has nothing left.
        vi.mocked(listChannelMediaPage)
            .mockResolvedValueOnce(
                page([createMediaRow({ id: 1 }), createMediaRow({ id: 2 })], 3)
            )
            .mockResolvedValueOnce(page([createMediaRow({ id: 2 })], 3));

        const { result } = renderHook(() =>
            useChannelMediaList({ selectedChannelId: 10, onError })
        );

        await act(async () => {
            await result.current.applyQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        expect(result.current.hasMore).toBe(true);

        await act(async () => {
            await result.current.loadMore();
        });

        // Two rows on screen against a total of three, and still no more to ask for: the third was
        // handed out and dropped as a duplicate. Reading the length here would loop.
        expect(result.current.mediaItems).toHaveLength(2);
        expect(result.current.hasMore).toBe(false);
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
