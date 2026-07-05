import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaPlayer } from "./use-media-player";
import type { MediaRow } from "../types/media";

vi.mock("../utils/media-utils", () => ({
    resolveStoredPath: vi.fn((storedPath: string | null, libraryPath: string) => {
        if (!storedPath) {
            return null;
        }

        return `${libraryPath}/${storedPath}`;
    }),
    fileSrcFromAbsolutePath: vi.fn((path: string | null) => (path ? `file://${path}` : "")),
}));

vi.mock("../services/library-service", () => ({
    openExternalUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { openExternalUrl } from "../services/library-service";
import { logError } from "../utils/app-logger";

function createMediaRow(overrides: Partial<MediaRow> = {}): MediaRow {
    return {
        id: 10,
        channel_id: 1,
        title: "Video A",
        file_path: "video/a.mp4",
        thumbnail_path: null,
        media_type: "video",
        youtube_video_id: null,
        watched_at: null,
        published_at: null,
        duration_seconds: 120,
        progress_seconds: 0,
        has_comments: 0,
        comments_count: 0,
        is_live: 0,
        has_live_chat: 0,
        live_chat_file_path: null,
        created_at: "2026-03-31T10:00:00.000Z",
        ...overrides,
    };
}

describe("useMediaPlayer", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("starts in library mode with no active media", () => {
        const { result } = renderHook(() =>
            useMediaPlayer({
                libraryPath: "/library",
            })
        );

        expect(result.current.viewMode).toBe("library");
        expect(result.current.activeMedia).toBeNull();
        expect(result.current.activeIsAudio).toBe(false);
        expect(result.current.activeSrc).toBe("");
        expect(result.current.activeThumbSrc).toBe("");
        expect(result.current.activeYoutubeUrl).toBe("");
        expect(result.current.canOpenInYoutube).toBe(false);
        expect(result.current.activeIsWatched).toBe(false);
    });

    it("opens player with video media", () => {
        const media = createMediaRow({
            id: 10,
            title: "Video A",
            file_path: "video/a.mp4",
            thumbnail_path: "thumbnails/a.jpg",
            media_type: "video",
            youtube_video_id: "abc123",
            watched_at: null,
            duration_seconds: 120,
        });

        const { result } = renderHook(() =>
            useMediaPlayer({
                libraryPath: "/library",
            })
        );

        act(() => {
            result.current.openPlayer(media);
        });

        expect(result.current.viewMode).toBe("player");
        expect(result.current.activeMedia).toEqual(media);
        expect(result.current.activeIsAudio).toBe(false);
        expect(result.current.activeSrc).toBe("file:///library/video/a.mp4");
        expect(result.current.activeThumbSrc).toBe("file:///library/thumbnails/a.jpg");
        expect(result.current.activeYoutubeUrl).toBe("https://www.youtube.com/watch?v=abc123");
        expect(result.current.canOpenInYoutube).toBe(true);
        expect(result.current.activeIsWatched).toBe(false);
    });

    it("opens player with audio media", () => {
        const media = createMediaRow({
            id: 20,
            title: "Audio A",
            file_path: "audio/a.mp3",
            thumbnail_path: null,
            media_type: "audio",
            youtube_video_id: null,
            watched_at: "2026-03-31T11:00:00.000Z",
            duration_seconds: 240,
        });

        const { result } = renderHook(() =>
            useMediaPlayer({
                libraryPath: "/library",
            })
        );

        act(() => {
            result.current.openPlayer(media);
        });

        expect(result.current.viewMode).toBe("player");
        expect(result.current.activeIsAudio).toBe(true);
        expect(result.current.activeSrc).toBe("file:///library/audio/a.mp3");
        expect(result.current.activeThumbSrc).toBe("");
        expect(result.current.canOpenInYoutube).toBe(false);
        expect(result.current.activeIsWatched).toBe(true);
    });

    it("updates active media without changing view mode", () => {
        const media = createMediaRow({
            id: 30,
            title: "Video B",
            file_path: "video/b.mp4",
            thumbnail_path: null,
            media_type: "video",
            youtube_video_id: null,
            duration_seconds: 300,
        });

        const { result } = renderHook(() =>
            useMediaPlayer({
                libraryPath: "/library",
            })
        );

        act(() => {
            result.current.setActiveMedia(media);
        });

        expect(result.current.activeMedia).toEqual(media);
        expect(result.current.viewMode).toBe("library");
    });

    it("closes player and clears active state", () => {
        const media = createMediaRow({
            id: 40,
            title: "Video C",
            file_path: "video/c.mp4",
            thumbnail_path: null,
            media_type: "video",
            youtube_video_id: "xyz999",
            duration_seconds: 180,
        });

        const { result } = renderHook(() =>
            useMediaPlayer({
                libraryPath: "/library",
            })
        );

        act(() => {
            result.current.openPlayer(media);
        });

        act(() => {
            result.current.closePlayer();
        });

        expect(result.current.viewMode).toBe("library");
        expect(result.current.activeMedia).toBeNull();
        expect(result.current.activeSrc).toBe("");
        expect(result.current.activeThumbSrc).toBe("");
        expect(result.current.activeYoutubeUrl).toBe("");
        expect(result.current.canOpenInYoutube).toBe(false);
    });

    it("opens youtube when active youtube url exists", async () => {
        const media = createMediaRow({
            id: 50,
            title: "Video D",
            file_path: "video/d.mp4",
            thumbnail_path: null,
            media_type: "video",
            youtube_video_id: "yt-777",
            duration_seconds: 95,
        });

        const { result } = renderHook(() =>
            useMediaPlayer({
                libraryPath: "/library",
            })
        );

        act(() => {
            result.current.openPlayer(media);
        });

        await act(async () => {
            await result.current.openInYoutube();
        });

        expect(openExternalUrl).toHaveBeenCalledWith(
            "https://www.youtube.com/watch?v=yt-777"
        );
    });

    it("does nothing when youtube url does not exist", async () => {
        const { result } = renderHook(() =>
            useMediaPlayer({
                libraryPath: "/library",
            })
        );

        await act(async () => {
            await result.current.openInYoutube();
        });

        expect(openExternalUrl).not.toHaveBeenCalled();
    });

    it("swallows youtube open error and logs it", async () => {
        vi.mocked(openExternalUrl).mockRejectedValueOnce(new Error("boom"));

        const media = createMediaRow({
            id: 60,
            title: "Video E",
            file_path: "video/e.mp4",
            thumbnail_path: null,
            media_type: "video",
            youtube_video_id: "yt-999",
            duration_seconds: 210,
        });

        const { result } = renderHook(() =>
            useMediaPlayer({
                libraryPath: "/library",
            })
        );

        act(() => {
            result.current.openPlayer(media);
        });

        await act(async () => {
            await result.current.openInYoutube();
        });

        expect(logError).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(String),
            expect.any(Error),
            { mediaId: media.id, url: "https://www.youtube.com/watch?v=yt-999" }
        );
    });

    it("trims the youtube video id before building the watch url", () => {
        const media = createMediaRow({
            id: 70,
            title: "Video F",
            file_path: "video/f.mp4",
            thumbnail_path: null,
            media_type: "video",
            youtube_video_id: "  abc123  ",
            duration_seconds: 60,
        });

        const { result } = renderHook(() =>
            useMediaPlayer({
                libraryPath: "/library",
            })
        );

        act(() => {
            result.current.openPlayer(media);
        });

        expect(result.current.activeYoutubeUrl).toBe(
            "https://www.youtube.com/watch?v=abc123"
        );
        expect(result.current.canOpenInYoutube).toBe(true);
    });

    it("treats a whitespace-only watched_at as not watched", () => {
        const media = createMediaRow({
            id: 80,
            title: "Video G",
            file_path: "video/g.mp4",
            thumbnail_path: null,
            media_type: "video",
            youtube_video_id: null,
            watched_at: "   ",
            duration_seconds: 60,
        });

        const { result } = renderHook(() =>
            useMediaPlayer({
                libraryPath: "/library",
            })
        );

        act(() => {
            result.current.openPlayer(media);
        });

        expect(result.current.activeIsWatched).toBe(false);
    });
});