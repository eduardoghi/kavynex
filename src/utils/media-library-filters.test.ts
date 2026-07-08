import { describe, expect, it } from "vitest";
import {
    filterAndSortMedia,
    type MediaLibraryFilters,
} from "./media-library-filters";
import type { MediaRow } from "../types/media";

function media(overrides: Partial<MediaRow> = {}): MediaRow {
    return {
        id: 1,
        channel_id: 1,
        title: "Item",
        file_path: "video/item.mp4",
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
        created_at: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

const baseFilters: MediaLibraryFilters = {
    searchValue: "",
    mediaTypeFilter: "all",
    watchedFilter: "all",
    publicationDateFilter: "all",
    sortCategory: "title",
    sortDirection: "asc",
};

function titles(items: MediaRow[]): string[] {
    return items.map((item) => item.title);
}

describe("filterAndSortMedia", () => {
    it("does not mutate the input array", () => {
        const items = [media({ id: 1, title: "B" }), media({ id: 2, title: "A" })];
        const snapshot = [...items];

        filterAndSortMedia(items, baseFilters);

        expect(items).toEqual(snapshot);
    });

    it("filters by media type", () => {
        const items = [
            media({ id: 1, title: "vid", media_type: "video" }),
            media({ id: 2, title: "aud", media_type: "audio" }),
        ];

        expect(titles(filterAndSortMedia(items, { ...baseFilters, mediaTypeFilter: "audio" }))).toEqual(
            ["aud"]
        );
    });

    it("filters by watched status", () => {
        const items = [
            media({ id: 1, title: "seen", watched_at: "2026-02-01T00:00:00.000Z" }),
            media({ id: 2, title: "new", watched_at: null }),
        ];

        expect(titles(filterAndSortMedia(items, { ...baseFilters, watchedFilter: "watched" }))).toEqual(
            ["seen"]
        );
        expect(
            titles(filterAndSortMedia(items, { ...baseFilters, watchedFilter: "unwatched" }))
        ).toEqual(["new"]);
    });

    it("filters by publication date availability", () => {
        const items = [
            media({ id: 1, title: "with", published_at: "2026-01-01" }),
            media({ id: 2, title: "without", published_at: null }),
        ];

        expect(
            titles(filterAndSortMedia(items, { ...baseFilters, publicationDateFilter: "with" }))
        ).toEqual(["with"]);
        expect(
            titles(filterAndSortMedia(items, { ...baseFilters, publicationDateFilter: "without" }))
        ).toEqual(["without"]);
    });

    it("searches by title, accent- and case-insensitively", () => {
        const items = [
            media({ id: 1, title: "Café com leite" }),
            media({ id: 2, title: "Water" }),
        ];

        expect(titles(filterAndSortMedia(items, { ...baseFilters, searchValue: "cafe" }))).toEqual([
            "Café com leite",
        ]);
    });

    it("sorts by title respecting direction", () => {
        const items = [media({ id: 1, title: "B" }), media({ id: 2, title: "A" })];

        expect(titles(filterAndSortMedia(items, { ...baseFilters, sortDirection: "asc" }))).toEqual([
            "A",
            "B",
        ]);
        expect(titles(filterAndSortMedia(items, { ...baseFilters, sortDirection: "desc" }))).toEqual([
            "B",
            "A",
        ]);
    });

    it("sorts undated media last when sorting by publication date, regardless of direction", () => {
        const items = [
            media({ id: 1, title: "no date", published_at: null }),
            media({ id: 2, title: "old", published_at: "2024-01-01" }),
            media({ id: 3, title: "new", published_at: "2026-01-01" }),
        ];

        expect(
            titles(
                filterAndSortMedia(items, {
                    ...baseFilters,
                    sortCategory: "publication_date",
                    sortDirection: "desc",
                })
            )
        ).toEqual(["new", "old", "no date"]);
    });

    it("sorts by duration ascending with a title tie-breaker", () => {
        const items = [
            media({ id: 1, title: "B", duration_seconds: 100 }),
            media({ id: 2, title: "A", duration_seconds: 100 }),
            media({ id: 3, title: "C", duration_seconds: 50 }),
        ];

        // Shortest first; the two equal-duration items fall back to a title comparison.
        expect(
            titles(
                filterAndSortMedia(items, {
                    ...baseFilters,
                    sortCategory: "duration",
                    sortDirection: "asc",
                })
            )
        ).toEqual(["C", "A", "B"]);
    });

    it("sorts by comments count", () => {
        const items = [
            media({ id: 1, title: "few", comments_count: 1 }),
            media({ id: 2, title: "many", comments_count: 50 }),
        ];

        expect(
            titles(
                filterAndSortMedia(items, {
                    ...baseFilters,
                    sortCategory: "comments",
                    sortDirection: "desc",
                })
            )
        ).toEqual(["many", "few"]);
    });
});
