import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MediaRow } from "../types/media";
import { useChannelMediaList } from "./use-channel-media-list";

vi.mock("../services", () => ({
    listChannelMedia: vi.fn(),
}));

vi.mock("../utils/error-message", () => ({
    resolveErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { listChannelMedia } from "../services";
import { logError } from "../utils/app-logger";

function createMediaRow(overrides: Partial<MediaRow> = {}): MediaRow {
    return {
        id: 1,
        channel_id: 10,
        title: "Item 1",
        file_path: "media/item-1.mp4",
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
        created_at: "2026-03-29T10:00:00.000Z",
        ...overrides,
    };
}

describe("useChannelMediaList", () => {
    const onError = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("loads media for the selected channel", async () => {
        vi.mocked(listChannelMedia).mockResolvedValue([
            createMediaRow({
                id: 1,
                channel_id: 10,
                title: "Item 1",
                file_path: "media/item-1.mp4",
            }),
        ]);

        const { result } = renderHook(() =>
            useChannelMediaList({
                selectedChannelId: 10,
                onError,
            })
        );

        await act(async () => {
            await result.current.loadMedia();
        });

        expect(listChannelMedia).toHaveBeenCalledWith(10);
        expect(result.current.mediaItems).toHaveLength(1);
        expect(result.current.mediaItems[0]?.title).toBe("Item 1");
        expect(result.current.isLoadingMedia).toBe(false);
        expect(onError).not.toHaveBeenCalled();
    });

    it("clears media when channel is null", async () => {
        const { result } = renderHook(() =>
            useChannelMediaList({
                selectedChannelId: null,
                onError,
            })
        );

        await act(async () => {
            await result.current.loadMedia(null);
        });

        expect(result.current.mediaItems).toEqual([]);
        expect(result.current.isLoadingMedia).toBe(false);
        expect(listChannelMedia).not.toHaveBeenCalled();
    });

    it("reports load error", async () => {
        vi.mocked(listChannelMedia).mockRejectedValue(new Error("boom"));

        const { result } = renderHook(() =>
            useChannelMediaList({
                selectedChannelId: 10,
                onError,
            })
        );

        await act(async () => {
            await result.current.loadMedia();
        });

        expect(onError).toHaveBeenCalledWith("Failed to load channel media.");
        expect(result.current.mediaItems).toEqual([]);
        expect(result.current.isLoadingMedia).toBe(false);
        expect(logError).toHaveBeenCalledWith(
            "media-list",
            "Failed to load channel media.",
            expect.any(Error),
            {
                channelId: 10,
            }
        );
    });

    it("clears media explicitly", () => {
        const { result } = renderHook(() =>
            useChannelMediaList({
                selectedChannelId: 10,
                onError,
            })
        );

        act(() => {
            result.current.setMediaItems([
                createMediaRow({
                    id: 1,
                    channel_id: 10,
                    title: "Item 1",
                    file_path: "media/item-1.mp4",
                }),
            ]);
        });

        act(() => {
            result.current.clearMedia();
        });

        expect(result.current.mediaItems).toEqual([]);
        expect(result.current.isLoadingMedia).toBe(false);
    });

    it("ignores stale result after clearMedia", async () => {
        let resolveFirst: ((value: MediaRow[]) => void) | null = null;

        vi.mocked(listChannelMedia).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveFirst = resolve;
                })
        );

        const { result } = renderHook(() =>
            useChannelMediaList({
                selectedChannelId: 10,
                onError,
            })
        );

        await act(async () => {
            void result.current.loadMedia(10);
        });

        act(() => {
            result.current.clearMedia();
        });

        await act(async () => {
            resolveFirst?.([
                createMediaRow({
                    id: 1,
                    channel_id: 10,
                    title: "Stale",
                    file_path: "media/item-1.mp4",
                }),
            ]);
        });

        await waitFor(() => {
            expect(result.current.mediaItems).toEqual([]);
        });
    });

    it("keeps only the latest request result when switching channels quickly", async () => {
        let resolveFirst: ((value: MediaRow[]) => void) | null = null;
        let resolveSecond: ((value: MediaRow[]) => void) | null = null;

        vi.mocked(listChannelMedia)
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveFirst = resolve;
                    })
            )
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveSecond = resolve;
                    })
            );

        const { result } = renderHook(() =>
            useChannelMediaList({
                selectedChannelId: 10,
                onError,
            })
        );

        await act(async () => {
            void result.current.loadMedia(10);
        });

        await act(async () => {
            void result.current.loadMedia(20);
        });

        await act(async () => {
            resolveSecond?.([
                createMediaRow({
                    id: 2,
                    channel_id: 20,
                    title: "Channel 20 item",
                    file_path: "media/item-20.mp4",
                }),
            ]);
        });

        await waitFor(() => {
            expect(result.current.mediaItems).toHaveLength(1);
            expect(result.current.mediaItems[0]?.channel_id).toBe(20);
        });

        await act(async () => {
            resolveFirst?.([
                createMediaRow({
                    id: 1,
                    channel_id: 10,
                    title: "Stale channel 10 item",
                    file_path: "media/item-10.mp4",
                }),
            ]);
        });

        expect(result.current.mediaItems).toHaveLength(1);
        expect(result.current.mediaItems[0]?.channel_id).toBe(20);
        expect(result.current.isLoadingMedia).toBe(false);
    });

    it("starts without loading media", () => {
        const { result } = renderHook(() =>
            useChannelMediaList({
                selectedChannelId: 10,
                onError,
            })
        );

        expect(result.current.isLoadingMedia).toBe(false);
        expect(result.current.mediaItems).toEqual([]);
    });

    it("keeps the latest load result when an old load resolves after clearMedia and a reload", async () => {
        let resolveFirst: ((value: MediaRow[]) => void) | null = null;
        let resolveSecond: ((value: MediaRow[]) => void) | null = null;

        vi.mocked(listChannelMedia)
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveFirst = resolve;
                    })
            )
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveSecond = resolve;
                    })
            );

        const { result } = renderHook(() =>
            useChannelMediaList({
                selectedChannelId: 10,
                onError,
            })
        );

        await act(async () => {
            void result.current.loadMedia(10);
        });

        act(() => {
            result.current.clearMedia();
        });

        await act(async () => {
            void result.current.loadMedia(10);
        });

        await act(async () => {
            resolveSecond?.([
                createMediaRow({
                    id: 2,
                    channel_id: 10,
                    title: "Fresh",
                    file_path: "media/item-2.mp4",
                }),
            ]);
        });

        await waitFor(() => {
            expect(result.current.mediaItems).toHaveLength(1);
            expect(result.current.mediaItems[0]?.title).toBe("Fresh");
        });

        await act(async () => {
            resolveFirst?.([
                createMediaRow({
                    id: 1,
                    channel_id: 10,
                    title: "Stale-old",
                    file_path: "media/item-1.mp4",
                }),
            ]);
        });

        expect(result.current.mediaItems).toHaveLength(1);
        expect(result.current.mediaItems[0]?.title).toBe("Fresh");
    });

    it("uses the explicit channelId argument even when it differs from selectedChannelId", async () => {
        vi.mocked(listChannelMedia).mockResolvedValueOnce([]);

        const { result } = renderHook(() =>
            useChannelMediaList({
                selectedChannelId: 10,
                onError,
            })
        );

        await act(async () => {
            await result.current.loadMedia(999);
        });

        expect(listChannelMedia).toHaveBeenCalledWith(999);
    });

    it("clears media immediately when switching to a different channel", async () => {
        vi.mocked(listChannelMedia).mockResolvedValueOnce([
            createMediaRow({
                id: 1,
                channel_id: 10,
                title: "Item 1",
                file_path: "media/item-1.mp4",
            }),
        ]);

        const { result } = renderHook(() =>
            useChannelMediaList({
                selectedChannelId: 10,
                onError,
            })
        );

        await act(async () => {
            await result.current.loadMedia(10);
        });

        expect(result.current.mediaItems).toHaveLength(1);

        let resolveNext: ((value: MediaRow[]) => void) | null = null;

        vi.mocked(listChannelMedia).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveNext = resolve;
                })
        );

        act(() => {
            void result.current.loadMedia(20);
        });

        expect(result.current.mediaItems).toEqual([]);

        await act(async () => {
            resolveNext?.([]);
        });
    });

    it("keeps existing media visible while reloading the same channel", async () => {
        vi.mocked(listChannelMedia).mockResolvedValueOnce([
            createMediaRow({
                id: 1,
                channel_id: 10,
                title: "Item 1",
                file_path: "media/item-1.mp4",
            }),
        ]);

        const { result } = renderHook(() =>
            useChannelMediaList({
                selectedChannelId: 10,
                onError,
            })
        );

        await act(async () => {
            await result.current.loadMedia(10);
        });

        expect(result.current.mediaItems).toHaveLength(1);

        let resolveNext: ((value: MediaRow[]) => void) | null = null;

        vi.mocked(listChannelMedia).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveNext = resolve;
                })
        );

        act(() => {
            void result.current.loadMedia(10);
        });

        expect(result.current.mediaItems).toHaveLength(1);
        expect(result.current.mediaItems[0]?.title).toBe("Item 1");

        await act(async () => {
            resolveNext?.([]);
        });
    });

    it("ignores a stale error after a newer load has already succeeded", async () => {
        let rejectFirst: ((error: Error) => void) | null = null;

        vi.mocked(listChannelMedia)
            .mockImplementationOnce(
                () =>
                    new Promise((_resolve, reject) => {
                        rejectFirst = reject;
                    })
            )
            .mockResolvedValueOnce([
                createMediaRow({
                    id: 2,
                    channel_id: 20,
                    title: "Channel 20 item",
                    file_path: "media/item-20.mp4",
                }),
            ]);

        const { result } = renderHook(() =>
            useChannelMediaList({
                selectedChannelId: 10,
                onError,
            })
        );

        await act(async () => {
            void result.current.loadMedia(10);
        });

        await act(async () => {
            await result.current.loadMedia(20);
        });

        expect(result.current.mediaItems).toHaveLength(1);
        expect(result.current.mediaItems[0]?.channel_id).toBe(20);

        await act(async () => {
            rejectFirst?.(new Error("boom"));
        });

        expect(onError).not.toHaveBeenCalled();
        expect(result.current.mediaItems).toHaveLength(1);
        expect(result.current.mediaItems[0]?.channel_id).toBe(20);
    });

    it("uses the updated selectedChannelId dependency after a rerender", async () => {
        vi.mocked(listChannelMedia).mockResolvedValue([]);

        const { result, rerender } = renderHook(
            (props: { selectedChannelId: number | null }) =>
                useChannelMediaList({
                    selectedChannelId: props.selectedChannelId,
                    onError,
                }),
            { initialProps: { selectedChannelId: 10 } }
        );

        rerender({ selectedChannelId: 20 });

        await act(async () => {
            await result.current.loadMedia();
        });

        expect(listChannelMedia).toHaveBeenCalledWith(20);
    });
});