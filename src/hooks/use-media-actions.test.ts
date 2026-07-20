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

vi.mock("../services/media-download-service", () => ({
    cancelMediaDownload: vi.fn(),
    commentsRefreshRunId: (mediaId: number) => `comments-refresh-${mediaId}`,
}));

import { executeDeleteMedia } from "../use-cases/delete-media";
import { executeMarkMediaWatched } from "../use-cases/mark-media-watched";
import { executeMarkMediaUnwatched } from "../use-cases/mark-media-unwatched";
import { openExternalUrl, openFileLocation } from "../services/library-service";
import { refreshMediaComments, updateMediaTitle } from "../services/media-service";
import { cancelMediaDownload } from "../services/media-download-service";

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
    const onNotice = vi.fn();
    const setMediaItems = vi.fn();
    const onItemsRemoved = vi.fn();
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
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
            })
        );

        act(() => {
            result.current.requestDeleteMedia(mediaPlayer.activeMedia!);
        });

        expect(result.current.confirmDeleteMediaOpen).toBe(true);
        expect(result.current.mediaToDelete?.id).toBe(1);
    });

    it("marks media as watched and updates active player state", async () => {
        const mediaPlayer = createMediaPlayer(createMediaRow({ progress_seconds: 42 }));

        vi.mocked(executeMarkMediaWatched).mockResolvedValue(
            "2026-03-31T20:00:00.000Z"
        );

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
            })
        );

        await act(async () => {
            await result.current.markAsWatched(1);
        });

        expect(executeMarkMediaWatched).toHaveBeenCalledWith({
            mediaId: 1,
            updateMediaItems: setMediaItems,
        });

        // Progress is reset to 0 alongside watched_at, matching the backend and the media list.
        expect(mediaPlayer.setActiveMedia).toHaveBeenCalledWith({
            ...mediaPlayer.activeMedia,
            watched_at: "2026-03-31T20:00:00.000Z",
            progress_seconds: 0,
        });
    });

    it("does not drop a watched toggle on another media while one is in flight", async () => {
        const mediaPlayer = createMediaPlayer();

        // A slow round trip, so the second toggle starts while the first is still running.
        vi.mocked(executeMarkMediaWatched).mockImplementation(
            () =>
                new Promise((resolve) =>
                    setTimeout(() => resolve("2026-03-31T20:00:00.000Z"), 0)
                )
        );

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
            })
        );

        // Two different rows toggled back to back. A single shared re-entrancy flag made the
        // second one a silent no-op - no request, no error, no disabled state to explain it -
        // because these rows are independent and nothing serializes them.
        await act(async () => {
            await Promise.all([result.current.markAsWatched(1), result.current.markAsWatched(2)]);
        });

        expect(executeMarkMediaWatched).toHaveBeenCalledTimes(2);
        expect(executeMarkMediaWatched).toHaveBeenCalledWith({
            mediaId: 1,
            updateMediaItems: setMediaItems,
        });
        expect(executeMarkMediaWatched).toHaveBeenCalledWith({
            mediaId: 2,
            updateMediaItems: setMediaItems,
        });
    });

    it("exposes the media id as in flight while a watched toggle is running", async () => {
        // Before this, the in-flight set the guard already tracked internally was discarded, so a
        // caller had no way to render loading/disabled feedback for the toggle in progress.
        const mediaPlayer = createMediaPlayer();

        let resolveWatched: (() => void) | undefined;
        vi.mocked(executeMarkMediaWatched).mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveWatched = () => resolve("2026-03-31T20:00:00.000Z");
                })
        );

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
            })
        );

        expect(result.current.watchedActionInFlight.has(1)).toBe(false);

        let markPromise: Promise<void>;
        act(() => {
            markPromise = result.current.markAsWatched(1);
        });

        expect(result.current.watchedActionInFlight.has(1)).toBe(true);

        await act(async () => {
            resolveWatched?.();
            await markPromise;
        });

        expect(result.current.watchedActionInFlight.has(1)).toBe(false);
    });

    it("still guards a repeated watched toggle on the same media", async () => {
        const mediaPlayer = createMediaPlayer();

        vi.mocked(executeMarkMediaWatched).mockImplementation(
            () =>
                new Promise((resolve) =>
                    setTimeout(() => resolve("2026-03-31T20:00:00.000Z"), 0)
                )
        );

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
            })
        );

        // Keying the guard by media id must not lose the guard itself: the same row toggled
        // twice concurrently still runs once.
        await act(async () => {
            await Promise.all([result.current.markAsWatched(1), result.current.markAsWatched(1)]);
        });

        expect(executeMarkMediaWatched).toHaveBeenCalledTimes(1);
    });

    it("marks media as unwatched and updates active player state", async () => {
        const mediaPlayer = createMediaPlayer();

        vi.mocked(executeMarkMediaUnwatched).mockResolvedValue(undefined);

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
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
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
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
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
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
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
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
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
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

    it("cancels a comment refresh without reporting anything on success", async () => {
        const mediaPlayer = createMediaPlayer();

        vi.mocked(cancelMediaDownload).mockResolvedValue(undefined);

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
            })
        );

        await act(async () => {
            await result.current.cancelRefreshComments(1);
        });

        expect(cancelMediaDownload).toHaveBeenCalledWith("comments-refresh-1");
        expect(onError).not.toHaveBeenCalled();
        expect(onNotice).not.toHaveBeenCalled();
    });

    it("quietly ignores an INVALID_RUN_ID cancel failure (the refresh already finished)", async () => {
        const mediaPlayer = createMediaPlayer();

        vi.mocked(cancelMediaDownload).mockRejectedValue({
            code: "INVALID_RUN_ID",
            message: "run_id 'comments-refresh-1' is not active",
        });

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
            })
        );

        await act(async () => {
            await result.current.cancelRefreshComments(1);
        });

        // Best effort: the run finished before the cancel reached it, which is not worth
        // reporting to the user.
        expect(onNotice).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
        expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("surfaces a notice when the cancel genuinely fails to reach the backend", async () => {
        const mediaPlayer = createMediaPlayer();

        vi.mocked(cancelMediaDownload).mockRejectedValue({
            code: "APP_ERROR",
            message: "boom",
        });

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
            })
        );

        await act(async () => {
            await result.current.cancelRefreshComments(1);
        });

        // A real failure to cancel used to be swallowed silently (only logged), leaving the user
        // to believe Cancel worked while the backup kept running. It must not become a blocking
        // error either - this is a notice, not onError.
        expect(onNotice).toHaveBeenCalledWith(
            "Could not confirm the comment refresh was cancelled. It may still be running in the background."
        );
        expect(onError).not.toHaveBeenCalled();
        expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it("edits title and updates active player state", async () => {
        const mediaPlayer = createMediaPlayer();

        vi.mocked(updateMediaTitle).mockResolvedValue(undefined);

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
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
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
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
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
            })
        );

        await act(async () => {
            await result.current.openMediaSourceInYoutube(mediaPlayer.activeMedia!);
        });

        expect(openExternalUrl).toHaveBeenCalledWith(
            "https://www.youtube.com/watch?v=abc123"
        );
    });

    it("refreshes a second media while the first refresh is still in flight", async () => {
        // The guard used to be one shared flag, which returned undefined without throwing when it
        // was already running - so the second refresh vanished with no error and no refreshed
        // comments, and nothing rendered a busy state to hint at why. The player's Back button is
        // live during a refresh, so "refresh A, go back, open B, refresh B" is an ordinary
        // sequence rather than a race the user has to engineer.
        const mediaPlayer = createMediaPlayer();

        let resolveFirst: (() => void) | undefined;
        vi.mocked(refreshMediaComments)
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveFirst = () => resolve({ updated: true, totalComments: 5 });
                    })
            )
            .mockResolvedValueOnce({ updated: true, totalComments: 9 });

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
            })
        );

        const first = createMediaRow({ id: 1 });
        const second = createMediaRow({ id: 2 });

        // Left in flight on purpose: this is the state that used to swallow the next refresh.
        let firstRefresh: Promise<void>;
        act(() => {
            firstRefresh = result.current.refreshComments(first);
        });

        await act(async () => {
            await result.current.refreshComments(second);
        });

        expect(refreshMediaComments).toHaveBeenCalledTimes(2);
        expect(refreshMediaComments).toHaveBeenLastCalledWith(2, second.youtube_video_id, null);

        await act(async () => {
            resolveFirst?.();
            await firstRefresh;
        });
    });

    it("ignores a second refresh of the same media while one is in flight", async () => {
        // The other half of the guard: keying by id must still stop the same row being refreshed
        // twice at once, which is what the shared flag got right.
        const mediaPlayer = createMediaPlayer();

        let resolveFirst: (() => void) | undefined;
        vi.mocked(refreshMediaComments).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveFirst = () => resolve({ updated: true, totalComments: 5 });
                })
        );

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
            })
        );

        const media = createMediaRow({ id: 1 });

        let firstRefresh: Promise<void>;
        act(() => {
            firstRefresh = result.current.refreshComments(media);
        });

        await act(async () => {
            await result.current.refreshComments(media);
        });

        expect(refreshMediaComments).toHaveBeenCalledTimes(1);

        await act(async () => {
            resolveFirst?.();
            await firstRefresh;
        });
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
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
            })
        );

        const targetMedia = createMediaRow({ id: 1 });
        const otherItem = createMediaRow({ id: 2, title: "Other" });

        await act(async () => {
            await result.current.refreshComments(targetMedia);
        });

        const updater = vi.mocked(setMediaItems).mock.calls[0]![0] as (
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
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
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

        const updater = vi.mocked(setMediaItems).mock.calls[0]![0] as (
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
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
            })
        );

        await act(async () => {
            await result.current.refreshComments(mediaPlayer.activeMedia!);
        });

        expect(onError).toHaveBeenCalledWith(
            "Failed to refresh comments. Existing saved comments were preserved."
        );
    });

    it("shows a notice (not an error) and keeps counts when a refresh returns no comments", async () => {
        const mediaPlayer = createMediaPlayer();

        vi.mocked(refreshMediaComments).mockResolvedValue({
            updated: false,
            totalComments: 0,
        });

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
            })
        );

        await act(async () => {
            await result.current.refreshComments(mediaPlayer.activeMedia!);
        });

        expect(onNotice).toHaveBeenCalledWith(
            "No comments were found for this media. Your saved comments were kept."
        );
        expect(onError).not.toHaveBeenCalled();
        // Saved comment counts must be left untouched, not reset to zero.
        expect(setMediaItems).not.toHaveBeenCalled();
        expect(mediaPlayer.setActiveMedia).not.toHaveBeenCalled();
    });

    it("updates only the targeted item when editing title", async () => {
        const mediaPlayer = createMediaPlayer();

        vi.mocked(updateMediaTitle).mockResolvedValue(undefined);

        const { result } = renderHook(() =>
            useMediaActions({
                libraryPath: "/library",
                setMediaItems,
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
            })
        );

        const targetMedia = createMediaRow({ id: 1 });
        const otherItem = createMediaRow({ id: 2, title: "Other" });

        await act(async () => {
            await result.current.editTitle(targetMedia, "New title");
        });

        const updater = vi.mocked(setMediaItems).mock.calls[0]![0] as (
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
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
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
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
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
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
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
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
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
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
            })
        );

        act(() => {
            result.current.requestDeleteMedia(mediaToDelete);
        });

        await act(async () => {
            await result.current.confirmDeleteMedia();
        });

        const updater = vi.mocked(setMediaItems).mock.calls[0]![0] as (
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
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
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
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
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
                onItemsRemoved,
                mediaPlayer,
                onError,
                onNotice,
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

    it("keeps the media action handlers stable when the active media changes", () => {
        // In the real player hook setActiveMedia/closePlayer are stable (useCallback []), so
        // model that here and vary only activeMedia.
        const setActiveMedia = vi.fn();
        const closePlayer = vi.fn();
        const makeProps = (activeMedia: MediaRow) => ({
            libraryPath: "/library",
            setMediaItems,
            onItemsRemoved,
            mediaPlayer: { activeMedia, setActiveMedia, closePlayer },
            onError,
            onNotice,
        });

        const { result, rerender } = renderHook((props) => useMediaActions(props), {
            initialProps: makeProps(createMediaRow({ id: 1, title: "Original" })),
        });

        const before = {
            markAsWatched: result.current.markAsWatched,
            markAsUnwatched: result.current.markAsUnwatched,
            refreshComments: result.current.refreshComments,
            editTitle: result.current.editTitle,
        };

        // A new activeMedia object (opening a video, editing its title) must not recreate the
        // per-card handlers, otherwise every MediaCard re-renders.
        rerender(makeProps(createMediaRow({ id: 1, title: "Renamed" })));

        expect(result.current.markAsWatched).toBe(before.markAsWatched);
        expect(result.current.markAsUnwatched).toBe(before.markAsUnwatched);
        expect(result.current.refreshComments).toBe(before.refreshComments);
        expect(result.current.editTitle).toBe(before.editTitle);
    });

    it("marks watched using the latest active media, not a stale closure", async () => {
        const setActiveMedia = vi.fn();
        const closePlayer = vi.fn();
        const makeProps = (activeMedia: MediaRow) => ({
            libraryPath: "/library",
            setMediaItems,
            onItemsRemoved,
            mediaPlayer: { activeMedia, setActiveMedia, closePlayer },
            onError,
            onNotice,
        });

        vi.mocked(executeMarkMediaWatched).mockResolvedValue("2026-03-31T20:00:00.000Z");

        const { result, rerender } = renderHook((props) => useMediaActions(props), {
            initialProps: makeProps(createMediaRow({ id: 1, title: "Old" })),
        });

        // The active media's title is updated after the first render (e.g. an in-place edit).
        rerender(makeProps(createMediaRow({ id: 1, title: "New" })));

        await act(async () => {
            await result.current.markAsWatched(1);
        });

        // It must spread the current active media (title "New"), never the stale "Old".
        expect(setActiveMedia).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 1,
                title: "New",
                watched_at: "2026-03-31T20:00:00.000Z",
                progress_seconds: 0,
            })
        );
    });
});