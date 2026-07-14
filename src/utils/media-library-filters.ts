import type { MediaPageQuery } from "../types/generated/MediaPageQuery";

export type MediaTypeFilter = "all" | "video" | "audio";
export type WatchedFilter = "all" | "watched" | "unwatched";
export type PublicationDateFilter = "all" | "with" | "without";
export type SortCategory =
    | "publication_date"
    | "added_date"
    | "title"
    | "duration"
    | "comments";
export type SortDirection = "desc" | "asc";

export type MediaLibraryFilters = {
    searchValue: string;
    mediaTypeFilter: MediaTypeFilter;
    watchedFilter: WatchedFilter;
    publicationDateFilter: PublicationDateFilter;
    sortCategory: SortCategory;
    sortDirection: SortDirection;
};

// The filter/sort part of a backend media page request (the page window - limit/offset - is
// owned by the pager, not the filter UI). Mapping the UI's MediaLibraryFilters to the generated
// MediaPageQuery keeps the union types checked against the Rust side. Filtering and sorting are
// done server-side (see src-tauri video_repository::list_media_page), so there is no client-side
// filter/sort function here anymore.
export type MediaQueryFilters = Omit<MediaPageQuery, "limit" | "offset">;

// Maps the UI filter state to the backend query shape. The unions line up field-for-field with
// the generated MediaPageQuery, so a drift in either side fails the type-check.
export function buildMediaQueryFilters(filters: MediaLibraryFilters): MediaQueryFilters {
    return {
        mediaType: filters.mediaTypeFilter,
        watched: filters.watchedFilter,
        publication: filters.publicationDateFilter,
        search: filters.searchValue,
        sortCategory: filters.sortCategory,
        sortDirection: filters.sortDirection,
    };
}

// True when no narrowing filter or search is active (sort is irrelevant to the match count), so
// the paged total equals the channel's full media count and can be cached as such.
export function isUnfilteredMediaQuery(filters: MediaQueryFilters): boolean {
    return (
        filters.mediaType === "all" &&
        filters.watched === "all" &&
        filters.publication === "all" &&
        filters.search.trim() === ""
    );
}

export const DEFAULT_MEDIA_QUERY_FILTERS: MediaQueryFilters = {
    mediaType: "all",
    watched: "all",
    publication: "all",
    search: "",
    sortCategory: "publication_date",
    sortDirection: "desc",
};
