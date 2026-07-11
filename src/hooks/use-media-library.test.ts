import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaRow } from "../types/media";
import { useMediaLibrary } from "./use-media-library";
import { saveMediaProgress as persistMediaProgress } from "../services/media-service";
import { listChannelMedia } from "../services";

// useChannelMediaList and useMediaPlayer are exercised for real (not mocked) below, so the
// dependency-array mutants in useMediaLibrary's own useCallback/useEffect blocks can be
// observed through real state transitions instead of static, shallow return values.
vi.mock("@tauri-apps/api/core", () => ({
    convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

vi.mock("../services/media-service", () => ({
    saveMediaProgress: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services", () => ({
    listChannelMedia: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/library-service", () => ({
    openExternalUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./use-media-actions", () => ({
    useMediaActions: () => ({
        confirmDeleteMediaOpen: false,
        mediaToDelete: null,
        isDeletingMedia: false,
        isUpdatingWatched: false,
        isRefreshingComments: false,
        isUpdatingTitle: false,
        requestDeleteMedia: vi.fn(),
        confirmDeleteMedia: vi.fn(),
        closeDeleteMediaModal: vi.fn(),
        markAsWatched: vi.fn(),
        markAsUnwatched: vi.fn(),
        refreshComments: vi.fn(),
        editTitle: vi.fn(),
        openMediaFileLocation: vi.fn(),
        openMediaSourceInYoutube: vi.fn(),
    }),
}));

vi.mock("./use-add-media-workflow", () => ({
    useAddMediaWorkflow: () => ({
        addMediaOpen: false,
        setAddMediaOpen: vi.fn(),
        closeAddMediaModal: vi.fn(),
        isAddingMedia: false,
        isCancellingYtDlp: false,
        ytDlpLogs: [],
        isYtDlpRunning: false,
        addMediaForm: {
            isGeneratingThumb: false,
            isLoadingYtDlpFormats: false,
            resetForm: vi.fn(),
        },
        addMedia: vi.fn(),
        cancelYtDlpDownload: vi.fn(),
    }),
}));

const listChannelMediaMock = vi.mocked(listChannelMedia);
const persistMediaProgressMock = vi.mocked(persistMediaProgress);

function createMediaRow(overrides: Partial<MediaRow> = {}): MediaRow {
    return {
        id: 1,
        channel_id: 10,
        title: "Video A",
        file_path: "video/a.mp4",
        thumbnail_path: "thumbnails/a.jpg",
        media_type: "video",
        youtube_video_id: "abc123",
        watched_at: null,
        published_at: "2026-03-31",
        duration_seconds: 125,
        progress_seconds: 0,
        created_at: "2026-03-31T10:00:00.000Z",
        has_comments: 0,
        comments_count: 0,
        is_live: 0,
        has_live_chat: 0,
        live_chat_file_path: null,
        ...overrides,
    };
}

// A single stable onError reference is required: useChannelMediaList's real loadMedia
// callback depends on it, so a fresh vi.fn() per render would recreate loadMedia every
// render and, combined with useMediaLibrary's own effect depending on loadMedia, would
// spin into an infinite render loop.
const onErrorMock = vi.fn();
const onNoticeMock = vi.fn();

function renderMediaLibrary(selectedChannelId: number | null) {
    return renderHook(
        (props: { selectedChannelId: number | null }) =>
            useMediaLibrary({
                selectedChannelId: props.selectedChannelId,
                importMode: "copy",
                libraryPath: "/library",
                onError: onErrorMock,
                onNotice: onNoticeMock,
            }),
        { initialProps: { selectedChannelId } }
    );
}

describe("useMediaLibrary", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listChannelMediaMock.mockResolvedValue([]);
        persistMediaProgressMock.mockResolvedValue(undefined);
    });

    it("threads through the mocked collaborator hooks", () => {
        const { result } = renderMediaLibrary(null);

        expect(result.current.addMediaOpen).toBe(false);
        expect(result.current.confirmDeleteMediaOpen).toBe(false);
        expect(typeof result.current.markAsWatched).toBe("function");
        expect(typeof result.current.requestDeleteMedia).toBe("function");
    });

    it("loads media for the initial selected channel on mount", async () => {
        listChannelMediaMock.mockResolvedValueOnce([createMediaRow({ id: 1 })]);

        const { result } = renderMediaLibrary(7);

        await waitFor(() => {
            expect(listChannelMediaMock).toHaveBeenCalledWith(7);
        });

        await waitFor(() => {
            expect(result.current.mediaItems).toEqual([createMediaRow({ id: 1 })]);
        });
    });

    it("clears media when there is no selected channel", async () => {
        const { result } = renderMediaLibrary(null);

        await waitFor(() => {
            expect(result.current.isLoadingMedia).toBe(false);
        });

        expect(listChannelMediaMock).not.toHaveBeenCalled();
        expect(result.current.mediaItems).toEqual([]);
    });

    it("reloads media when selectedChannelId changes across a re-render", async () => {
        const { result, rerender } = renderMediaLibrary(null);

        await waitFor(() => {
            expect(result.current.isLoadingMedia).toBe(false);
        });

        expect(listChannelMediaMock).not.toHaveBeenCalled();

        listChannelMediaMock.mockResolvedValueOnce([createMediaRow({ id: 99 })]);

        rerender({ selectedChannelId: 42 });

        await waitFor(() => {
            expect(listChannelMediaMock).toHaveBeenCalledWith(42);
        });

        await waitFor(() => {
            expect(result.current.mediaItems).toEqual([createMediaRow({ id: 99 })]);
        });
    });

    it("saves media progress, flooring the value and updating only the matching item", async () => {
        listChannelMediaMock.mockResolvedValueOnce([
            createMediaRow({ id: 1, progress_seconds: 0 }),
            createMediaRow({ id: 2, progress_seconds: 50 }),
        ]);

        const { result } = renderMediaLibrary(7);

        await waitFor(() => {
            expect(result.current.mediaItems).toHaveLength(2);
        });

        await act(async () => {
            await result.current.saveMediaProgress(1, 42.9);
        });

        expect(persistMediaProgressMock).toHaveBeenCalledWith(1, 42.9);
        expect(result.current.mediaItems).toEqual([
            expect.objectContaining({ id: 1, progress_seconds: 42 }),
            expect.objectContaining({ id: 2, progress_seconds: 50 }),
        ]);
    });

    it("clamps negative progress seconds to zero", async () => {
        listChannelMediaMock.mockResolvedValueOnce([
            createMediaRow({ id: 1, progress_seconds: 10 }),
        ]);

        const { result } = renderMediaLibrary(7);

        await waitFor(() => {
            expect(result.current.mediaItems).toHaveLength(1);
        });

        await act(async () => {
            await result.current.saveMediaProgress(1, -5);
        });

        expect(result.current.mediaItems[0].progress_seconds).toBe(0);
    });

    it("updates the active media's progress when it matches the saved media id", async () => {
        const { result } = renderMediaLibrary(null);

        act(() => {
            result.current.mediaPlayer.openPlayer(
                createMediaRow({ id: 5, progress_seconds: 0 })
            );
        });

        await act(async () => {
            await result.current.saveMediaProgress(5, 33);
        });

        expect(result.current.mediaPlayer.activeMedia?.progress_seconds).toBe(33);
    });

    it("keeps saveMediaProgress stable across a save so the player throttle is not reset", async () => {
        const { result } = renderMediaLibrary(null);

        act(() => {
            result.current.mediaPlayer.openPlayer(
                createMediaRow({ id: 5, progress_seconds: 0 })
            );
        });

        const before = result.current.saveMediaProgress;

        await act(async () => {
            await result.current.saveMediaProgress(5, 33);
        });

        // The save updates the active media's progress. Previously that recreated
        // saveMediaProgress (it depended on the whole mediaPlayer object), which cascaded into
        // the player's persistProgress and made its timeupdate effect re-run, resetting the 10s
        // throttle clock on every save. The reference must now survive the save.
        expect(result.current.mediaPlayer.activeMedia?.progress_seconds).toBe(33);
        expect(result.current.saveMediaProgress).toBe(before);
    });

    it("does not touch active media progress when the saved media id does not match", async () => {
        const { result } = renderMediaLibrary(null);

        act(() => {
            result.current.mediaPlayer.openPlayer(
                createMediaRow({ id: 5, progress_seconds: 0 })
            );
        });

        await act(async () => {
            await result.current.saveMediaProgress(999, 33);
        });

        expect(result.current.mediaPlayer.activeMedia?.progress_seconds).toBe(0);
    });

    it("clears the media list and closes the player", () => {
        const { result } = renderMediaLibrary(null);

        act(() => {
            result.current.mediaPlayer.openPlayer(createMediaRow({ id: 5 }));
        });

        expect(result.current.mediaPlayer.activeMedia).not.toBeNull();

        act(() => {
            result.current.clearMediaAndPlayer();
        });

        expect(result.current.mediaPlayer.activeMedia).toBeNull();
        expect(result.current.mediaItems).toEqual([]);
    });

    it("recreates clearMediaAndPlayer when the media player object changes across renders", () => {
        const { result } = renderMediaLibrary(null);

        const firstClear = result.current.clearMediaAndPlayer;

        act(() => {
            result.current.mediaPlayer.openPlayer(createMediaRow({ id: 1 }));
        });

        const secondClear = result.current.clearMediaAndPlayer;

        expect(secondClear).not.toBe(firstClear);
    });
});
