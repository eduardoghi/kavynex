import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaRow } from "../types/media";
import { listChannelMediaPage } from "../services";
import {
    isUnfilteredMediaQuery,
    type MediaQueryFilters,
} from "../utils/media-library-filters";
import { resolveErrorMessage } from "../utils/error-message";
import { logError } from "../utils/app-logger";
import { useRequestGuard } from "./use-request-guard";
import { useMemoObject } from "./use-memo-object";

// One page of media requested at a time. The backend clamps to its own max; this is the browse
// chunk the grid appends as the user scrolls.
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
    // load runs unfiltered, which - because filters reset per channel - is always the first load.
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

    const requestGuard = useRequestGuard();
    const filtersRef = useRef<MediaQueryFilters | null>(null);
    const loadedChannelIdRef = useRef<number | null>(null);
    const lastRequestIdRef = useRef(0);
    const loadingMoreRef = useRef(false);

    // Mirror list length and total in refs so loadMore can compute the next offset and decide
    // whether more remain without listing mediaItems/total as dependencies (which would recreate
    // the callback - and defeat the MediaCard memoization - on every page append).
    const selectedChannelIdRef = useRef(selectedChannelId);
    const mediaItemsLengthRef = useRef(0);
    const totalRef = useRef(0);

    useEffect(() => {
        selectedChannelIdRef.current = selectedChannelId;
    }, [selectedChannelId]);

    useEffect(() => {
        mediaItemsLengthRef.current = mediaItems.length;
    }, [mediaItems.length]);

    useEffect(() => {
        totalRef.current = total;
    }, [total]);

    const hasMore = mediaItems.length < total;

    const clearMedia = useCallback((): void => {
        requestGuard.invalidate();
        loadedChannelIdRef.current = null;
        loadingMoreRef.current = false;
        setIsLoadingMedia(false);
        setIsLoadingMore(false);
        setMediaItems([]);
        setTotal(0);
        setChannelTotal(0);
    }, [requestGuard]);

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

            // Switching channels: drop the previous channel's page (and its counts) so they do not
            // flash before the new load resolves. A filter change on the same channel keeps the
            // current rows visible under the loading state.
            if (loadedChannelIdRef.current !== channelId) {
                setMediaItems([]);
                setTotal(0);
                setChannelTotal(0);
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
        [clearMedia, onError, requestGuard]
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

        const offset = mediaItemsLengthRef.current;

        if (offset >= totalRef.current) {
            return;
        }

        // Tie this append to the load that produced the current list: if a newer applyQuery
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

            setMediaItems((current) => [...current, ...page.items]);
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
    }, [onError, requestGuard]);

    const reloadMedia = useCallback(async (): Promise<void> => {
        const filters = filtersRef.current;

        if (filters === null) {
            return;
        }

        await applyQuery(filters);
    }, [applyQuery]);

    const handleItemsRemoved = useCallback((count: number): void => {
        if (count <= 0) {
            return;
        }

        setTotal((current) => Math.max(0, current - count));
        setChannelTotal((current) => Math.max(0, current - count));
    }, []);

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
        clearMedia,
    });
}
