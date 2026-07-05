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

type UseAddMediaFormOptionsArg = {
    onError?: (message: string) => void;
    ytDlpTerminal?: {
        startManualSession: (runId: string, header: string) => void;
        appendManualLog: (line: string) => void;
        markStopped: () => void;
        resetYtDlpState: (clearLogs?: boolean) => void;
    };
};

const mockUseAddMediaForm = vi.fn((_options: UseAddMediaFormOptionsArg) => mockAddMediaForm);

function latestUseAddMediaFormOptions(): UseAddMediaFormOptionsArg {
    const calls = mockUseAddMediaForm.mock.calls;
    return calls[calls.length - 1][0];
}

vi.mock("./use-add-media-form", () => ({
    useAddMediaForm: (options: UseAddMediaFormOptionsArg) => mockUseAddMediaForm(options),
}));

vi.mock("./use-yt-dlp-events", () => ({
    useYtDlpEvents: () => mockYtDlpEvents,
}));

import { createMedia, cancelMediaDownload } from "../services";
import { logError } from "../utils/app-logger";

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

        act(() => {
            result.current.setAddMediaOpen(true);
        });

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
                thumbnailSourcePath: null,
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
        expect(result.current.addMediaOpen).toBe(false);
    });

    it("starts with the modal closed", () => {
        const { result } = renderHook(() =>
            useAddMediaWorkflow({
                selectedChannelId: 10,
                importMode: "copy",
                libraryPath: "/library",
                onError,
                onReloadMedia,
            })
        );

        expect(result.current.addMediaOpen).toBe(false);
        expect(mockResetYtDlpState).not.toHaveBeenCalled();
        expect(mockResetForm).not.toHaveBeenCalled();
    });

    it("trims the media path, title and forwards a non-empty thumbnail and published date", async () => {
        vi.mocked(createMedia).mockResolvedValue({ id: 1 });

        mockAddMediaForm.mediaPath = "  /tmp/file.mp4  ";
        mockAddMediaForm.title = "  My media  ";
        mockAddMediaForm.thumbPath = "/tmp/thumb.jpg";
        mockAddMediaForm.publishedAt = "  2026-01-01  ";
        mockAddMediaForm.selectedYtDlpMediaType = "audio";

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
                sourceValue: "/tmp/file.mp4",
                title: "My media",
                thumbnailSourcePath: "/tmp/thumb.jpg",
                publishedAt: "2026-01-01",
                // Local mode must use addMediaForm.mediaType, not the (different)
                // yt-dlp resolved media type, proving the ternary branch is exercised.
                mediaType: "video",
            }),
            expect.objectContaining({
                onProgress: expect.any(Function),
            })
        );
    });

    it("treats a blank published date as no date", async () => {
        vi.mocked(createMedia).mockResolvedValue({ id: 1 });

        mockAddMediaForm.publishedAt = "   ";

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
                publishedAt: null,
            }),
            expect.objectContaining({
                onProgress: expect.any(Function),
            })
        );
    });

    it("forwards onProgress log lines to the yt-dlp terminal", async () => {
        vi.mocked(createMedia).mockImplementation(async (_payload, callbacks) => {
            callbacks?.onProgress?.("50% downloaded");
            return { id: 1 };
        });

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

        expect(mockAppendManualLog).toHaveBeenCalledWith("50% downloaded");
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

    it("blocks add when the local media path is empty", async () => {
        mockAddMediaForm.mediaPath = "   ";

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

        expect(onError).toHaveBeenCalledWith("Select a media file before continuing.");
        expect(createMedia).not.toHaveBeenCalled();
    });

    it("blocks add when the yt-dlp media url is empty", async () => {
        mockAddMediaForm.sourceMode = "yt-dlp";
        mockAddMediaForm.mediaUrl = "   ";
        mockAddMediaForm.mediaPath = "";

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

        expect(onError).toHaveBeenCalledWith("Enter a media URL before continuing.");
        expect(createMedia).not.toHaveBeenCalled();
    });

    it("blocks yt-dlp add when the selected format id is only whitespace", async () => {
        mockAddMediaForm.sourceMode = "yt-dlp";
        mockAddMediaForm.mediaUrl = "https://youtube.com/watch?v=abc";
        mockAddMediaForm.mediaPath = "";
        mockAddMediaForm.selectedYtDlpFormatId = "   ";

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

    it("blocks add while a thumbnail is still being generated", async () => {
        mockAddMediaForm.isGeneratingThumb = true;

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

    it("blocks add while a yt-dlp run is already in progress", async () => {
        mockYtDlpEvents.isYtDlpRunning = true;

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

    it("builds the yt-dlp command preview without cookies and logs enabled options", async () => {
        vi.mocked(createMedia).mockResolvedValue({ id: 1 });

        mockAddMediaForm.sourceMode = "yt-dlp";
        mockAddMediaForm.mediaUrl = "  https://youtube.com/watch?v=abc  ";
        mockAddMediaForm.mediaPath = "";
        mockAddMediaForm.selectedYtDlpFormatId = "  251  ";
        mockAddMediaForm.cookiesBrowser = "";
        mockAddMediaForm.downloadComments = true;
        mockAddMediaForm.downloadLiveChat = true;

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

        expect(mockStartRun).toHaveBeenCalledWith(
            expect.any(String),
            "yt-dlp https://youtube.com/watch?v=abc --format 251"
        );
        expect(mockAppendManualLog).toHaveBeenCalledWith("Comments: enabled");
        expect(mockAppendManualLog).toHaveBeenCalledWith("Live chat: enabled");
        expect(mockAppendManualLog).not.toHaveBeenCalledWith(
            expect.stringContaining("Cookies from browser")
        );
        expect(createMedia).toHaveBeenCalledWith(
            expect.objectContaining({
                ytDlpFormatId: "251",
                cookiesBrowser: null,
            }),
            expect.objectContaining({
                onProgress: expect.any(Function),
            })
        );
    });

    it("generates a run id even when crypto.randomUUID is unavailable", async () => {
        vi.mocked(createMedia).mockResolvedValue({ id: 1 });

        vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID: undefined });

        try {
            mockAddMediaForm.sourceMode = "yt-dlp";
            mockAddMediaForm.mediaUrl = "https://youtube.com/watch?v=abc";
            mockAddMediaForm.mediaPath = "";
            mockAddMediaForm.selectedYtDlpFormatId = "251";

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

            expect(mockStartRun).toHaveBeenCalledWith(
                expect.stringMatching(/^\d+-[a-z0-9]+$/),
                expect.any(String)
            );
        } finally {
            vi.unstubAllGlobals();
        }
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

    it("starts a single createMedia run when addMedia fires twice synchronously", async () => {
        // Regression guard: the reentrancy check must use a synchronous ref, not render
        // state, so a double click before the next render can never start two downloads.
        let resolveCreateMedia: (value: { id: number | null }) => void = () => {};
        vi.mocked(createMedia).mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveCreateMedia = resolve;
                })
        );

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
            const first = result.current.addMedia();
            const second = result.current.addMedia();

            resolveCreateMedia({ id: 1 });
            await Promise.all([first, second]);
        });

        expect(createMedia).toHaveBeenCalledTimes(1);
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
        expect(logError).toHaveBeenCalledWith(
            "add-media",
            "Failed to add media.",
            expect.any(Error),
            {
                selectedChannelId: 10,
                sourceMode: "local",
                libraryPath: "/library",
                cookiesBrowser: "",
            }
        );
    });

    it("uses the latest selectedChannelId and onError across re-renders", async () => {
        vi.mocked(createMedia).mockResolvedValue({ id: 1 });

        const { result, rerender } = renderHook(
            (props: { selectedChannelId: number | null; onError: (message: string) => void }) =>
                useAddMediaWorkflow({
                    selectedChannelId: props.selectedChannelId,
                    importMode: "copy",
                    libraryPath: "/library",
                    onError: props.onError,
                    onReloadMedia,
                }),
            { initialProps: { selectedChannelId: 10, onError } }
        );

        const updatedOnError = vi.fn();
        rerender({ selectedChannelId: 20, onError: updatedOnError });

        await act(async () => {
            await result.current.addMedia();
        });

        expect(createMedia).toHaveBeenCalledWith(
            expect.objectContaining({
                channelId: 20,
            }),
            expect.objectContaining({
                onProgress: expect.any(Function),
            })
        );
        expect(onReloadMedia).toHaveBeenCalledWith(20);
        expect(onError).not.toHaveBeenCalled();
    });

    it("does nothing when there is no active yt-dlp run to cancel", async () => {
        mockYtDlpEvents.currentRunIdRef.current = "";
        mockYtDlpEvents.isYtDlpRunning = false;

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
            await result.current.cancelYtDlpDownload();
        });

        expect(cancelMediaDownload).not.toHaveBeenCalled();
    });

    it("does nothing when a run id exists but yt-dlp is not running", async () => {
        mockYtDlpEvents.currentRunIdRef.current = "run-1";
        mockYtDlpEvents.isYtDlpRunning = false;

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
            await result.current.cancelYtDlpDownload();
        });

        expect(cancelMediaDownload).not.toHaveBeenCalled();
    });

    it("cancels the active yt-dlp run using the trimmed run id", async () => {
        mockYtDlpEvents.currentRunIdRef.current = "  run-1  ";
        mockYtDlpEvents.isYtDlpRunning = true;
        vi.mocked(cancelMediaDownload).mockResolvedValue(undefined);

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
            await result.current.cancelYtDlpDownload();
        });

        expect(cancelMediaDownload).toHaveBeenCalledWith("run-1");
    });

    it("reports an error when cancelling the yt-dlp run fails", async () => {
        mockYtDlpEvents.currentRunIdRef.current = "run-1";
        mockYtDlpEvents.isYtDlpRunning = true;
        vi.mocked(cancelMediaDownload).mockRejectedValue(new Error("boom"));

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
            await result.current.cancelYtDlpDownload();
        });

        expect(onError).toHaveBeenCalledWith("Failed to cancel media download.");
        expect(logError).toHaveBeenCalledWith(
            "add-media",
            "Failed to cancel media download.",
            expect.any(Error),
            { runId: "run-1" }
        );
    });

    it("uses the latest onError callback when cancelling across re-renders", async () => {
        mockYtDlpEvents.currentRunIdRef.current = "run-1";
        mockYtDlpEvents.isYtDlpRunning = true;
        vi.mocked(cancelMediaDownload).mockRejectedValue(new Error("boom"));

        const { result, rerender } = renderHook(
            (props: { onError: (message: string) => void }) =>
                useAddMediaWorkflow({
                    selectedChannelId: 10,
                    importMode: "copy",
                    libraryPath: "/library",
                    onError: props.onError,
                    onReloadMedia,
                }),
            { initialProps: { onError } }
        );

        const updatedOnError = vi.fn();
        rerender({ onError: updatedOnError });

        await act(async () => {
            await result.current.cancelYtDlpDownload();
        });

        expect(updatedOnError).toHaveBeenCalledWith("Failed to cancel media download.");
        expect(onError).not.toHaveBeenCalled();
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

    it("keeps the modal open through repeated open/close cycles", async () => {
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

        act(() => {
            result.current.setAddMediaOpen(true);
        });
        await act(async () => {
            await result.current.closeAddMediaModal();
        });

        expect(mockResetYtDlpState).toHaveBeenCalledTimes(2);
    });

    it("does not close the modal while media is still being generated", async () => {
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
        mockResetForm.mockClear();

        mockAddMediaForm.isGeneratingThumb = true;

        await act(async () => {
            await result.current.closeAddMediaModal();
        });

        expect(mockResetForm).not.toHaveBeenCalled();
        expect(result.current.addMediaOpen).toBe(true);
    });

    it("does not close the modal while yt-dlp formats are loading", async () => {
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
        mockResetForm.mockClear();

        mockAddMediaForm.isLoadingYtDlpFormats = true;

        await act(async () => {
            await result.current.closeAddMediaModal();
        });

        expect(mockResetForm).not.toHaveBeenCalled();
        expect(result.current.addMediaOpen).toBe(true);
    });

    it("does not close the modal while a yt-dlp run is active", async () => {
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
        mockResetForm.mockClear();

        mockYtDlpEvents.isYtDlpRunning = true;

        await act(async () => {
            await result.current.closeAddMediaModal();
        });

        expect(mockResetForm).not.toHaveBeenCalled();
        expect(result.current.addMediaOpen).toBe(true);
    });

    it("does not close the modal while an add-media run is in flight", async () => {
        let resolveCreateMedia: (value: { id: number | null }) => void = () => {};
        vi.mocked(createMedia).mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveCreateMedia = resolve;
                })
        );

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
        mockResetForm.mockClear();

        let addMediaPromise!: Promise<void>;
        act(() => {
            addMediaPromise = result.current.addMedia();
        });

        expect(result.current.isAddingMedia).toBe(true);

        await act(async () => {
            await result.current.closeAddMediaModal();
        });

        // While an add-media run is in flight, the modal must stay locked - this only
        // holds if closeAddMediaModal reads the live isAddingMedia flag on every call
        // rather than a value captured once at mount.
        expect(mockResetForm).not.toHaveBeenCalled();
        expect(result.current.addMediaOpen).toBe(true);

        resolveCreateMedia({ id: 1 });
        await act(async () => {
            await addMediaPromise;
        });
    });

    it("resets state and closes the modal when the selected channel changes while it is open", async () => {
        const { result, rerender } = renderHook(
            (props: { selectedChannelId: number | null }) =>
                useAddMediaWorkflow({
                    selectedChannelId: props.selectedChannelId,
                    importMode: "copy",
                    libraryPath: "/library",
                    onError,
                    onReloadMedia,
                }),
            { initialProps: { selectedChannelId: 10 } }
        );

        act(() => {
            result.current.setAddMediaOpen(true);
        });

        rerender({ selectedChannelId: 20 });

        expect(mockResetForm).toHaveBeenCalled();
        expect(result.current.addMediaOpen).toBe(false);
        expect(mockResetYtDlpState).toHaveBeenCalledWith(true);
    });

    it("resets yt-dlp state on channel change even when the modal is closed", () => {
        const { result: _result, rerender } = renderHook(
            (props: { selectedChannelId: number | null }) =>
                useAddMediaWorkflow({
                    selectedChannelId: props.selectedChannelId,
                    importMode: "copy",
                    libraryPath: "/library",
                    onError,
                    onReloadMedia,
                }),
            { initialProps: { selectedChannelId: 10 } }
        );

        rerender({ selectedChannelId: 20 });

        expect(mockResetYtDlpState).toHaveBeenCalledWith(true);
        expect(mockResetForm).not.toHaveBeenCalled();
    });

    it("does nothing when the selected channel is re-rendered with the same id", () => {
        const { rerender } = renderHook(
            (props: { selectedChannelId: number | null }) =>
                useAddMediaWorkflow({
                    selectedChannelId: props.selectedChannelId,
                    importMode: "copy",
                    libraryPath: "/library",
                    onError,
                    onReloadMedia,
                }),
            { initialProps: { selectedChannelId: 10 } }
        );

        rerender({ selectedChannelId: 10 });

        expect(mockResetYtDlpState).not.toHaveBeenCalled();
        expect(mockResetForm).not.toHaveBeenCalled();
    });

    it("forwards the yt-dlp terminal callbacks from ytDlpEvents to the add-media form", () => {
        renderHook(() =>
            useAddMediaWorkflow({
                selectedChannelId: 10,
                importMode: "copy",
                libraryPath: "/library",
                onError,
                onReloadMedia,
            })
        );

        const options = latestUseAddMediaFormOptions();

        expect(options.ytDlpTerminal?.startManualSession).toBe(mockStartManualSession);
        expect(options.ytDlpTerminal?.appendManualLog).toBe(mockAppendManualLog);
        expect(options.ytDlpTerminal?.markStopped).toBe(mockMarkStopped);
        expect(options.ytDlpTerminal?.resetYtDlpState).toBe(mockResetYtDlpState);
    });
});