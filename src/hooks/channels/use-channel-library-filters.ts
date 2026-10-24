import { useEffect, useMemo, useState } from "react";
import { useDebouncedValue } from "@mantine/hooks";
import {
    buildMediaQueryFilters,
    type MediaQueryFilters,
    type MediaTypeFilter,
    type PublicationDateFilter,
    type SortCategory,
    type SortDirection,
    type WatchedFilter,
} from "../../utils/media-library-filters";

// Debounce the search before it drives the (O(n log n) filter+sort) query, so typing in a large
// library does not re-query on every keystroke. The input itself stays controlled and responsive.
const LIBRARY_SEARCH_DEBOUNCE_MS = 200;

type UseChannelLibraryFiltersOptions = {
    // A Diagnostics jump names one specific media. When it changes, the active filters are cleared
    // so the target is guaranteed to be in the result set (see the effect below).
    focusMediaId: number | null;
    // Pushes the built filters to the backend, which returns the matching page (and total). A
    // returned promise settles once the list holds that page, which is what `isQuerySettled` waits for.
    onApplyQuery: (filters: MediaQueryFilters) => void | Promise<void>;
};

type UseChannelLibraryFilters = {
    searchValue: string;
    setSearchValue: React.Dispatch<React.SetStateAction<string>>;
    mediaTypeFilter: MediaTypeFilter;
    setMediaTypeFilter: React.Dispatch<React.SetStateAction<MediaTypeFilter>>;
    watchedFilter: WatchedFilter;
    setWatchedFilter: React.Dispatch<React.SetStateAction<WatchedFilter>>;
    publicationDateFilter: PublicationDateFilter;
    setPublicationDateFilter: React.Dispatch<React.SetStateAction<PublicationDateFilter>>;
    sortCategory: SortCategory;
    setSortCategory: React.Dispatch<React.SetStateAction<SortCategory>>;
    sortDirection: SortDirection;
    setSortDirection: React.Dispatch<React.SetStateAction<SortDirection>>;
    // The loaded list answers the selections on screen. False while a typed search waits out its
    // debounce, while a Diagnostics jump is about to clear the filters, and until the query for the
    // current selections has finished loading.
    isQuerySettled: boolean;
};

// Owns the filter/sort/search selections for a channel's library view and pushes the resulting
// backend query whenever they change. Extracted from SelectedChannelLibrarySection so that
// component stays presentational, matching how MediaPlayerView delegates each concern to a
// dedicated hook (the codebase's per-concern hook convention).
export function useChannelLibraryFilters({
    focusMediaId,
    onApplyQuery,
}: UseChannelLibraryFiltersOptions): UseChannelLibraryFilters {
    const [searchValue, setSearchValue] = useState("");
    const [debouncedSearchValue] = useDebouncedValue(searchValue, LIBRARY_SEARCH_DEBOUNCE_MS);
    const [mediaTypeFilter, setMediaTypeFilter] = useState<MediaTypeFilter>("all");
    const [watchedFilter, setWatchedFilter] = useState<WatchedFilter>("all");
    const [publicationDateFilter, setPublicationDateFilter] =
        useState<PublicationDateFilter>("all");
    const [sortCategory, setSortCategory] = useState<SortCategory>("publication_date");
    const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

    // The filter/sort/search selections are pushed to the backend, which returns the matching page
    // (and total). Debounced search keeps typing from firing a query per keystroke.
    const queryFilters = useMemo<MediaQueryFilters>(
        () =>
            buildMediaQueryFilters({
                searchValue: debouncedSearchValue,
                mediaTypeFilter,
                watchedFilter,
                publicationDateFilter,
                sortCategory,
                sortDirection,
            }),
        [
            debouncedSearchValue,
            mediaTypeFilter,
            watchedFilter,
            publicationDateFilter,
            sortCategory,
            sortDirection,
        ]
    );

    // A Diagnostics jump names one specific media, but these selections are local state and the
    // section is only remounted when the *channel* changes. Jumping to a media in the already
    // selected channel while a filter excluded it left the grid paging to the end of the list and
    // giving up silently. No scroll, no highlight, no message. Clear the selections so the target
    // is in the result set. Sort is left alone. Ordering cannot exclude a row.
    useEffect(() => {
        if (focusMediaId === null) {
            return;
        }

        setSearchValue("");
        setMediaTypeFilter("all");
        setWatchedFilter("all");
        setPublicationDateFilter("all");
    }, [focusMediaId]);

    // Load the first page whenever the query changes (and once on mount). The section is remounted
    // per channel, so mounting with the default filters loads the newly selected channel's first
    // page.
    //
    // The query is recorded as settled once its load finishes. A Diagnostics jump has to wait for
    // that before it can conclude the target is not there. The section is remounted on a channel
    // switch, and the grid's effects run before this one, so without it the jump looked at an empty
    // list (or the previous channel's) and gave up before the target channel had loaded.
    const [settledFilters, setSettledFilters] = useState<MediaQueryFilters | null>(null);

    useEffect(() => {
        let current = true;

        void Promise.resolve(onApplyQuery(queryFilters)).finally(() => {
            if (current) {
                setSettledFilters(queryFilters);
            }
        });

        return () => {
            current = false;
        };
    }, [onApplyQuery, queryFilters]);

    const isFocusResetPending =
        focusMediaId !== null &&
        (searchValue !== "" ||
            mediaTypeFilter !== "all" ||
            watchedFilter !== "all" ||
            publicationDateFilter !== "all");

    const isQuerySettled =
        settledFilters === queryFilters &&
        searchValue === debouncedSearchValue &&
        !isFocusResetPending;

    return {
        searchValue,
        setSearchValue,
        mediaTypeFilter,
        setMediaTypeFilter,
        watchedFilter,
        setWatchedFilter,
        publicationDateFilter,
        setPublicationDateFilter,
        sortCategory,
        setSortCategory,
        sortDirection,
        setSortDirection,
        isQuerySettled,
    };
}
