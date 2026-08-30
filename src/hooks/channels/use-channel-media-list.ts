import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaRow } from "../../types/media";
import { listChannelMediaPage } from "../../services/media-service";
import {
    isUnfilteredMediaQuery,
    type MediaQueryFilters,
} from "../../utils/media-library-filters";
import { resolveErrorMessage } from "../../utils/error-message";
import { logError } from "../../utils/app-logger";
import { useRequestGuard } from "../use-request-guard";
import { useMemoObject } from "../use-memo-object";

// One page of media requested at a time. The backend clamps to its own max; this is the browse
// chunk the grid appends as the user scrolls.
//
// Kept in step with `shared/media-page-size.json`, which the display-thumbnail command sizes its
// per-call budgets from (MAX_GENERATIONS_PER_CALL / MAX_RESOLVED_PER_CALL in
// src-tauri/src/services/thumbnail/display.rs). Both sides assert against that file, so raising this
// without raising the budget (which is how a budget of 64 ended up serving a page of 100, leaving
// 36 cards of a first-visited channel without a derivative), fails a test on each side.
const MEDIA_PAGE_SIZE = 100;

type UseChannelMediaListOptions = {
    selectedChannelId: number | null;
    onError: (message: string) => void;
};

type UseChannelMediaListReturn = {
    mediaItems: MediaRow[];
    // Rows matching the current filters across the whole channel, not just the loaded pages.
    total: number;
    // Rows in the channel with no filter applied (for the "N items" header). Captured whenever a
    // load runs unfiltered, which (because filters reset per channel) is always the first load.
    channelTotal: number;
    hasMore: boolean;
    isLoadingMedia: boolean;
    isLoadingMore: boolean;
    setMediaItems: React.Dispatch<React.SetStateAction<MediaRow[]>>;
    // Loads the first page for the current channel with the given filters (replacing the list).
    applyQuery: (filters: MediaQueryFilters) => Promise<void>;
    // Appends the next page for the current channel/filters.
    loadMore: () => Promise<void>;
    // Re-fetches the first page with the filters last applied (used after adding media).
    reloadMedia: () => Promise<void>;
    // Adjusts the totals after `count` rows are removed in memory (a delete), so "X of Y" stays
    // correct without a full refetch.
    handleItemsRemoved: (count: number) => void;
    // Gives the pagination cursor a position back after an in-place edit moved a loaded row within
    // the backend's sort (a rename), so the row it displaced past the window is not skipped.
    handleItemReordered: () => void;
    clearMedia: () => void;
};

