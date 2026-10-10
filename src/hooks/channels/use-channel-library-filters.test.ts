import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChannelLibraryFilters } from "./use-channel-library-filters";

describe("useChannelLibraryFilters", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("applies the default query on mount", () => {
        const onApplyQuery = vi.fn();

        renderHook(() => useChannelLibraryFilters({ focusMediaId: null, onApplyQuery }));

        expect(onApplyQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                mediaType: "all",
                watched: "all",
                publication: "all",
                search: "",
                sortCategory: "publication_date",
                sortDirection: "desc",
            })
        );
    });

    it("re-applies the query immediately when a non-search filter changes", () => {
        const onApplyQuery = vi.fn();

        const { result } = renderHook(() =>
            useChannelLibraryFilters({ focusMediaId: null, onApplyQuery })
        );

        act(() => {
            result.current.setWatchedFilter("watched");
        });

        expect(onApplyQuery).toHaveBeenLastCalledWith(
            expect.objectContaining({ watched: "watched" })
        );
    });

    it("debounces the search term before it reaches the query", () => {
        const onApplyQuery = vi.fn();

        const { result } = renderHook(() =>
            useChannelLibraryFilters({ focusMediaId: null, onApplyQuery })
        );

        act(() => {
            result.current.setSearchValue("hello");
        });

        // Before the debounce elapses the term has not been sent.
        expect(onApplyQuery).not.toHaveBeenCalledWith(
            expect.objectContaining({ search: "hello" })
        );

        act(() => {
            vi.advanceTimersByTime(200);
        });

        expect(onApplyQuery).toHaveBeenLastCalledWith(
            expect.objectContaining({ search: "hello" })
        );
    });

    it("clears the active filters when the focus target changes so it cannot be filtered out", () => {
        const onApplyQuery = vi.fn();

        const { result, rerender } = renderHook(
            (props: { focusMediaId: number | null }) =>
                useChannelLibraryFilters({ focusMediaId: props.focusMediaId, onApplyQuery }),
            { initialProps: { focusMediaId: null as number | null } }
        );

        act(() => {
            result.current.setMediaTypeFilter("audio");
            result.current.setWatchedFilter("watched");
            result.current.setSearchValue("term");
        });

        act(() => {
            vi.advanceTimersByTime(200);
        });

        act(() => {
            rerender({ focusMediaId: 42 });
        });

        expect(result.current.mediaTypeFilter).toBe("all");
        expect(result.current.watchedFilter).toBe("all");
        expect(result.current.searchValue).toBe("");
    });

    it("leaves the sort untouched when the focus target changes (ordering cannot exclude a row)", () => {
        const onApplyQuery = vi.fn();

        const { result, rerender } = renderHook(
            (props: { focusMediaId: number | null }) =>
                useChannelLibraryFilters({ focusMediaId: props.focusMediaId, onApplyQuery }),
            { initialProps: { focusMediaId: null as number | null } }
        );

        act(() => {
            result.current.setSortCategory("title");
            result.current.setSortDirection("asc");
        });

        act(() => {
            rerender({ focusMediaId: 7 });
        });

        expect(result.current.sortCategory).toBe("title");
        expect(result.current.sortDirection).toBe("asc");
    });

    it("reports the query settled only once its load has finished", async () => {
        let finishLoad: () => void = () => {};
        const onApplyQuery = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finishLoad = resolve;
                })
        );

        const { result } = renderHook(() =>
            useChannelLibraryFilters({ focusMediaId: null, onApplyQuery })
        );

        expect(result.current.isQuerySettled).toBe(false);

        await act(async () => {
            finishLoad();
        });

        expect(result.current.isQuerySettled).toBe(true);
    });

    it("is not settled while a typed search waits out its debounce", async () => {
        const onApplyQuery = vi.fn(() => Promise.resolve());

        const { result } = renderHook(() =>
            useChannelLibraryFilters({ focusMediaId: null, onApplyQuery })
        );

        await act(async () => {});
        expect(result.current.isQuerySettled).toBe(true);

        act(() => {
            result.current.setSearchValue("term");
        });

        expect(result.current.isQuerySettled).toBe(false);
    });

    it("is not settled while a focus request still has filters to clear", async () => {
        const onApplyQuery = vi.fn(() => Promise.resolve());

        const { result, rerender } = renderHook(
            (props: { focusMediaId: number | null }) =>
                useChannelLibraryFilters({ focusMediaId: props.focusMediaId, onApplyQuery }),
            { initialProps: { focusMediaId: null as number | null } }
        );

        await act(async () => {
            result.current.setWatchedFilter("watched");
        });
        expect(result.current.isQuerySettled).toBe(true);

        await act(async () => {
            rerender({ focusMediaId: 42 });
        });

        // The filter reset has run and its query has loaded.
        expect(result.current.watchedFilter).toBe("all");
        expect(result.current.isQuerySettled).toBe(true);
    });
});
