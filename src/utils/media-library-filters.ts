import type { MediaRow } from "../types/media";
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
// MediaPageQuery keeps the union types checked against the Rust side.
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

function normalizeText(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLocaleLowerCase("en-US");
}

function parseDateValue(value: string | null | undefined): number {
    const normalized = value?.trim() ?? "";

    if (!normalized) {
        return 0;
    }

    const parsed = Date.parse(normalized.replace(" ", "T"));
    return Number.isFinite(parsed) ? parsed : 0;
}

function getCommentsCount(media: MediaRow): number {
    return Math.max(0, media.comments_count ?? 0);
}

function getDuration(media: MediaRow): number {
    return Math.max(0, media.duration_seconds ?? 0);
}

function getAddedDateValue(media: MediaRow): number {
    return parseDateValue(media.created_at);
}

function getPublicationDateValue(media: MediaRow): number {
    return parseDateValue(media.published_at);
}

function compareText(left: string, right: string): number {
    return left.localeCompare(right, undefined, {
        sensitivity: "base",
        numeric: true,
    });
}

function comparePublicationDate(
    left: MediaRow,
    right: MediaRow,
    sortDirection: SortDirection
): number {
    const leftDate = getPublicationDateValue(left);
    const rightDate = getPublicationDateValue(right);
    const leftHasDate = leftDate > 0;
    const rightHasDate = rightDate > 0;

    if (leftHasDate && !rightHasDate) {
        return -1;
    }

    if (!leftHasDate && rightHasDate) {
        return 1;
    }

    if (!leftHasDate && !rightHasDate) {
        return compareText(left.title, right.title);
    }

    const result = leftDate - rightDate;

    if (result === 0) {
        return compareText(left.title, right.title);
    }

    return sortDirection === "asc" ? result : result * -1;
}

function matchesFilters(
    media: MediaRow,
    filters: MediaLibraryFilters,
    searchTerm: string
): boolean {
    if (filters.mediaTypeFilter !== "all" && media.media_type !== filters.mediaTypeFilter) {
        return false;
    }

    const isWatched = Boolean(media.watched_at?.trim());

    if (filters.watchedFilter === "watched" && !isWatched) {
        return false;
    }

    if (filters.watchedFilter === "unwatched" && isWatched) {
        return false;
    }

    const hasPublicationDate = Boolean(media.published_at?.trim());

    if (filters.publicationDateFilter === "with" && !hasPublicationDate) {
        return false;
    }

    if (filters.publicationDateFilter === "without" && hasPublicationDate) {
        return false;
    }

    if (searchTerm && !normalizeText(media.title).includes(searchTerm)) {
        return false;
    }

    return true;
}

/**
 * Filters and sorts a channel's media by the current UI selections. Kept free of React so it
 * can be unit-tested directly. Returns a new array; the input is not mutated.
 */
export function filterAndSortMedia(
    items: MediaRow[],
    filters: MediaLibraryFilters
): MediaRow[] {
    const searchTerm = normalizeText(filters.searchValue);
    const { sortCategory, sortDirection } = filters;

    const nextItems = items.filter((media) => matchesFilters(media, filters, searchTerm));

    nextItems.sort((left, right) => {
        let result = 0;

        if (sortCategory === "publication_date") {
            return comparePublicationDate(left, right, sortDirection);
        } else if (sortCategory === "added_date") {
            result = getAddedDateValue(left) - getAddedDateValue(right);

            if (result === 0) {
                result = compareText(left.title, right.title);
            }
        } else if (sortCategory === "title") {
            result = compareText(left.title, right.title);
        } else if (sortCategory === "duration") {
            result = getDuration(left) - getDuration(right);

            if (result === 0) {
                result = compareText(left.title, right.title);
            }
        } else if (sortCategory === "comments") {
            result = getCommentsCount(left) - getCommentsCount(right);

            if (result === 0) {
                result = compareText(left.title, right.title);
            }
        }

        return sortDirection === "asc" ? result : result * -1;
    });

    return nextItems;
}
