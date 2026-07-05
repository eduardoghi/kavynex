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

    it("defaults isAddingMedia to false when omitted", () => {
        const { result } = renderHook(() =>
            useHomeLibraryPanel({
                selectedChannel: null,
                mediaItems: [],
                viewMode: "library",
                isLoadingMedia: false,
                isMigratingLibraryPath: false,
                libraryPath: "/library",
            })
        );

        expect(result.current.disableAddMedia).toBe(false);
    });

    it("defaults isMigratingLibraryPath to false when omitted", () => {
        const { result } = renderHook(() =>
            useHomeLibraryPanel({
                selectedChannel: null,
                mediaItems: [],
                viewMode: "library",
                isLoadingMedia: false,
                isAddingMedia: false,
                libraryPath: "/library",
            })
        );

        expect(result.current.disableAddMedia).toBe(false);
    });

    it("defaults libraryPath to an empty string when omitted, disabling add media", () => {
        const { result } = renderHook(() =>
            useHomeLibraryPanel({
                selectedChannel: null,
                mediaItems: [],
                viewMode: "library",
                isLoadingMedia: false,
                isAddingMedia: false,
                isMigratingLibraryPath: false,
            })
        );

        expect(result.current.disableAddMedia).toBe(true);
    });

    it("recomputes the panel state when an input changes across a re-render", () => {
        const selectedChannel = {
            id: 1,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        };

        const { result, rerender } = renderHook(
            (props: { isLoadingMedia: boolean }) =>
                useHomeLibraryPanel({
                    selectedChannel,
                    mediaItems: [],
                    viewMode: "library",
                    isLoadingMedia: props.isLoadingMedia,
                    isAddingMedia: false,
                    isMigratingLibraryPath: false,
                    libraryPath: "/library",
                }),
            { initialProps: { isLoadingMedia: false } }
        );

        expect(result.current.disableAddMedia).toBe(false);

        rerender({ isLoadingMedia: true });

        expect(result.current.disableAddMedia).toBe(true);
    });

    it("does not recompute the panel state when the re-render carries the same values", () => {
        const options = {
            selectedChannel: null,
            mediaItems: [] as never[],
            viewMode: "library" as const,
            isLoadingMedia: false,
            isAddingMedia: false,
            isMigratingLibraryPath: false,
            libraryPath: "/library",
        };

        const { result, rerender } = renderHook(() => useHomeLibraryPanel(options));

        const firstState = result.current;

        rerender();

        expect(result.current).toBe(firstState);
    });
});