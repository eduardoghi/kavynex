import { describe, expect, it } from "vitest";
import {
    buildMediaQueryFilters,
    isUnfilteredMediaQuery,
    DEFAULT_MEDIA_QUERY_FILTERS,
    type MediaLibraryFilters,
} from "./media-library-filters";

function uiFilters(overrides: Partial<MediaLibraryFilters> = {}): MediaLibraryFilters {
    return {
        searchValue: "",
        mediaTypeFilter: "all",
        watchedFilter: "all",
        publicationDateFilter: "all",
        sortCategory: "publication_date",
        sortDirection: "desc",
        ...overrides,
    };
}

describe("buildMediaQueryFilters", () => {
    it("maps the UI filter fields onto the backend query shape", () => {
        const query = buildMediaQueryFilters(
            uiFilters({
                searchValue: "hello",
                mediaTypeFilter: "audio",
                watchedFilter: "watched",
                publicationDateFilter: "without",
                sortCategory: "title",
                sortDirection: "asc",
            })
        );

        expect(query).toEqual({
            search: "hello",
            mediaType: "audio",
            watched: "watched",
            publication: "without",
            sortCategory: "title",
            sortDirection: "asc",
        });
    });

    it("does not carry the pager-owned limit/offset", () => {
        const query = buildMediaQueryFilters(uiFilters());
        expect(query).not.toHaveProperty("limit");
        expect(query).not.toHaveProperty("offset");
    });
});

describe("isUnfilteredMediaQuery", () => {
    it("is true for the default filters (sort does not narrow)", () => {
        expect(isUnfilteredMediaQuery(DEFAULT_MEDIA_QUERY_FILTERS)).toBe(true);
        expect(
            isUnfilteredMediaQuery({
                ...DEFAULT_MEDIA_QUERY_FILTERS,
                sortCategory: "title",
                sortDirection: "asc",
            })
        ).toBe(true);
    });

    it("treats a whitespace-only search as unfiltered", () => {
        expect(
            isUnfilteredMediaQuery({ ...DEFAULT_MEDIA_QUERY_FILTERS, search: "   " })
        ).toBe(true);
    });

    it("is false when any narrowing filter or search is active", () => {
        expect(
            isUnfilteredMediaQuery({ ...DEFAULT_MEDIA_QUERY_FILTERS, mediaType: "video" })
        ).toBe(false);
        expect(
            isUnfilteredMediaQuery({ ...DEFAULT_MEDIA_QUERY_FILTERS, watched: "unwatched" })
        ).toBe(false);
        expect(
            isUnfilteredMediaQuery({ ...DEFAULT_MEDIA_QUERY_FILTERS, publication: "with" })
        ).toBe(false);
        expect(
            isUnfilteredMediaQuery({ ...DEFAULT_MEDIA_QUERY_FILTERS, search: "x" })
        ).toBe(false);
    });
});
