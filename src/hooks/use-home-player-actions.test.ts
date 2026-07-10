import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MediaRow } from "../types/media";
import { openFileLocation, refreshMediaComments } from "../services";
import { useHomePlayerActions } from "./use-home-player-actions";

vi.mock("../services", () => ({
    openFileLocation: vi.fn(),
    refreshMediaComments: vi.fn(),
}));

function createMediaRow(overrides: Partial<MediaRow> = {}): MediaRow {
    return {
        id: 55,
        channel_id: 10,
        title: "Video A",
        file_path: "video/a.mp4",
        thumbnail_path: null,
        media_type: "video",
        youtube_video_id: null,
        watched_at: null,
        published_at: null,
        duration_seconds: 125,
        progress_seconds: 42,
        created_at: "2026-03-31T10:00:00.000Z",
        has_comments: 0,
        comments_count: 0,
        is_live: 0,
        has_live_chat: 0,
        live_chat_file_path: null,
        ...overrides,
    };
}

type MockMediaPlayer = {
    activeMedia: MediaRow | null;
    openInYoutube: () => Promise<void>;
    closePlayer: () => void;
    setActiveMedia: (media: MediaRow | null) => void;
};

type MockHomeMediaActions = {
    markAsWatched: (mediaId: number) => Promise<void>;
    markAsUnwatched: (mediaId: number) => Promise<void>;
    saveMediaProgress: (mediaId: number, progressSeconds: number) => Promise<void>;
};

type MockOptions = {
    mediaPlayer: MockMediaPlayer;
    homeMediaActions: MockHomeMediaActions;
    onError: (message: string) => void;
    onReloadMedia: (channelId?: number | null) => Promise<void>;
    libraryPath: string;
};

function createHomeMediaActions(): MockHomeMediaActions {
    return {
        markAsWatched: vi.fn<(mediaId: number) => Promise<void>>().mockResolvedValue(undefined),
        markAsUnwatched: vi.fn<(mediaId: number) => Promise<void>>().mockResolvedValue(undefined),
        saveMediaProgress: vi
            .fn<(mediaId: number, progressSeconds: number) => Promise<void>>()
            .mockResolvedValue(undefined),
    };
}

function createDefaultOptions(overrides?: {
    activeMedia?: MediaRow | null;
    mediaPlayer?: Partial<MockMediaPlayer>;
    homeMediaActions?: MockHomeMediaActions;
    onError?: (message: string) => void;
    onReloadMedia?: (channelId?: number | null) => Promise<void>;
    libraryPath?: string;
}): MockOptions {
    const mediaPlayer: MockMediaPlayer = {
        activeMedia: overrides?.activeMedia ?? null,
        openInYoutube: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        closePlayer: vi.fn<() => void>(),
        setActiveMedia: vi.fn<(media: MediaRow | null) => void>(),
        ...overrides?.mediaPlayer,
    };

    return {
        mediaPlayer,
        homeMediaActions: overrides?.homeMediaActions ?? createHomeMediaActions(),
        onError: overrides?.onError ?? vi.fn<(message: string) => void>(),
        onReloadMedia:
            overrides?.onReloadMedia ??
            vi.fn<(channelId?: number | null) => Promise<void>>().mockResolvedValue(undefined),
        libraryPath: overrides?.libraryPath ?? "/library",
    };
}

