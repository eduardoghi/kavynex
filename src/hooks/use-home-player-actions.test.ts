import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MediaRow } from "../types/media";
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
});