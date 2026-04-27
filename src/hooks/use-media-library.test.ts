import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaLibrary } from "./use-media-library";

const mediaPlayerMock = {
    viewMode: "library" as const,
    activeMedia: null,
    activeIsAudio: false,
    activeSrc: "",
    activeThumbSrc: "",
    activeYoutubeUrl: "",
    canOpenInYoutube: false,
    activeIsWatched: false,
    openPlayer: vi.fn(),
    setActiveMedia: vi.fn(),
    closePlayer: vi.fn(),
    openInYoutube: vi.fn(),
};

vi.mock("./use-media-player", () => ({
    useMediaPlayer: () => mediaPlayerMock,
}));

vi.mock("./use-channel-media-list", () => ({
    useChannelMediaList: () => ({
        mediaItems: [],
        isLoadingMedia: false,
        setMediaItems: vi.fn(),
        loadMedia: vi.fn(),
        clearMedia: vi.fn(),
    }),
}));

vi.mock("./use-media-actions", () => ({
    useMediaActions: () => ({
        confirmDeleteMediaOpen: false,
        mediaToDelete: null,
        isDeletingMedia: false,
        isUpdatingWatched: false,
        requestDeleteMedia: vi.fn(),
        confirmDeleteMedia: vi.fn(),
        closeDeleteMediaModal: vi.fn(),
        markAsWatched: vi.fn(),
        markAsUnwatched: vi.fn(),
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

describe("useMediaLibrary", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns orchestrated state", () => {
        const { result } = renderHook(() =>
            useMediaLibrary({
                selectedChannelId: 10,
                importMode: "copy",
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        expect(result.current.mediaItems).toEqual([]);
        expect(result.current.isLoadingMedia).toBe(false);
        expect(result.current.mediaPlayer).toBe(mediaPlayerMock);
        expect(typeof result.current.addMedia).toBe("function");
        expect(typeof result.current.markAsWatched).toBe("function");
        expect(typeof result.current.requestDeleteMedia).toBe("function");
    });
});