import type { MediaRow } from "../types/media";

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