describe("useHomePlayerActions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("opens current media on youtube", async () => {
        const options = createDefaultOptions();

        const { result } = renderHook(() => useHomePlayerActions(options));

        await act(async () => {
            await result.current.openInYoutube();
        });

        expect(options.mediaPlayer.openInYoutube).toHaveBeenCalledTimes(1);
    });

    it("marks active media as watched when there is an active media", async () => {
        const activeMedia = createMediaRow({
            id: 55,
            progress_seconds: 42,
            watched_at: null,
        });

        const options = createDefaultOptions({
            activeMedia,
        });

        const { result } = renderHook(() => useHomePlayerActions(options));

        await act(async () => {
            await result.current.markActiveAsWatched();
        });

        expect(options.homeMediaActions.markAsWatched).toHaveBeenCalledWith(55);
        expect(options.mediaPlayer.setActiveMedia).toHaveBeenCalledTimes(1);

        const updatedMedia = vi.mocked(options.mediaPlayer.setActiveMedia).mock.calls[0][0];

        expect(updatedMedia).toMatchObject({
            id: 55,
            watched_at: expect.any(String),
            progress_seconds: 0,
        });
    });

    it("does nothing when marking watched without active media", async () => {
        const options = createDefaultOptions({
            activeMedia: null,
        });

        const { result } = renderHook(() => useHomePlayerActions(options));

        await act(async () => {
            await result.current.markActiveAsWatched();
        });

        expect(options.homeMediaActions.markAsWatched).not.toHaveBeenCalled();
        expect(options.mediaPlayer.setActiveMedia).not.toHaveBeenCalled();
    });

    it("marks active media as unwatched when there is an active media", async () => {
        const activeMedia = createMediaRow({
            id: 77,
            title: "Video B",
            file_path: "video/b.mp4",
            watched_at: "2026-03-31T12:00:00.000Z",
            duration_seconds: 180,
            progress_seconds: 0,
        });

        const options = createDefaultOptions({
            activeMedia,
        });

        const { result } = renderHook(() => useHomePlayerActions(options));

        await act(async () => {
            await result.current.markActiveAsUnwatched();
        });

        expect(options.homeMediaActions.markAsUnwatched).toHaveBeenCalledWith(77);
        expect(options.mediaPlayer.setActiveMedia).toHaveBeenCalledWith({
            ...activeMedia,
            watched_at: null,
        });
    });

    it("closes player without saving progress when there is no active media", async () => {
        const options = createDefaultOptions({
            activeMedia: null,
        });

        const { result } = renderHook(() => useHomePlayerActions(options));

        await act(async () => {
            await result.current.closePlayer();
        });

        expect(options.homeMediaActions.saveMediaProgress).not.toHaveBeenCalled();
        expect(options.mediaPlayer.closePlayer).toHaveBeenCalledTimes(1);
    });

    it("saves progress before closing when active media is not watched", async () => {
        const activeMedia = createMediaRow({
            id: 88,
            watched_at: null,
        });

        const options = createDefaultOptions({
            activeMedia,
        });

        const { result } = renderHook(() => useHomePlayerActions(options));

        await act(async () => {
            await result.current.closePlayer(64.8);
        });

        expect(options.homeMediaActions.saveMediaProgress).toHaveBeenCalledWith(88, 64.8);
        expect(options.mediaPlayer.closePlayer).toHaveBeenCalledTimes(1);
    });

    it("does not save progress before closing when active media is already watched", async () => {
        const activeMedia = createMediaRow({
            id: 99,
            watched_at: "2026-03-31T12:00:00.000Z",
        });

        const options = createDefaultOptions({
            activeMedia,
        });

        const { result } = renderHook(() => useHomePlayerActions(options));

        await act(async () => {
            await result.current.closePlayer(64.8);
        });

        expect(options.homeMediaActions.saveMediaProgress).not.toHaveBeenCalled();
        expect(options.mediaPlayer.closePlayer).toHaveBeenCalledTimes(1);
    });

    it("does not save progress when closing without an explicit position", async () => {
        // Switching channels from the sidebar closes the player with no argument; it must not
        // overwrite the saved position with 0. The player view persists the real position on
        // unmount instead.
        const activeMedia = createMediaRow({
            id: 88,
            watched_at: null,
        });

        const options = createDefaultOptions({
            activeMedia,
        });

        const { result } = renderHook(() => useHomePlayerActions(options));

        await act(async () => {
            await result.current.closePlayer();
        });

        expect(options.homeMediaActions.saveMediaProgress).not.toHaveBeenCalled();
        expect(options.mediaPlayer.closePlayer).toHaveBeenCalledTimes(1);
    });

    it("saves progress for the given media", async () => {
        const options = createDefaultOptions({
            activeMedia: createMediaRow({ id: 88 }),
        });

        const { result } = renderHook(() => useHomePlayerActions(options));

        await act(async () => {
            await result.current.saveProgress(88, 45.2);
        });

        expect(options.homeMediaActions.saveMediaProgress).toHaveBeenCalledWith(88, 45.2);
    });

    it("starts with isRefreshingComments as false", () => {
        const options = createDefaultOptions();

        const { result } = renderHook(() => useHomePlayerActions(options));

        expect(result.current.isRefreshingComments).toBe(false);
    });

    describe("openFileLocation", () => {
        it("shows an error and does not open the file location when there is no active media", async () => {
            const options = createDefaultOptions({
                activeMedia: null,
            });

            const { result } = renderHook(() => useHomePlayerActions(options));

            await act(async () => {
                await result.current.openFileLocation();
            });

            expect(options.onError).toHaveBeenCalledWith(
                "This media does not have a valid file path."
            );
            expect(openFileLocation).not.toHaveBeenCalled();
        });

        it("shows an error when the active media file path is blank after trimming", async () => {
            const activeMedia = createMediaRow({
                file_path: "   ",
            });

            const options = createDefaultOptions({
                activeMedia,
            });

            const { result } = renderHook(() => useHomePlayerActions(options));

            await act(async () => {
                await result.current.openFileLocation();
            });

            expect(options.onError).toHaveBeenCalledWith(
                "This media does not have a valid file path."
            );
            expect(openFileLocation).not.toHaveBeenCalled();
        });

        it("opens the trimmed file path using the library path when file path is valid", async () => {
            const activeMedia = createMediaRow({
                file_path: "  video/a.mp4  ",
            });

            const options = createDefaultOptions({
                activeMedia,
                libraryPath: "/library",
            });

            vi.mocked(openFileLocation).mockResolvedValueOnce(undefined);

            const { result } = renderHook(() => useHomePlayerActions(options));

            await act(async () => {
                await result.current.openFileLocation();
            });

            expect(openFileLocation).toHaveBeenCalledWith("video/a.mp4", "/library");
            expect(options.onError).not.toHaveBeenCalled();
        });

        it("shows a fallback error message when opening the file location fails", async () => {
            const activeMedia = createMediaRow({
                file_path: "video/a.mp4",
            });

            const options = createDefaultOptions({
                activeMedia,
            });

            vi.mocked(openFileLocation).mockRejectedValueOnce(new Error("boom"));

            const { result } = renderHook(() => useHomePlayerActions(options));

            await act(async () => {
                await result.current.openFileLocation();
            });

            expect(options.onError).toHaveBeenCalledWith(
                "Failed to open file location."
            );
        });

        it("uses the file path and library path from the latest render", async () => {
            const options = createDefaultOptions({
                activeMedia: createMediaRow({ file_path: "first.mp4" }),
                libraryPath: "/library-first",
            });

            vi.mocked(openFileLocation).mockResolvedValue(undefined);

            const { result, rerender } = renderHook(
                (props: MockOptions) => useHomePlayerActions(props),
                { initialProps: options }
            );

            const nextOptions = createDefaultOptions({
                activeMedia: createMediaRow({ file_path: "second.mp4" }),
                libraryPath: "/library-second",
                homeMediaActions: options.homeMediaActions,
                onError: options.onError,
                onReloadMedia: options.onReloadMedia,
            });

            rerender(nextOptions);

            await act(async () => {
                await result.current.openFileLocation();
            });

            expect(openFileLocation).toHaveBeenCalledWith("second.mp4", "/library-second");
        });
    });

    describe("refreshComments", () => {
        it("does nothing when there is no active media", async () => {
            const options = createDefaultOptions({
                activeMedia: null,
            });

            const { result } = renderHook(() => useHomePlayerActions(options));

            await act(async () => {
                await result.current.refreshComments();
            });

            expect(refreshMediaComments).not.toHaveBeenCalled();
        });

        it("shows an error when active media has no youtube video id", async () => {
            const activeMedia = createMediaRow({
                youtube_video_id: null,
            });

            const options = createDefaultOptions({
                activeMedia,
            });

            const { result } = renderHook(() => useHomePlayerActions(options));

            await act(async () => {
                await result.current.refreshComments();
            });

            expect(options.onError).toHaveBeenCalledWith(
                "This media does not have a YouTube source for comment refresh."
            );
            expect(refreshMediaComments).not.toHaveBeenCalled();
        });

        it("shows an error when the youtube video id is blank after trimming", async () => {
            const activeMedia = createMediaRow({
                youtube_video_id: "   ",
            });

            const options = createDefaultOptions({
                activeMedia,
            });

            const { result } = renderHook(() => useHomePlayerActions(options));

            await act(async () => {
                await result.current.refreshComments();
            });

            expect(options.onError).toHaveBeenCalledWith(
                "This media does not have a YouTube source for comment refresh."
            );
            expect(refreshMediaComments).not.toHaveBeenCalled();
        });

        it("ignores concurrent refresh attempts while a refresh is pending", async () => {
            const activeMedia = createMediaRow({
                youtube_video_id: "yt-123",
            });

            const options = createDefaultOptions({
                activeMedia,
            });

            let resolvePending: (value: { updated: boolean; totalComments: number }) => void = () => {};
            const pending = new Promise<{ updated: boolean; totalComments: number }>((resolve) => {
                resolvePending = resolve;
            });

            vi.mocked(refreshMediaComments).mockReturnValueOnce(pending);

            const { result } = renderHook(() => useHomePlayerActions(options));

            let firstCall!: Promise<void>;

            act(() => {
                firstCall = result.current.refreshComments();
            });

            expect(result.current.isRefreshingComments).toBe(true);

            await act(async () => {
                await result.current.refreshComments();
            });

            expect(refreshMediaComments).toHaveBeenCalledTimes(1);

            await act(async () => {
                resolvePending({ updated: true, totalComments: 2 });
                await firstCall;
            });

            expect(result.current.isRefreshingComments).toBe(false);
        });

        it("marks has_comments as 0 when the refreshed total is exactly 0", async () => {
            const activeMedia = createMediaRow({
                youtube_video_id: "yt-123",
            });

            const options = createDefaultOptions({
                activeMedia,
            });

            vi.mocked(refreshMediaComments).mockResolvedValueOnce({ updated: false, totalComments: 0 });

            const { result } = renderHook(() => useHomePlayerActions(options));

            await act(async () => {
                await result.current.refreshComments();
            });

            expect(options.mediaPlayer.setActiveMedia).toHaveBeenCalledWith(
                expect.objectContaining({
                    has_comments: 0,
                    comments_count: 0,
                })
            );
        });

        it("marks has_comments as 1 when the refreshed total is greater than 0", async () => {
            const activeMedia = createMediaRow({
                youtube_video_id: "yt-123",
            });

            const options = createDefaultOptions({
                activeMedia,
            });

            vi.mocked(refreshMediaComments).mockResolvedValueOnce({ updated: true, totalComments: 3 });

            const { result } = renderHook(() => useHomePlayerActions(options));

            await act(async () => {
                await result.current.refreshComments();
            });

            expect(options.mediaPlayer.setActiveMedia).toHaveBeenCalledWith(
                expect.objectContaining({
                    has_comments: 1,
                    comments_count: 3,
                })
            );
        });

        it("reloads media for the active channel after a successful refresh", async () => {
            const activeMedia = createMediaRow({
                youtube_video_id: "yt-123",
                channel_id: 42,
            });

            const options = createDefaultOptions({
                activeMedia,
            });

            vi.mocked(refreshMediaComments).mockResolvedValueOnce({ updated: true, totalComments: 1 });

            const { result } = renderHook(() => useHomePlayerActions(options));

            await act(async () => {
                await result.current.refreshComments();
            });

            expect(options.onReloadMedia).toHaveBeenCalledWith(42);
        });

        it("shows a fallback error message and clears the loading flag when refresh fails", async () => {
            const activeMedia = createMediaRow({
                youtube_video_id: "yt-123",
            });

            const options = createDefaultOptions({
                activeMedia,
            });

            vi.mocked(refreshMediaComments).mockRejectedValueOnce(new Error("boom"));

            const { result } = renderHook(() => useHomePlayerActions(options));

            await act(async () => {
                await result.current.refreshComments();
            });

            expect(options.onError).toHaveBeenCalledWith(
                "Failed to refresh comments. Existing saved comments were preserved."
            );
            expect(result.current.isRefreshingComments).toBe(false);
        });

        it("calls the onReloadMedia from the latest render, not a stale closure", async () => {
            const activeMedia = createMediaRow({
                youtube_video_id: "yt-123",
                channel_id: 7,
            });

            const options = createDefaultOptions({
                activeMedia,
            });

            const { result, rerender } = renderHook(
                (props: MockOptions) => useHomePlayerActions(props),
                { initialProps: options }
            );

            const newOnReloadMedia = vi
                .fn<(channelId?: number | null) => Promise<void>>()
                .mockResolvedValue(undefined);

            const nextOptions: MockOptions = {
                ...options,
                onReloadMedia: newOnReloadMedia,
            };

            rerender(nextOptions);

            vi.mocked(refreshMediaComments).mockResolvedValueOnce({ updated: true, totalComments: 1 });

            await act(async () => {
                await result.current.refreshComments();
            });

            expect(newOnReloadMedia).toHaveBeenCalledWith(7);
            expect(options.onReloadMedia).not.toHaveBeenCalled();
        });
    });

    describe("dependency freshness across rerenders", () => {
        it("calls the openInYoutube implementation from the latest render", async () => {
            const options = createDefaultOptions();

            const { result, rerender } = renderHook(
                (props: MockOptions) => useHomePlayerActions(props),
                { initialProps: options }
            );

            const newOpenInYoutube = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

            const nextOptions: MockOptions = {
                ...options,
                mediaPlayer: {
                    ...options.mediaPlayer,
                    openInYoutube: newOpenInYoutube,
                },
            };

            rerender(nextOptions);

            await act(async () => {
                await result.current.openInYoutube();
            });

            expect(newOpenInYoutube).toHaveBeenCalledTimes(1);
            expect(options.mediaPlayer.openInYoutube).not.toHaveBeenCalled();
        });

        it("calls markAsWatched from the latest render", async () => {
            const activeMedia = createMediaRow({ id: 33, watched_at: null });

            const options = createDefaultOptions({
                activeMedia,
            });

            const { result, rerender } = renderHook(
                (props: MockOptions) => useHomePlayerActions(props),
                { initialProps: options }
            );

            const newHomeMediaActions = createHomeMediaActions();

            const nextOptions: MockOptions = {
                ...options,
                homeMediaActions: newHomeMediaActions,
            };

            rerender(nextOptions);

            await act(async () => {
                await result.current.markActiveAsWatched();
            });

            expect(newHomeMediaActions.markAsWatched).toHaveBeenCalledWith(33);
            expect(options.homeMediaActions.markAsWatched).not.toHaveBeenCalled();
        });

        it("calls markAsUnwatched from the latest render", async () => {
            const activeMedia = createMediaRow({ id: 44, watched_at: "2026-03-31T12:00:00.000Z" });

            const options = createDefaultOptions({
                activeMedia,
            });

            const { result, rerender } = renderHook(
                (props: MockOptions) => useHomePlayerActions(props),
                { initialProps: options }
            );

            const newHomeMediaActions = createHomeMediaActions();

            const nextOptions: MockOptions = {
                ...options,
                homeMediaActions: newHomeMediaActions,
            };

            rerender(nextOptions);

            await act(async () => {
                await result.current.markActiveAsUnwatched();
            });

            expect(newHomeMediaActions.markAsUnwatched).toHaveBeenCalledWith(44);
            expect(options.homeMediaActions.markAsUnwatched).not.toHaveBeenCalled();
        });

        it("saves progress and closes the player using the latest render's dependencies", async () => {
            const activeMedia = createMediaRow({ id: 66, watched_at: null });

            const options = createDefaultOptions({
                activeMedia,
            });

            const { result, rerender } = renderHook(
                (props: MockOptions) => useHomePlayerActions(props),
                { initialProps: options }
            );

            const newHomeMediaActions = createHomeMediaActions();
            const newClosePlayer = vi.fn<() => void>();

            const nextOptions: MockOptions = {
                ...options,
                homeMediaActions: newHomeMediaActions,
                mediaPlayer: {
                    ...options.mediaPlayer,
                    closePlayer: newClosePlayer,
                },
            };

            rerender(nextOptions);

            await act(async () => {
                await result.current.closePlayer(12.5);
            });

            expect(newHomeMediaActions.saveMediaProgress).toHaveBeenCalledWith(66, 12.5);
            expect(options.homeMediaActions.saveMediaProgress).not.toHaveBeenCalled();
            expect(newClosePlayer).toHaveBeenCalledTimes(1);
            expect(options.mediaPlayer.closePlayer).not.toHaveBeenCalled();
        });
    });
});