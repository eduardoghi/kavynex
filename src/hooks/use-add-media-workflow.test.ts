import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import type { MediaSourceMode, MediaType } from "../types/media";
import { useAddMediaWorkflow } from "./use-add-media-workflow";

vi.mock("../services", () => ({
    cancelMediaDownload: vi.fn(),
    createMedia: vi.fn(),
}));

vi.mock("../utils/error-message", () => ({
    resolveErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

const mockResetForm = vi.fn();
const mockStartRun = vi.fn();
const mockResetYtDlpState = vi.fn();
const mockAppendManualLog = vi.fn();
const mockMarkStopped = vi.fn();
const mockStartManualSession = vi.fn();

type MockAddMediaForm = {
    sourceMode: MediaSourceMode;
    mediaUrl: string;
    title: string;
    mediaPath: string;
    mediaType: MediaType;
    thumbPath: string;
    publishedAt: string;
    downloadComments: boolean;
    downloadLiveChat: boolean;
    cookiesBrowser: string;
    cookiesPath: string;
    isDragging: boolean;
    isThumbDragging: boolean;
    isGeneratingThumb: boolean;
    ytDlpFormats: Array<unknown>;
    selectedYtDlpFormatId: string;
    isLoadingYtDlpFormats: boolean;
    selectedYtDlpMediaType: MediaType;
    setSourceMode: ReturnType<typeof vi.fn>;
    setMediaUrl: ReturnType<typeof vi.fn>;
    setTitle: ReturnType<typeof vi.fn>;
    setPublishedAt: ReturnType<typeof vi.fn>;
    setDownloadComments: ReturnType<typeof vi.fn>;
    setDownloadLiveChat: ReturnType<typeof vi.fn>;
    setCookiesBrowser: ReturnType<typeof vi.fn>;
    setCookiesPath: ReturnType<typeof vi.fn>;
    pickCookiesFileViaDialog: ReturnType<typeof vi.fn>;
    clearCookiesPath: ReturnType<typeof vi.fn>;
    setSelectedYtDlpFormatId: ReturnType<typeof vi.fn>;
    loadYtDlpFormats: ReturnType<typeof vi.fn>;
    pickMediaViaDialog: ReturnType<typeof vi.fn>;
    pickThumbViaDialog: ReturnType<typeof vi.fn>;
    applyDroppedMediaPath: ReturnType<typeof vi.fn>;
    applyDroppedThumbPath: ReturnType<typeof vi.fn>;
    onDropMedia: ReturnType<typeof vi.fn>;
    onDragOverMedia: ReturnType<typeof vi.fn>;
    onDragLeaveMedia: ReturnType<typeof vi.fn>;
    onDropThumb: ReturnType<typeof vi.fn>;
    onDragOverThumb: ReturnType<typeof vi.fn>;
    onDragLeaveThumb: ReturnType<typeof vi.fn>;
    resetForm: ReturnType<typeof vi.fn>;
};

type MockYtDlpEvents = {
    ytDlpLogs: string[];
    isYtDlpRunning: boolean;
    currentRunIdRef: { current: string };
    startRun: ReturnType<typeof vi.fn>;
    startManualSession: ReturnType<typeof vi.fn>;
    appendManualLog: ReturnType<typeof vi.fn>;
    markStopped: ReturnType<typeof vi.fn>;
    resetYtDlpState: ReturnType<typeof vi.fn>;
};

let mockAddMediaForm: MockAddMediaForm;
let mockYtDlpEvents: MockYtDlpEvents;

function createMockAddMediaForm(): MockAddMediaForm {
    return {
        sourceMode: "local",
        mediaUrl: "",
        title: "My media",
        mediaPath: "/tmp/file.mp4",
        mediaType: "video",
        thumbPath: "",
        publishedAt: "",
        downloadComments: true,
        downloadLiveChat: true,
        cookiesBrowser: "",
        cookiesPath: "",
        isDragging: false,
        isThumbDragging: false,
        isGeneratingThumb: false,
        ytDlpFormats: [],
        selectedYtDlpFormatId: "",
        isLoadingYtDlpFormats: false,
        selectedYtDlpMediaType: "video",
        setSourceMode: vi.fn(),
        setMediaUrl: vi.fn(),
        setTitle: vi.fn(),
        setPublishedAt: vi.fn(),
        setDownloadComments: vi.fn(),
        setDownloadLiveChat: vi.fn(),
        setCookiesBrowser: vi.fn(),
        setCookiesPath: vi.fn(),
        pickCookiesFileViaDialog: vi.fn(),
        clearCookiesPath: vi.fn(),
        setSelectedYtDlpFormatId: vi.fn(),
        loadYtDlpFormats: vi.fn(),
        pickMediaViaDialog: vi.fn(),
        pickThumbViaDialog: vi.fn(),
        applyDroppedMediaPath: vi.fn(),
        applyDroppedThumbPath: vi.fn(),
        onDropMedia: vi.fn(),
        onDragOverMedia: vi.fn(),
        onDragLeaveMedia: vi.fn(),
        onDropThumb: vi.fn(),
        onDragOverThumb: vi.fn(),
        onDragLeaveThumb: vi.fn(),
        resetForm: mockResetForm,
    };
}

function createMockYtDlpEvents(): MockYtDlpEvents {
    return {
        ytDlpLogs: [],
        isYtDlpRunning: false,
        currentRunIdRef: { current: "" },
        startRun: mockStartRun,
        startManualSession: mockStartManualSession,
        appendManualLog: mockAppendManualLog,
        markStopped: mockMarkStopped,
        resetYtDlpState: mockResetYtDlpState,
    };
}

vi.mock("./use-add-media-form", () => ({
    useAddMediaForm: () => mockAddMediaForm,
}));

vi.mock("./use-yt-dlp-events", () => ({
    useYtDlpEvents: () => mockYtDlpEvents,
}));

import { createMedia } from "../services";

describe("useAddMediaWorkflow", () => {
    const onError = vi.fn();
    const onReloadMedia = vi.fn();
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        mockResetForm.mockResolvedValue(undefined);
        mockAddMediaForm = createMockAddMediaForm();
        mockYtDlpEvents = createMockYtDlpEvents();
        onReloadMedia.mockResolvedValue(undefined);
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    it("adds local media and reloads list", async () => {
        vi.mocked(createMedia).mockResolvedValue({ id: 1 });

        const { result } = renderHook(() =>
            useAddMediaWorkflow({
                selectedChannelId: 10,
                importMode: "copy",
                libraryPath: "/library",
                onError,
                onReloadMedia,
            })
        );

        await act(async () => {
            await result.current.addMedia();
        });

        expect(createMedia).toHaveBeenCalledWith(
            expect.objectContaining({
                channelId: 10,
                title: "My media",
                sourceMode: "local",
                sourceValue: "/tmp/file.mp4",
                mediaType: "video",
                importMode: "copy",
                libraryPath: "/library",
                publishedAt: null,
                downloadComments: true,
                downloadLiveChat: true,
                cookiesBrowser: null,
            }),
            expect.objectContaining({
                onProgress: expect.any(Function),
            })
        );

        expect(onReloadMedia).toHaveBeenCalledWith(10);
        expect(mockResetForm).toHaveBeenCalled();
        expect(result.current.isAddingMedia).toBe(false);
    });

    it("blocks add when channel is not selected", async () => {
        const { result } = renderHook(() =>
            useAddMediaWorkflow({
                selectedChannelId: null,
                importMode: "copy",
                libraryPath: "/library",
                onError,
                onReloadMedia,
            })
        );

        await act(async () => {
            await result.current.addMedia();
        });

        expect(onError).toHaveBeenCalledWith("Select a channel before adding media.");
        expect(createMedia).not.toHaveBeenCalled();
    });

    it("blocks yt-dlp add when format is not selected", async () => {
        mockAddMediaForm.sourceMode = "yt-dlp";
        mockAddMediaForm.mediaUrl = "https://youtube.com/watch?v=abc";
        mockAddMediaForm.mediaPath = "";
        mockAddMediaForm.selectedYtDlpFormatId = "";

        const { result } = renderHook(() =>
            useAddMediaWorkflow({
                selectedChannelId: 10,
                importMode: "copy",
                libraryPath: "/library",
                onError,
                onReloadMedia,
            })
        );

        await act(async () => {
            await result.current.addMedia();
        });

        expect(onError).toHaveBeenCalledWith(
            "Load the available formats and choose one before continuing."
        );
        expect(createMedia).not.toHaveBeenCalled();
        expect(mockStartRun).not.toHaveBeenCalled();
    });

    it("blocks add while media preparation is still running", async () => {
        mockAddMediaForm.isLoadingYtDlpFormats = true;

        const { result } = renderHook(() =>
            useAddMediaWorkflow({
                selectedChannelId: 10,
                importMode: "copy",
                libraryPath: "/library",
                onError,
                onReloadMedia,
            })
        );

        await act(async () => {
            await result.current.addMedia();
        });

        expect(createMedia).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
    });

    it("uses selected yt-dlp media type when importing from url", async () => {
        vi.mocked(createMedia).mockResolvedValue({ id: 1 });

        mockAddMediaForm.sourceMode = "yt-dlp";
        mockAddMediaForm.mediaUrl = "https://youtube.com/watch?v=abc";
        mockAddMediaForm.mediaPath = "";
        mockAddMediaForm.selectedYtDlpFormatId = "251";
        mockAddMediaForm.selectedYtDlpMediaType = "audio";
        mockAddMediaForm.title = "Remote media";
        mockAddMediaForm.downloadComments = false;
        mockAddMediaForm.downloadLiveChat = true;
        mockAddMediaForm.cookiesBrowser = "edge";

        const { result } = renderHook(() =>
            useAddMediaWorkflow({
                selectedChannelId: 10,
                importMode: "copy",
                libraryPath: "/library",
                onError,
                onReloadMedia,
            })
        );

        await act(async () => {
            await result.current.addMedia();
        });

        expect(createMedia).toHaveBeenCalledWith(
            expect.objectContaining({
                sourceMode: "yt-dlp",
                sourceValue: "https://youtube.com/watch?v=abc",
                ytDlpFormatId: "251",
                mediaType: "audio",
                publishedAt: null,
                downloadComments: false,
                downloadLiveChat: true,
                cookiesBrowser: "edge",
            }),
            expect.objectContaining({
                onProgress: expect.any(Function),
            })
        );

        expect(mockStartRun).toHaveBeenCalled();
        expect(mockAppendManualLog).toHaveBeenCalledWith("Comments: disabled");
        expect(mockAppendManualLog).toHaveBeenCalledWith("Live chat: enabled");
        expect(mockAppendManualLog).toHaveBeenCalledWith("Cookies from browser: edge");
    });

    it("reports add error", async () => {
        vi.mocked(createMedia).mockRejectedValue(new Error("boom"));

        const { result } = renderHook(() =>
            useAddMediaWorkflow({
                selectedChannelId: 10,
                importMode: "copy",
                libraryPath: "/library",
                onError,
                onReloadMedia,
            })
        );

        await act(async () => {
            await result.current.addMedia();
        });

        expect(onError).toHaveBeenCalledWith("Failed to add media.");
        expect(mockMarkStopped).toHaveBeenCalled();
    });

    it("closes add modal with reset", async () => {
        const { result } = renderHook(() =>
            useAddMediaWorkflow({
                selectedChannelId: 10,
                importMode: "copy",
                libraryPath: "/library",
                onError,
                onReloadMedia,
            })
        );

        act(() => {
            result.current.setAddMediaOpen(true);
        });

        await act(async () => {
            await result.current.closeAddMediaModal();
        });

        expect(mockResetForm).toHaveBeenCalled();
        expect(result.current.addMediaOpen).toBe(false);
    });

    it("resets yt-dlp state when modal closes after being open", async () => {
        const { result } = renderHook(() =>
            useAddMediaWorkflow({
                selectedChannelId: 10,
                importMode: "copy",
                libraryPath: "/library",
                onError,
                onReloadMedia,
            })
        );

        act(() => {
            result.current.setAddMediaOpen(true);
        });

        await act(async () => {
            await result.current.closeAddMediaModal();
        });

        expect(mockResetYtDlpState).toHaveBeenCalled();
    });
});