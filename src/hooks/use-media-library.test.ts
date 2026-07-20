import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaRow } from "../types/media";
import type { MediaPage } from "../types/generated/MediaPage";
import { useMediaLibrary } from "./use-media-library";
import { saveMediaProgress as persistMediaProgress } from "../services/media-service";
import { listChannelMediaPage } from "../services";
import { DEFAULT_MEDIA_QUERY_FILTERS } from "../utils/media-library-filters";

// useChannelMediaList and useMediaPlayer are exercised for real (not mocked) below, so the
// dependency-array mutants in useMediaLibrary's own useCallback/useEffect blocks can be
// observed through real state transitions instead of static, shallow return values.
vi.mock("../lib/tauri-platform", () => ({
    convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

vi.mock("../services/media-service", () => ({
    saveMediaProgress: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services", () => ({
    listChannelMediaPage: vi.fn().mockResolvedValue({ items: [], total: 0 }),
}));

vi.mock("../services/library-service", () => ({
    openExternalUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./use-media-actions", () => ({
    useMediaActions: () => ({
        confirmDeleteMediaOpen: false,
        mediaToDelete: null,
        isDeletingMedia: false,
        commentsInFlight: new Set<number>(),
        watchedActionInFlight: new Set<number>(),
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

const listMediaPageMock = vi.mocked(listChannelMediaPage);
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

function page(items: MediaRow[], total = items.length): MediaPage {
    return { items, total };
}

// A single stable onError reference is required: useChannelMediaList's real applyQuery
// callback depends on it, so a fresh vi.fn() per render would recreate applyQuery every
// render.
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

// The library section drives the actual load; in these hook-level tests we call applyMediaQuery
// directly (the same thing the section's effect does) to populate the media list.
async function loadInto(
    result: { current: ReturnType<typeof useMediaLibrary> },
    items: MediaRow[],
    total = items.length
): Promise<void> {
    listMediaPageMock.mockResolvedValueOnce(page(items, total));

    await act(async () => {
        await result.current.applyMediaQuery(DEFAULT_MEDIA_QUERY_FILTERS);
    });

    await waitFor(() => {
        expect(result.current.mediaItems).toHaveLength(items.length);
    });
}

describe("useMediaLibrary", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listMediaPageMock.mockResolvedValue({ items: [], total: 0 });
        persistMediaProgressMock.mockResolvedValue(undefined);
    });

    it("threads through the mocked collaborator hooks", () => {
        const { result } = renderMediaLibrary(null);

        expect(result.current.addMediaOpen).toBe(false);
        expect(result.current.confirmDeleteMediaOpen).toBe(false);
        expect(typeof result.current.markAsWatched).toBe("function");
        expect(typeof result.current.requestDeleteMedia).toBe("function");
    });

    it("loads a page for the selected channel when a query is applied", async () => {
        const { result } = renderMediaLibrary(7);

        await loadInto(result, [createMediaRow({ id: 1 })], 1);

        expect(listMediaPageMock).toHaveBeenCalledWith(
            7,
            expect.objectContaining({ offset: 0 })
        );
        expect(result.current.mediaItems).toEqual([createMediaRow({ id: 1 })]);
        expect(result.current.mediaTotal).toBe(1);
        expect(result.current.channelMediaTotal).toBe(1);
    });

    it("does not query and stays empty while there is no selected channel", async () => {
        const { result } = renderMediaLibrary(null);

        await act(async () => {
            await result.current.applyMediaQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        expect(listMediaPageMock).not.toHaveBeenCalled();
        expect(result.current.mediaItems).toEqual([]);
    });

    it("queries the updated channel after selectedChannelId changes across a re-render", async () => {
        const { result, rerender } = renderMediaLibrary(null);

        rerender({ selectedChannelId: 42 });

        listMediaPageMock.mockResolvedValueOnce(page([createMediaRow({ id: 99 })], 1));

        await act(async () => {
            await result.current.applyMediaQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });

        expect(listMediaPageMock).toHaveBeenCalledWith(
            42,
            expect.objectContaining({ offset: 0 })
        );

        await waitFor(() => {
            expect(result.current.mediaItems).toEqual([createMediaRow({ id: 99 })]);
        });
    });

    it("saves media progress, flooring the value and updating only the matching item", async () => {
        const { result } = renderMediaLibrary(7);

        await loadInto(result, [
            createMediaRow({ id: 1, progress_seconds: 0 }),
            createMediaRow({ id: 2, progress_seconds: 50 }),
        ]);

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
        const { result } = renderMediaLibrary(7);

        await loadInto(result, [createMediaRow({ id: 1, progress_seconds: 10 })]);

        await act(async () => {
            await result.current.saveMediaProgress(1, -5);
        });

        expect(result.current.mediaItems[0]!.progress_seconds).toBe(0);
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

    it("defers the playing media's list update until the player closes, then reconciles it", async () => {
        const { result } = renderMediaLibrary(7);

        await loadInto(result, [
            createMediaRow({ id: 5, progress_seconds: 0 }),
            createMediaRow({ id: 6, progress_seconds: 12 }),
        ]);

        act(() => {
            result.current.mediaPlayer.openPlayer(result.current.mediaItems[0]!);
        });

        const listBeforeSave = result.current.mediaItems;

        await act(async () => {
            await result.current.saveMediaProgress(5, 90);
        });

        // The active media reflects the save immediately (its progress is read on reopen)...
        expect(result.current.mediaPlayer.activeMedia?.progress_seconds).toBe(90);
        // ...but the media-list array keeps its identity during playback, so the hidden library
        // grid is not retriggered on every periodic save.
        expect(result.current.mediaItems).toBe(listBeforeSave);
        expect(result.current.mediaItems[0]!.progress_seconds).toBe(0);

        // Closing the player reconciles the stashed progress into the list in one pass.
        act(() => {
            result.current.mediaPlayer.closePlayer();
        });

        expect(result.current.mediaItems[0]!.progress_seconds).toBe(90);
        // The media that was not playing is untouched.
        expect(result.current.mediaItems[1]!.progress_seconds).toBe(12);
    });

    it("does not resurrect progress on a watched item when flushing on close", async () => {
        const { result } = renderMediaLibrary(7);

        await loadInto(result, [
            createMediaRow({
                id: 5,
                progress_seconds: 0,
                watched_at: "2026-01-01T00:00:00.000Z",
            }),
        ]);

        act(() => {
            result.current.mediaPlayer.openPlayer(result.current.mediaItems[0]!);
        });

        await act(async () => {
            await result.current.saveMediaProgress(5, 90);
        });

        act(() => {
            result.current.mediaPlayer.closePlayer();
        });

        // A watched media stays at 0; the deferred 90s position is discarded on flush.
        expect(result.current.mediaItems[0]!.progress_seconds).toBe(0);
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
