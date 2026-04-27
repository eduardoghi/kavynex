import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useHomeLibraryPanel } from "./use-home-library-panel";

describe("useHomeLibraryPanel", () => {
    it("shows selected channel panel in library mode", () => {
        const { result } = renderHook(() =>
            useHomeLibraryPanel({
                selectedChannel: {
                    id: 1,
                    name: "Canal A",
                    youtube_handle: "@canala",
                    avatar_path: null,
                    created_at: "2026-03-31T10:00:00.000Z",
                },
                mediaItems: [],
                viewMode: "library",
                isLoadingMedia: false,
                isAddingMedia: false,
                isMigratingLibraryPath: false,
                libraryPath: "/library",
            })
        );

        expect(result.current.showSelectedChannelPanel).toBe(true);
        expect(result.current.itemCountLabel).toBe("0 item(s)");
        expect(result.current.disableAddMedia).toBe(false);
    });

    it("hides panel when there is no selected channel", () => {
        const { result } = renderHook(() =>
            useHomeLibraryPanel({
                selectedChannel: null,
                mediaItems: [],
                viewMode: "library",
                isLoadingMedia: false,
                isAddingMedia: false,
                isMigratingLibraryPath: false,
                libraryPath: "/library",
            })
        );

        expect(result.current.showSelectedChannelPanel).toBe(false);
    });

    it("disables add media while loading", () => {
        const { result } = renderHook(() =>
            useHomeLibraryPanel({
                selectedChannel: {
                    id: 1,
                    name: "Canal A",
                    youtube_handle: "@canala",
                    avatar_path: null,
                    created_at: "2026-03-31T10:00:00.000Z",
                },
                mediaItems: [],
                viewMode: "library",
                isLoadingMedia: true,
                isAddingMedia: false,
                isMigratingLibraryPath: false,
                libraryPath: "/library",
            })
        );

        expect(result.current.disableAddMedia).toBe(true);
    });

    it("disables add media outside library mode", () => {
        const { result } = renderHook(() =>
            useHomeLibraryPanel({
                selectedChannel: {
                    id: 1,
                    name: "Canal A",
                    youtube_handle: "@canala",
                    avatar_path: null,
                    created_at: "2026-03-31T10:00:00.000Z",
                },
                mediaItems: [],
                viewMode: "player",
                isLoadingMedia: false,
                isAddingMedia: false,
                isMigratingLibraryPath: false,
                libraryPath: "/library",
            })
        );

        expect(result.current.disableAddMedia).toBe(true);
    });

    it("disables add media while adding a new item", () => {
        const { result } = renderHook(() =>
            useHomeLibraryPanel({
                selectedChannel: {
                    id: 1,
                    name: "Canal A",
                    youtube_handle: "@canala",
                    avatar_path: null,
                    created_at: "2026-03-31T10:00:00.000Z",
                },
                mediaItems: [],
                viewMode: "library",
                isLoadingMedia: false,
                isAddingMedia: true,
                isMigratingLibraryPath: false,
                libraryPath: "/library",
            })
        );

        expect(result.current.disableAddMedia).toBe(true);
    });

    it("disables add media while library path migration is running", () => {
        const { result } = renderHook(() =>
            useHomeLibraryPanel({
                selectedChannel: {
                    id: 1,
                    name: "Canal A",
                    youtube_handle: "@canala",
                    avatar_path: null,
                    created_at: "2026-03-31T10:00:00.000Z",
                },
                mediaItems: [],
                viewMode: "library",
                isLoadingMedia: false,
                isAddingMedia: false,
                isMigratingLibraryPath: true,
                libraryPath: "/library",
            })
        );

        expect(result.current.disableAddMedia).toBe(true);
    });

    it("disables add media when library path is empty", () => {
        const { result } = renderHook(() =>
            useHomeLibraryPanel({
                selectedChannel: {
                    id: 1,
                    name: "Canal A",
                    youtube_handle: "@canala",
                    avatar_path: null,
                    created_at: "2026-03-31T10:00:00.000Z",
                },
                mediaItems: [],
                viewMode: "library",
                isLoadingMedia: false,
                isAddingMedia: false,
                isMigratingLibraryPath: false,
                libraryPath: "   ",
            })
        );

        expect(result.current.disableAddMedia).toBe(true);
    });
});