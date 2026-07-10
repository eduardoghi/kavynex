import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAddMediaForm } from "./use-add-media-form";

vi.mock("@tauri-apps/plugin-dialog", () => ({
    open: vi.fn(),
}));

vi.mock("../utils/media-utils", () => ({
    fileNameFromPath: vi.fn((path: string) => path.split("/").pop() ?? ""),
    isThumbnailFile: vi.fn((path: string) => path.endsWith(".jpg") || path.endsWith(".png")),
    mediaTypeFromFile: vi.fn((path: string) => (path.endsWith(".mp3") ? "audio" : "video")),
}));

vi.mock("../utils/error-message", () => ({
    resolveErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

const mockSetManualThumbPath = vi.fn().mockResolvedValue(undefined);
const mockGenerateThumbForMedia = vi.fn().mockResolvedValue(undefined);
const mockResetThumbState = vi.fn().mockResolvedValue(undefined);

vi.mock("./use-temp-thumbnail", () => ({
    useTempThumbnail: () => ({
        thumbPath: "",
        isGeneratingThumb: false,
        setManualThumbPath: mockSetManualThumbPath,
        generateThumbForMedia: mockGenerateThumbForMedia,
        resetThumbState: mockResetThumbState,
    }),
}));

const mockSetSelectedYtDlpFormatId = vi.fn();
const mockLoadYtDlpFormats = vi.fn().mockResolvedValue(undefined);
const mockResetYtDlpFormats = vi.fn();

type YtDlpFormatLoaderOptions = {
    getUrl: () => string;
    getCurrentTitle: () => string;
    getCookiesBrowser?: () => string;
    getCookiesPath?: () => string;
    onSuggestedTitle: (value: string) => void;
    onMediaTypeResolved: (value: "video" | "audio") => void;
    onTerminalStart?: (runId: string, header: string) => void;
    onTerminalLog?: (line: string) => void;
    onTerminalStop?: () => void;
};

const mockUseYtDlpFormatLoader = vi.fn((_options: YtDlpFormatLoaderOptions) => ({
    ytDlpFormats: [],
    selectedYtDlpFormatId: "",
    isLoadingYtDlpFormats: false,
    selectedYtDlpMediaType: "video" as const,
    resolvedYoutubeVideoId: null as string | null,
    setSelectedYtDlpFormatId: mockSetSelectedYtDlpFormatId,
    loadYtDlpFormats: mockLoadYtDlpFormats,
    resetYtDlpFormats: mockResetYtDlpFormats,
}));

function latestYtDlpFormatLoaderOptions(): YtDlpFormatLoaderOptions {
    const calls = mockUseYtDlpFormatLoader.mock.calls;
    return calls[calls.length - 1][0];
}

vi.mock("./use-yt-dlp-format-loader", () => ({
    useYtDlpFormatLoader: (options: YtDlpFormatLoaderOptions) => mockUseYtDlpFormatLoader(options),
}));

import { open } from "@tauri-apps/plugin-dialog";
import { logError } from "../utils/app-logger";

describe("useAddMediaForm", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockSetManualThumbPath.mockResolvedValue(undefined);
        mockGenerateThumbForMedia.mockResolvedValue(undefined);
        mockResetThumbState.mockResolvedValue(undefined);
        mockLoadYtDlpFormats.mockResolvedValue(undefined);
    });

    it("starts with expected defaults", () => {
        const { result } = renderHook(() => useAddMediaForm());

        expect(result.current.sourceMode).toBe("local");
        expect(result.current.mediaUrl).toBe("");
        expect(result.current.title).toBe("");
        expect(result.current.mediaPath).toBe("");
        expect(result.current.mediaType).toBe("video");
        expect(result.current.publishedAt).toBe("");
        expect(result.current.downloadComments).toBe(true);
        expect(result.current.downloadLiveChat).toBe(true);
        expect(result.current.cookiesBrowser).toBe("");
        expect(result.current.cookiesPath).toBe("");
        expect(result.current.resolvedYoutubeVideoId).toBeNull();
    });

    it("exposes the youtube video id resolved by the format loader", () => {
        mockUseYtDlpFormatLoader.mockReturnValueOnce({
            ytDlpFormats: [],
            selectedYtDlpFormatId: "",
            isLoadingYtDlpFormats: false,
            selectedYtDlpMediaType: "video",
            resolvedYoutubeVideoId: "abc123",
            setSelectedYtDlpFormatId: mockSetSelectedYtDlpFormatId,
            loadYtDlpFormats: mockLoadYtDlpFormats,
            resetYtDlpFormats: mockResetYtDlpFormats,
        });

        const { result } = renderHook(() => useAddMediaForm());

        expect(result.current.resolvedYoutubeVideoId).toBe("abc123");
    });

    it("requests a single, non-directory file from the dialog", async () => {
        vi.mocked(open).mockResolvedValueOnce("/tmp/video.mp4");

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        expect(open).toHaveBeenCalledWith({
            multiple: false,
            directory: false,
        });
    });

    it("changes source mode", async () => {
        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.setSourceMode("yt-dlp");
        });

        expect(result.current.sourceMode).toBe("yt-dlp");
    });

    it("switches back and forth between source modes based on the latest state", async () => {
        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.setSourceMode("yt-dlp");
        });
        expect(result.current.sourceMode).toBe("yt-dlp");

        await act(async () => {
            await result.current.setSourceMode("local");
        });
        expect(result.current.sourceMode).toBe("local");
    });

    it("ignores setSourceMode when the mode is unchanged", async () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setMediaUrl("kept");
        });

        await act(async () => {
            await result.current.setSourceMode("local");
        });

        expect(mockResetYtDlpFormats).not.toHaveBeenCalled();
        expect(mockResetThumbState).not.toHaveBeenCalled();
        expect(result.current.mediaUrl).toBe("kept");
    });

    it("resets download and cookies options when source mode changes", async () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setDownloadComments(false);
            result.current.setDownloadLiveChat(false);
            result.current.setCookiesBrowser("edge");
        });

        await act(async () => {
            await result.current.setSourceMode("yt-dlp");
        });

        expect(result.current.downloadComments).toBe(true);
        expect(result.current.downloadLiveChat).toBe(true);
        expect(result.current.cookiesBrowser).toBe("");
        expect(result.current.cookiesPath).toBe("");
        expect(mockResetThumbState).toHaveBeenCalled();
    });

    it("updates media url and title", () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setMediaUrl("https://youtube.com/watch?v=abc");
            result.current.setTitle("Test title");
            result.current.setPublishedAt("2026-03-31");
        });

        expect(result.current.mediaUrl).toBe("https://youtube.com/watch?v=abc");
        expect(result.current.title).toBe("Test title");
        expect(result.current.publishedAt).toBe("2026-03-31");
    });

    it("resets yt-dlp related state when the media url changes in yt-dlp mode", async () => {
        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.setSourceMode("yt-dlp");
        });

        act(() => {
            result.current.setPublishedAt("2026-01-01");
        });

        mockResetYtDlpFormats.mockClear();

        act(() => {
            result.current.setMediaUrl("https://youtube.com/watch?v=xyz");
        });

        expect(result.current.mediaUrl).toBe("https://youtube.com/watch?v=xyz");
        expect(result.current.publishedAt).toBe("");
        expect(result.current.mediaType).toBe("video");
        expect(mockResetYtDlpFormats).toHaveBeenCalled();
    });

    it("does not reset yt-dlp state when the media url changes in local mode", () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setMediaUrl("https://youtube.com/watch?v=xyz");
        });

        expect(mockResetYtDlpFormats).not.toHaveBeenCalled();
    });

    it("picks media through dialog", async () => {
        vi.mocked(open).mockResolvedValueOnce("/tmp/video.mp4");

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        expect(result.current.mediaPath).toBe("/tmp/video.mp4");
        expect(result.current.mediaType).toBe("video");
        expect(result.current.title).toBe("video");
    });

    it("ignores empty media selection from dialog", async () => {
        vi.mocked(open).mockResolvedValueOnce(null);

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        expect(result.current.mediaPath).toBe("");
    });

    it("trims whitespace from the selected media path", async () => {
        vi.mocked(open).mockResolvedValueOnce("  /tmp/video.mp4  ");

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        expect(result.current.mediaPath).toBe("/tmp/video.mp4");
    });

    it("preserves an already-set title when picking new media", async () => {
        vi.mocked(open).mockResolvedValueOnce("/tmp/other-video.mp4");

        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setTitle("My custom title");
        });

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        expect(result.current.title).toBe("My custom title");
        expect(result.current.mediaPath).toBe("/tmp/other-video.mp4");
    });

    it("falls back to Untitled when the selected file has no derivable name", async () => {
        vi.mocked(open).mockResolvedValueOnce("/tmp/");

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        expect(result.current.title).toBe("Untitled");
    });

    it("picks thumbnail through dialog", async () => {
        vi.mocked(open).mockResolvedValueOnce("/tmp/thumb.jpg");

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickThumbViaDialog();
        });

        expect(open).toHaveBeenCalled();
        expect(mockSetManualThumbPath).toHaveBeenCalledWith("/tmp/thumb.jpg");
    });

    it("ignores a thumbnail selection with an unsupported extension", async () => {
        vi.mocked(open).mockResolvedValueOnce("/tmp/thumb.gif");

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickThumbViaDialog();
        });

        expect(mockSetManualThumbPath).not.toHaveBeenCalled();
    });

    it("ignores empty thumbnail selection from dialog", async () => {
        vi.mocked(open).mockResolvedValueOnce(null);

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickThumbViaDialog();
        });

        expect(mockSetManualThumbPath).not.toHaveBeenCalled();
    });

    it("reports dialog error when thumbnail picker fails", async () => {
        const onError = vi.fn();
        vi.mocked(open).mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() =>
            useAddMediaForm({
                onError,
            })
        );

        await act(async () => {
            await result.current.pickThumbViaDialog();
        });

        expect(onError).toHaveBeenCalledWith("Failed to select thumbnail image.");
    });

    it("normalizes cookies browser input (trim, lowercase, validated against the supported list)", () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setCookiesBrowser("  Edge  ");
        });
        expect(result.current.cookiesBrowser).toBe("edge");

        act(() => {
            result.current.setCookiesBrowser("not-a-real-browser");
        });
        expect(result.current.cookiesBrowser).toBe("");
        expect(mockResetYtDlpFormats).toHaveBeenCalled();
    });

    it("keeps the cookies path when switching to manual mode but clears it otherwise", () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setCookiesPath("/tmp/cookies.txt");
            result.current.setCookiesBrowser("manual");
        });
        expect(result.current.cookiesPath).toBe("/tmp/cookies.txt");
        expect(result.current.cookiesBrowser).toBe("manual");

        act(() => {
            result.current.setCookiesBrowser("edge");
        });
        expect(result.current.cookiesPath).toBe("");
    });

    it("trims the cookies path", () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setCookiesPath("  /tmp/cookies.txt  ");
        });

        expect(result.current.cookiesPath).toBe("/tmp/cookies.txt");
    });

    it("picks a valid cookies text file through the dialog", async () => {
        vi.mocked(open).mockResolvedValueOnce("/tmp/cookies.TXT");

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickCookiesFileViaDialog();
        });

        expect(result.current.cookiesBrowser).toBe("manual");
        expect(result.current.cookiesPath).toBe("/tmp/cookies.TXT");
        expect(mockResetYtDlpFormats).toHaveBeenCalled();
    });

    it("rejects a cookies file without a .txt extension", async () => {
        const onError = vi.fn();
        vi.mocked(open).mockResolvedValueOnce("/tmp/cookies.json");

        const { result } = renderHook(() =>
            useAddMediaForm({
                onError,
            })
        );

        await act(async () => {
            await result.current.pickCookiesFileViaDialog();
        });

        expect(onError).toHaveBeenCalledWith("Failed to select cookies file.");
        expect(result.current.cookiesBrowser).toBe("");
        expect(result.current.cookiesPath).toBe("");
    });

    it("ignores empty cookies file selection", async () => {
        vi.mocked(open).mockResolvedValueOnce(null);

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickCookiesFileViaDialog();
        });

        expect(result.current.cookiesBrowser).toBe("");
        expect(mockResetYtDlpFormats).not.toHaveBeenCalled();
    });

    it("clears the cookies path", () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setCookiesPath("/tmp/cookies.txt");
        });
        mockResetYtDlpFormats.mockClear();

        act(() => {
            result.current.clearCookiesPath();
        });

        expect(result.current.cookiesPath).toBe("");
        expect(mockResetYtDlpFormats).toHaveBeenCalled();
    });

    it("passes yt-dlp cookies getters that respect manual mode", () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setCookiesBrowser("edge");
        });

        let options = latestYtDlpFormatLoaderOptions();
        expect(options.getCookiesBrowser?.()).toBe("edge");
        expect(options.getCookiesPath?.()).toBe("");

        act(() => {
            result.current.setCookiesBrowser("manual");
            result.current.setCookiesPath("/tmp/cookies.txt");
        });

        options = latestYtDlpFormatLoaderOptions();
        expect(options.getCookiesBrowser?.()).toBe("");
        expect(options.getCookiesPath?.()).toBe("/tmp/cookies.txt");
    });

    it("applies yt-dlp suggested title and media type through the format loader callbacks", () => {
        const { result } = renderHook(() => useAddMediaForm());

        const options = latestYtDlpFormatLoaderOptions();

        act(() => {
            options.onSuggestedTitle("Suggested Title");
            options.onMediaTypeResolved("audio");
        });

        expect(result.current.title).toBe("Suggested Title");
        expect(result.current.mediaType).toBe("audio");
    });

    it("resets form", async () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setMediaUrl("https://youtube.com/watch?v=abc");
            result.current.setTitle("Test");
        });

        await act(async () => {
            await result.current.resetForm();
        });

        expect(result.current.sourceMode).toBe("local");
        expect(result.current.mediaUrl).toBe("");
        expect(result.current.title).toBe("");
        expect(result.current.mediaPath).toBe("");
        expect(result.current.mediaType).toBe("video");
        expect(result.current.publishedAt).toBe("");
    });

    it("reports yt-dlp format loading error through onError", async () => {
        const onError = vi.fn();
        mockLoadYtDlpFormats.mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() =>
            useAddMediaForm({
                onError,
            })
        );

        await act(async () => {
            await result.current.loadYtDlpFormats();
        });

        expect(onError).toHaveBeenCalledWith("Failed to load yt-dlp formats.");
    });

    it("reports yt-dlp format loading error with contextual details", async () => {
        mockLoadYtDlpFormats.mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setMediaUrl("  https://youtube.com/watch?v=abc  ");
            result.current.setCookiesBrowser("edge");
        });

        await act(async () => {
            await result.current.loadYtDlpFormats();
        });

        expect(logError).toHaveBeenCalledWith(
            "add-media-form",
            "Failed to load yt-dlp formats.",
            expect.any(Error),
            {
                mediaUrl: "https://youtube.com/watch?v=abc",
                cookiesBrowser: "edge",
                cookiesPath: "",
            }
        );
    });

    it("reports dialog error when media picker fails", async () => {
        const onError = vi.fn();
        vi.mocked(open).mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() =>
            useAddMediaForm({
                onError,
            })
        );

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        expect(onError).toHaveBeenCalledWith("Failed to select media file.");
    });

    it("does not throw when reporting an error without an onError callback", async () => {
        vi.mocked(open).mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        expect(logError).toHaveBeenCalledWith(
            "add-media-form",
            "Failed to select media file.",
            expect.any(Error),
            undefined
        );
    });

    it("uses the latest onError callback across re-renders", async () => {
        vi.mocked(open).mockRejectedValueOnce(new Error("boom"));

        const { result, rerender } = renderHook(
            ({ onError }: { onError?: (message: string) => void }) => useAddMediaForm({ onError }),
            { initialProps: { onError: undefined as ((message: string) => void) | undefined } }
        );

        const updatedOnError = vi.fn();
        rerender({ onError: updatedOnError });

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        expect(updatedOnError).toHaveBeenCalledWith("Failed to select media file.");
    });

    it("uses the latest onError callback for cookies file errors across re-renders", async () => {
        vi.mocked(open).mockRejectedValueOnce(new Error("boom"));

        const { result, rerender } = renderHook(
            ({ onError }: { onError?: (message: string) => void }) => useAddMediaForm({ onError }),
            { initialProps: { onError: undefined as ((message: string) => void) | undefined } }
        );

        const updatedOnError = vi.fn();
        rerender({ onError: updatedOnError });

        await act(async () => {
            await result.current.pickCookiesFileViaDialog();
        });

        expect(updatedOnError).toHaveBeenCalledWith("Failed to select cookies file.");
    });

    function createYtDlpTerminalMock() {
        return {
            startManualSession: vi.fn(),
            appendManualLog: vi.fn(),
            markStopped: vi.fn(),
            resetYtDlpState: vi.fn(),
        };
    }

    it("clears yt-dlp terminal state when switching source mode", async () => {
        const ytDlpTerminal = createYtDlpTerminalMock();
        const { result } = renderHook(() => useAddMediaForm({ ytDlpTerminal }));

        await act(async () => {
            await result.current.setSourceMode("yt-dlp");
        });

        expect(ytDlpTerminal.resetYtDlpState).toHaveBeenCalledWith(true);
    });

    it("clears yt-dlp terminal state when resetting the form", async () => {
        const ytDlpTerminal = createYtDlpTerminalMock();
        const { result } = renderHook(() => useAddMediaForm({ ytDlpTerminal }));

        await act(async () => {
            await result.current.resetForm();
        });

        expect(ytDlpTerminal.resetYtDlpState).toHaveBeenCalledWith(true);
    });

    it("clears yt-dlp terminal state after picking a cookies file", async () => {
        const ytDlpTerminal = createYtDlpTerminalMock();
        vi.mocked(open).mockResolvedValueOnce("/tmp/cookies.txt");

        const { result } = renderHook(() => useAddMediaForm({ ytDlpTerminal }));

        await act(async () => {
            await result.current.pickCookiesFileViaDialog();
        });

        expect(ytDlpTerminal.resetYtDlpState).toHaveBeenCalledWith(true);
    });

    it("clears yt-dlp terminal state when the media url changes in yt-dlp mode", async () => {
        const ytDlpTerminal = createYtDlpTerminalMock();
        const { result } = renderHook(() => useAddMediaForm({ ytDlpTerminal }));

        await act(async () => {
            await result.current.setSourceMode("yt-dlp");
        });
        ytDlpTerminal.resetYtDlpState.mockClear();

        act(() => {
            result.current.setMediaUrl("https://youtube.com/watch?v=abc");
        });

        expect(ytDlpTerminal.resetYtDlpState).toHaveBeenCalledWith(true);
    });

    it("uses the latest ytDlpTerminal across re-renders for cookie and reset actions", () => {
        const { result, rerender } = renderHook(
            ({ ytDlpTerminal }: { ytDlpTerminal?: ReturnType<typeof createYtDlpTerminalMock> }) =>
                useAddMediaForm({ ytDlpTerminal }),
            {
                initialProps: {
                    ytDlpTerminal: undefined as ReturnType<typeof createYtDlpTerminalMock> | undefined,
                },
            }
        );

        const ytDlpTerminal = createYtDlpTerminalMock();
        rerender({ ytDlpTerminal });

        act(() => {
            result.current.setCookiesBrowser("edge");
        });
        expect(ytDlpTerminal.resetYtDlpState).toHaveBeenCalledWith(true);

        ytDlpTerminal.resetYtDlpState.mockClear();
        act(() => {
            result.current.setCookiesPath("/tmp/cookies.txt");
        });
        expect(ytDlpTerminal.resetYtDlpState).toHaveBeenCalledWith(true);

        ytDlpTerminal.resetYtDlpState.mockClear();
        act(() => {
            result.current.clearCookiesPath();
        });
        expect(ytDlpTerminal.resetYtDlpState).toHaveBeenCalledWith(true);
    });
});