export function useChannelMediaList({
    selectedChannelId,
    onError,
}: UseChannelMediaListOptions): UseChannelMediaListReturn {
    const [mediaItems, setMediaItems] = useState<MediaRow[]>([]);
    const [total, setTotal] = useState(0);
    const [channelTotal, setChannelTotal] = useState(0);
    const [isLoadingMedia, setIsLoadingMedia] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    // The render-visible half of the pagination cursor (see `loadedCountRef` below); `hasMore`
    // reads it. State as well as a ref because the ref is what `loadMore` reads without becoming a
    // dependency, and this is what a render has to see.
    const [loadedCount, setLoadedCount] = useState(0);

    const requestGuard = useRequestGuard();
    const filtersRef = useRef<MediaQueryFilters | null>(null);
    const loadedChannelIdRef = useRef<number | null>(null);
    const lastRequestIdRef = useRef(0);
    const loadingMoreRef = useRef(false);

    // How many rows the backend has handed out for the current query. This is the pagination
    // cursor, and it is deliberately *not* `mediaItems.length`.
    //
    // The two were the same value until an append could drop a row. `list_media_page` windows with
    // OFFSET, so the offset means "skip this many rows of the current sort", and every ORDER BY in
    // `resolve_order_by` tie-breaks on `title_normalized`, so renaming a media moves it within any
    // sort category, not only the title one. `editTitle` updates the row in place without reloading
    // (correctly. A rename should not throw away the pages the user scrolled), so the loaded list
    // and the backend's sorted set can disagree about which rows come first, and the next page can
    // repeat a row already on screen.
    //
    // Deduplicating the append is what fixes the repeat, and taking the cursor from the list length
    // is what would then break. A page whose rows were all dropped as duplicates would leave the
    // length unchanged, so the next `loadMore` would request the same offset again, forever, on
    // every scroll to the bottom. Counting what the backend *returned* keeps the cursor advancing
    // whatever the append decides to keep.
    //
    // The other half of the same shift (a row moving from *after* the window to before it, and
    // being skipped) is closed by `handleItemReordered` below rather than by keyset pagination,
    // which the mixed-direction clauses cannot express as a single row-value comparison anyway
    // (`publication_date` sorts its group key ASC and its date DESC).
    const selectedChannelIdRef = useRef(selectedChannelId);
    const loadedCountRef = useRef(0);
    const totalRef = useRef(0);

    // Track the selected channel synchronously during render, not in an effect. On a channel
    // switch the library section is remounted, and a child's mount effect (its applyQuery call)
    // runs before this hook's own effects flush, so an effect-updated ref would still hold the
    // previous channel and load the wrong channel's first page. Writing it during render keeps it
    // current for any effect that fires afterwards.
    selectedChannelIdRef.current = selectedChannelId;

    useEffect(() => {
        totalRef.current = total;
    }, [total]);

    // Derived from the rows handed out rather than from the rows kept, for the reason above. A
    // deduplicated append leaves the list shorter than the cursor, and reading `mediaItems.length`
    // here would leave "load more" enabled against an offset that has nothing left to give.
    const hasMore = loadedCount < total;

    // The cursor and its rendered copy always move together, so they are set through one helper
    // rather than at seven call sites. A ref left behind by a `setLoadedCount` that forgot it is a
    // pagination that silently requests the wrong offset, which is the failure this whole cursor
    // exists to remove.
    const setLoadedRows = useCallback((count: number): void => {
        loadedCountRef.current = count;
        setLoadedCount(count);
    }, []);

    const clearMedia = useCallback((): void => {
        requestGuard.invalidate();
        loadedChannelIdRef.current = null;
        loadingMoreRef.current = false;
        setIsLoadingMedia(false);
        setIsLoadingMore(false);
        setMediaItems([]);
        setTotal(0);
        setChannelTotal(0);
        setLoadedRows(0);
    }, [requestGuard, setLoadedRows]);

    const applyQuery = useCallback(
        async (filters: MediaQueryFilters): Promise<void> => {
            const channelId = selectedChannelIdRef.current;

            if (channelId === null || channelId === undefined) {
                clearMedia();
                return;
            }

            filtersRef.current = filters;
            const requestId = requestGuard.begin();
            lastRequestIdRef.current = requestId;
            setIsLoadingMedia(true);

            // Switching channels. Drop the previous channel's page (and its counts) so they do not
            // flash before the new load resolves. A filter change on the same channel keeps the
            // current rows visible under the loading state.
            if (loadedChannelIdRef.current !== channelId) {
                setMediaItems([]);
                setTotal(0);
                setChannelTotal(0);
                setLoadedRows(0);
            }

            try {
                const page = await listChannelMediaPage(channelId, {
                    ...filters,
                    limit: MEDIA_PAGE_SIZE,
                    offset: 0,
                });

                if (!requestGuard.isCurrent(requestId)) {
                    return;
                }

                loadedChannelIdRef.current = channelId;
                setMediaItems(page.items);
                setTotal(page.total);
                // A first page replaces the list, so the cursor restarts at what this page returned
                // rather than accumulating.
                setLoadedRows(page.items.length);

                if (isUnfilteredMediaQuery(filters)) {
                    setChannelTotal(page.total);
                }
            } catch (error) {
                if (!requestGuard.isCurrent(requestId)) {
                    return;
                }

                setMediaItems([]);
                setTotal(0);
                logError("media-list", "Failed to load channel media.", error, { channelId });
                onError(resolveErrorMessage(error, "Failed to load channel media."));
            } finally {
                if (requestGuard.isCurrent(requestId)) {
                    setIsLoadingMedia(false);
                }
            }
        },
        [clearMedia, onError, requestGuard, setLoadedRows]
    );

    const loadMore = useCallback(async (): Promise<void> => {
        const channelId = selectedChannelIdRef.current;
        const filters = filtersRef.current;

        if (channelId === null || channelId === undefined || filters === null) {
            return;
        }

        if (loadingMoreRef.current) {
            return;
        }

        const offset = loadedCountRef.current;

        if (offset >= totalRef.current) {
            return;
        }

        // Tie this append to the load that produced the current list. If a newer applyQuery
        // (a filter change or channel switch) began meanwhile, its id becomes current and this
        // stale append is dropped instead of corrupting the new list.
        const requestId = lastRequestIdRef.current;
        loadingMoreRef.current = true;
        setIsLoadingMore(true);

        try {
            const page = await listChannelMediaPage(channelId, {
                ...filters,
                limit: MEDIA_PAGE_SIZE,
                offset,
            });

            if (!requestGuard.isCurrent(requestId)) {
                return;
            }

            // The cursor advances by what the backend returned, before the append decides what to
            // keep. See `loadedCountRef`. Doing it the other way round makes a page whose rows were
            // all dropped as duplicates re-request the same offset on every scroll.
            setLoadedRows(offset + page.items.length);

            // Append only the rows this list does not already hold. A row can arrive twice when the
            // sort key of an already-loaded row changed under the window (a rename moves a media in
            // every sort category, since they all tie-break on the title), and the grid keys by id.
            // so a repeat is a duplicate React key and a card shown twice, not a cosmetic blemish.
            setMediaItems((current) => {
                const loadedIds = new Set(current.map((item) => item.id));
                const fresh = page.items.filter((item) => !loadedIds.has(item.id));

                return fresh.length > 0 ? [...current, ...fresh] : current;
            });
            setTotal(page.total);
        } catch (error) {
            if (!requestGuard.isCurrent(requestId)) {
                return;
            }

            logError("media-list", "Failed to load more channel media.", error, { channelId });
            onError(resolveErrorMessage(error, "Failed to load more media."));
        } finally {
            loadingMoreRef.current = false;
            setIsLoadingMore(false);
        }
    }, [onError, requestGuard, setLoadedRows]);

    const reloadMedia = useCallback(async (): Promise<void> => {
        const filters = filtersRef.current;

        if (filters === null) {
            return;
        }

        await applyQuery(filters);
    }, [applyQuery]);

    const handleItemsRemoved = useCallback(
        (count: number): void => {
            if (count <= 0) {
                return;
            }

            setTotal((current) => Math.max(0, current - count));
            setChannelTotal((current) => Math.max(0, current - count));
            // The cursor moves with them. A deleted row leaves the backend's sorted set and the
            // loaded prefix at the same time, so the offset stays aligned only if it shrinks too;
            // leaving it would skip one row of the next page for every media deleted.
            setLoadedRows(Math.max(0, loadedCountRef.current - count));
        },
        [setLoadedRows]
    );

    // Pulls the pagination cursor back by one after an in-place edit changed a loaded row's sort
    // key, so the row that edit displaced across the window boundary is fetched instead of skipped.
    //
    // The arithmetic is exact rather than defensive, which is why one is the right number. The
    // renamed row sits at some position P inside the loaded window. If its new position Q is still
    // inside, nothing crossed the boundary. If Q is at or past the cursor, every row between them
    // shifts down by one, so the row that was first on the *next* page moves onto the last slot of
    // this one. A row this list does not hold, at an offset `loadMore` has already passed. Exactly
    // one row moves that way per edit, so exactly one position has to be given back.
    //
    // What makes this cheap is that the correction costs nothing when it was not needed. Refetching
    // one position earlier either returns the displaced row (kept) or a row already loaded (dropped
    // by the append's own dedup), and the cursor advances by what the backend returned either way,
    // so it cannot stall. That is the same machinery the dedup already rests on, used from the other
    // end, and it is why this is a subtraction here rather than keyset pagination, or a refetch of
    // the whole scrolled window, which would throw away the pages a rename should not cost.
    //
    // Deliberately also allowed to raise `hasMore` from false. A channel whose last page held the
    // displaced row has no later append to correct itself, which is precisely the case that would
    // otherwise stay wrong for the rest of the session. The extra request that follows is one row.
    const handleItemReordered = useCallback((): void => {
        setLoadedRows(Math.max(0, loadedCountRef.current - 1));
    }, [setLoadedRows]);

    // Clear when no channel is selected; the section (which drives applyQuery) is unmounted then.
    useEffect(() => {
        if (selectedChannelId === null) {
            clearMedia();
        }
    }, [selectedChannelId, clearMedia]);

    return useMemoObject({
        mediaItems,
        total,
        channelTotal,
        hasMore,
        isLoadingMedia,
        isLoadingMore,
        setMediaItems,
        applyQuery,
        loadMore,
        reloadMedia,
        handleItemsRemoved,
        handleItemReordered,
        clearMedia,
    });
}
