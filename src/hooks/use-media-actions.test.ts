import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { useMediaActions } from "./use-media-actions";
import type { MediaRow } from "../types/media";

vi.mock("../utils/error-message", () => ({
    resolveErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

vi.mock("../use-cases/delete-media", () => ({
    executeDeleteMedia: vi.fn(),
}));

vi.mock("../use-cases/mark-media-watched", () => ({
    executeMarkMediaWatched: vi.fn(),
}));

vi.mock("../use-cases/mark-media-unwatched", () => ({
    executeMarkMediaUnwatched: vi.fn(),
}));

vi.mock("../services/library-service", () => ({
    openExternalUrl: vi.fn(),
    openFileLocation: vi.fn(),
}));

vi.mock("../services/media-service", () => ({
    refreshMediaComments: vi.fn(),
    updateMediaTitle: vi.fn(),
}));

import { executeDeleteMedia } from "../use-cases/delete-media";
import { executeMarkMediaWatched } from "../use-cases/mark-media-watched";
import { executeMarkMediaUnwatched } from "../use-cases/mark-media-unwatched";
import { openExternalUrl, openFileLocation } from "../services/library-service";
import { refreshMediaComments, updateMediaTitle } from "../services/media-service";

function createMediaRow(overrides: Partial<MediaRow> = {}): MediaRow {
    return {
        id: 1,
        channel_id: 10,
        title: "Item 1",
        file_path: "media/1.mp4",
        thumbnail_path: null,
        media_type: "video",
        youtube_video_id: null,
        watched_at: null,
        published_at: null,
        duration_seconds: 125,
        progress_seconds: 0,
        has_comments: 0,
        comments_count: 0,
        is_live: 0,
        has_live_chat: 0,
        live_chat_file_path: null,
        created_at: "2026-03-29T10:00:00.000Z",
        ...overrides,
    };
}

function createMediaPlayer(activeMedia: MediaRow | null = createMediaRow()) {
    return {
        activeMedia,
        setActiveMedia: vi.fn(),
        closePlayer: vi.fn(),
    };
}

describe("useMediaActions", () => {
    const onError = vi.fn();
    const setMediaItems = vi.fn();
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    it("opens delete confirmation", () => {
        const mediaPlayer = createMediaPlayer();

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        act(() => {
            result.current.requestDeleteMedia(mediaPlayer.activeMedia!);
        });

        expect(result.current.confirmDeleteMediaOpen).toBe(true);
        expect(result.current.mediaToDelete?.id).toBe(1);
    });

    it("marks media as watched and updates active player state", async () => {
        const mediaPlayer = createMediaPlayer();

        vi.mocked(executeMarkMediaWatched).mockResolvedValue(
            "2026-03-31T20:00:00.000Z"
        );

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        await act(async () => {
            await result.current.markAsWatched(1);
        });

        expect(executeMarkMediaWatched).toHaveBeenCalledWith({
            mediaId: 1,
            updateMediaItems: setMediaItems,
        });

        expect(mediaPlayer.setActiveMedia).toHaveBeenCalledWith({
            ...mediaPlayer.activeMedia,
            watched_at: "2026-03-31T20:00:00.000Z",
        });
    });

    it("marks media as unwatched and updates active player state", async () => {
        const mediaPlayer = createMediaPlayer();

        vi.mocked(executeMarkMediaUnwatched).mockResolvedValue(undefined);

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        await act(async () => {
            await result.current.markAsUnwatched(1);
        });

        expect(executeMarkMediaUnwatched).toHaveBeenCalledWith({
            mediaId: 1,
            updateMediaItems: setMediaItems,
        });

        expect(mediaPlayer.setActiveMedia).toHaveBeenCalledWith({
            ...mediaPlayer.activeMedia,
            watched_at: null,
        });
    });

    it("deletes media and closes player when active item is deleted", async () => {
        const mediaPlayer = createMediaPlayer();

        vi.mocked(executeDeleteMedia).mockResolvedValue(undefined);

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        act(() => {
            result.current.requestDeleteMedia(mediaPlayer.activeMedia!);
        });

        await act(async () => {
            await result.current.confirmDeleteMedia();
        });

        expect(executeDeleteMedia).toHaveBeenCalledWith({
            media: mediaPlayer.activeMedia,
            reloadMedia: expect.any(Function),
            closePlayerIfActive: expect.any(Function),
        });

        expect(result.current.confirmDeleteMediaOpen).toBe(false);
        expect(result.current.mediaToDelete).toBe(null);
    });

    it("reports delete error", async () => {
        const mediaPlayer = createMediaPlayer();

        vi.mocked(executeDeleteMedia).mockRejectedValue(new Error("boom"));

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        act(() => {
            result.current.requestDeleteMedia(mediaPlayer.activeMedia!);
        });

        await act(async () => {
            await result.current.confirmDeleteMedia();
        });

        expect(onError).toHaveBeenCalledWith("Failed to delete media.");
        expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it("reports watched update error", async () => {
        const mediaPlayer = createMediaPlayer();

        vi.mocked(executeMarkMediaWatched).mockRejectedValue(new Error("boom"));

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        await act(async () => {
            await result.current.markAsWatched(1);
        });

        expect(onError).toHaveBeenCalledWith("Failed to update watched status.");
        expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it("refreshes comments and updates active player state", async () => {
        const mediaPlayer = createMediaPlayer({
            ...createMediaRow({
                youtube_video_id: "abc123",
                has_comments: 0,
                comments_count: 0,
            }),
        });

        vi.mocked(refreshMediaComments).mockResolvedValue({
            updated: true,
            totalComments: 12,
        });

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        await act(async () => {
            await result.current.refreshComments(mediaPlayer.activeMedia!);
        });

        expect(refreshMediaComments).toHaveBeenCalledWith(1, "abc123", null);
        expect(setMediaItems).toHaveBeenCalledWith(expect.any(Function));
        expect(mediaPlayer.setActiveMedia).toHaveBeenCalledWith({
            ...mediaPlayer.activeMedia,
            has_comments: 1,
            comments_count: 12,
        });
    });

    it("edits title and updates active player state", async () => {
        const mediaPlayer = createMediaPlayer();

        vi.mocked(updateMediaTitle).mockResolvedValue(undefined);

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        await act(async () => {
            await result.current.editTitle(mediaPlayer.activeMedia!, "  New title  ");
        });

        expect(updateMediaTitle).toHaveBeenCalledWith(1, "New title");
        expect(setMediaItems).toHaveBeenCalledWith(expect.any(Function));
        expect(mediaPlayer.setActiveMedia).toHaveBeenCalledWith({
            ...mediaPlayer.activeMedia,
            title: "New title",
        });
    });

    it("opens media file location", async () => {
        const mediaPlayer = createMediaPlayer();

        vi.mocked(openFileLocation).mockResolvedValue(undefined);

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        await act(async () => {
            await result.current.openMediaFileLocation(mediaPlayer.activeMedia!);
        });

        expect(openFileLocation).toHaveBeenCalledWith("media/1.mp4", "/library");
    });

    it("opens media source on youtube", async () => {
        const mediaPlayer = createMediaPlayer(
            createMediaRow({
                youtube_video_id: "abc123",
            })
        );

        vi.mocked(openExternalUrl).mockResolvedValue(undefined);

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        await act(async () => {
            await result.current.openMediaSourceInYoutube(mediaPlayer.activeMedia!);
        });

        expect(openExternalUrl).toHaveBeenCalledWith(
            "https://www.youtube.com/watch?v=abc123"
        );
    });

    it("updates only the targeted item when refreshing comments", async () => {
        const mediaPlayer = createMediaPlayer();

        vi.mocked(refreshMediaComments).mockResolvedValue({
            updated: true,
            totalComments: 5,
        });

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        const targetMedia = createMediaRow({ id: 1 });
        const otherItem = createMediaRow({ id: 2, title: "Other" });

        await act(async () => {
            await result.current.refreshComments(targetMedia);
        });

        const updater = vi.mocked(setMediaItems).mock.calls[0][0] as (
            items: MediaRow[]
        ) => MediaRow[];

        const updated = updater([otherItem, targetMedia]);

        expect(updated[0]).toBe(otherItem);
        expect(updated[1]).toMatchObject({
            id: 1,
            has_comments: 1,
            comments_count: 5,
        });
    });

    it("sets has_comments to zero when total comments is zero", async () => {
        const mediaPlayer = createMediaPlayer(
            createMediaRow({
                youtube_video_id: "abc123",
                has_comments: 1,
                comments_count: 5,
            })
        );

        vi.mocked(refreshMediaComments).mockResolvedValue({
            updated: true,
            totalComments: 0,
        });

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        await act(async () => {
            await result.current.refreshComments(mediaPlayer.activeMedia!);
        });

        expect(mediaPlayer.setActiveMedia).toHaveBeenCalledWith({
            ...mediaPlayer.activeMedia,
            has_comments: 0,
            comments_count: 0,
        });

        const updater = vi.mocked(setMediaItems).mock.calls[0][0] as (
            items: MediaRow[]
        ) => MediaRow[];

        const updated = updater([mediaPlayer.activeMedia!]);

        expect(updated[0]).toMatchObject({ has_comments: 0, comments_count: 0 });
    });

    it("reports refresh comments error", async () => {
        const mediaPlayer = createMediaPlayer();

        vi.mocked(refreshMediaComments).mockRejectedValue(new Error("boom"));

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        await act(async () => {
            await result.current.refreshComments(mediaPlayer.activeMedia!);
        });

        expect(onError).toHaveBeenCalledWith(
            "Failed to refresh comments. Existing saved comments were preserved."
        );
    });

    it("updates only the targeted item when editing title", async () => {
        const mediaPlayer = createMediaPlayer();

        vi.mocked(updateMediaTitle).mockResolvedValue(undefined);

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        const targetMedia = createMediaRow({ id: 1 });
        const otherItem = createMediaRow({ id: 2, title: "Other" });

        await act(async () => {
            await result.current.editTitle(targetMedia, "New title");
        });

        const updater = vi.mocked(setMediaItems).mock.calls[0][0] as (
            items: MediaRow[]
        ) => MediaRow[];

        const updated = updater([otherItem, targetMedia]);

        expect(updated[0]).toBe(otherItem);
        expect(updated[1]).toMatchObject({ id: 1, title: "New title" });
    });

    it("reports error when media has no youtube source", async () => {
        const mediaPlayer = createMediaPlayer(
            createMediaRow({ youtube_video_id: null })
        );

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        await act(async () => {
            await result.current.openMediaSourceInYoutube(mediaPlayer.activeMedia!);
        });

        expect(onError).toHaveBeenCalledWith(
            "This media does not have a YouTube source."
        );
        expect(openExternalUrl).not.toHaveBeenCalled();
    });

    it("trims youtube video id before opening", async () => {
        const mediaPlayer = createMediaPlayer(
            createMediaRow({ youtube_video_id: "  abc123  " })
        );

        vi.mocked(openExternalUrl).mockResolvedValue(undefined);

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        await act(async () => {
            await result.current.openMediaSourceInYoutube(mediaPlayer.activeMedia!);
        });

        expect(openExternalUrl).toHaveBeenCalledWith(
            "https://www.youtube.com/watch?v=abc123"
        );
    });

    it("closes player when the deleted media is active", async () => {
        const mediaPlayer = createMediaPlayer(createMediaRow({ id: 1 }));

        vi.mocked(executeDeleteMedia).mockImplementation(
            async ({ media, reloadMedia, closePlayerIfActive }) => {
                closePlayerIfActive(media.id);
                await reloadMedia();
            }
        );

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        act(() => {
            result.current.requestDeleteMedia(mediaPlayer.activeMedia!);
        });

        await act(async () => {
            await result.current.confirmDeleteMedia();
        });

        expect(mediaPlayer.closePlayer).toHaveBeenCalled();
    });

    it("does not close player when the deleted media is not active", async () => {
        const mediaPlayer = createMediaPlayer(createMediaRow({ id: 2 }));
        const mediaToDelete = createMediaRow({ id: 1 });

        vi.mocked(executeDeleteMedia).mockImplementation(
            async ({ media, reloadMedia, closePlayerIfActive }) => {
                closePlayerIfActive(media.id);
                await reloadMedia();
            }
        );

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        act(() => {
            result.current.requestDeleteMedia(mediaToDelete);
        });

        await act(async () => {
            await result.current.confirmDeleteMedia();
        });

        expect(mediaPlayer.closePlayer).not.toHaveBeenCalled();
    });

    it("removes only the deleted item from memory", async () => {
        const mediaPlayer = createMediaPlayer();
        const mediaToDelete = createMediaRow({ id: 1 });
        const otherItem = createMediaRow({ id: 2, title: "Other" });

        vi.mocked(executeDeleteMedia).mockImplementation(
            async ({ media, reloadMedia, closePlayerIfActive }) => {
                closePlayerIfActive(media.id);
                await reloadMedia();
            }
        );

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        act(() => {
            result.current.requestDeleteMedia(mediaToDelete);
        });

        await act(async () => {
            await result.current.confirmDeleteMedia();
        });

        const updater = vi.mocked(setMediaItems).mock.calls[0][0] as (
            items: MediaRow[]
        ) => MediaRow[];

        const updated = updater([mediaToDelete, otherItem]);

        expect(updated).toEqual([otherItem]);
    });

    it("closes delete modal explicitly", () => {
        const mediaPlayer = createMediaPlayer();

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        act(() => {
            result.current.requestDeleteMedia(mediaPlayer.activeMedia!);
        });

        act(() => {
            result.current.closeDeleteMediaModal();
        });

        expect(result.current.confirmDeleteMediaOpen).toBe(false);
        expect(result.current.mediaToDelete).toBe(null);
    });

    it("keeps delete modal open while a deletion is in progress", async () => {
        const mediaPlayer = createMediaPlayer();

        let releaseDelete: (() => void) | null = null;
        vi.mocked(executeDeleteMedia).mockImplementation(
            () =>
                new Promise((resolve) => {
                    releaseDelete = () => resolve(undefined);
                })
        );

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        act(() => {
            result.current.requestDeleteMedia(mediaPlayer.activeMedia!);
        });

        act(() => {
            void result.current.confirmDeleteMedia();
        });

        act(() => {
            result.current.closeDeleteMediaModal();
        });

        expect(result.current.confirmDeleteMediaOpen).toBe(true);
        expect(result.current.mediaToDelete?.id).toBe(1);

        await act(async () => {
            releaseDelete?.();
        });
    });

    it("ignores new delete requests while a deletion is in progress", async () => {
        const mediaPlayer = createMediaPlayer();
        const firstMedia = createMediaRow({ id: 1 });
        const secondMedia = createMediaRow({ id: 2 });

        let releaseDelete: (() => void) | null = null;
        vi.mocked(executeDeleteMedia).mockImplementation(
            () =>
                new Promise((resolve) => {
                    releaseDelete = () => resolve(undefined);
                })
        );

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                mediaPlayer,
                onError,
            })
        );

        act(() => {
            result.current.requestDeleteMedia(firstMedia);
        });

        act(() => {
            void result.current.confirmDeleteMedia();
        });

        act(() => {
            result.current.requestDeleteMedia(secondMedia);
        });

        expect(result.current.mediaToDelete?.id).toBe(1);

        await act(async () => {
            releaseDelete?.();
        });
    });
});