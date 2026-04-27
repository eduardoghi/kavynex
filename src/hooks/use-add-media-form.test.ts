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

vi.mock("./use-yt-dlp-format-loader", () => ({
    useYtDlpFormatLoader: () => ({
        ytDlpFormats: [],
        selectedYtDlpFormatId: "",
        isLoadingYtDlpFormats: false,
        selectedYtDlpMediaType: "video" as const,
        setSelectedYtDlpFormatId: mockSetSelectedYtDlpFormatId,
        loadYtDlpFormats: mockLoadYtDlpFormats,
        resetYtDlpFormats: mockResetYtDlpFormats,
    }),
}));

import { open } from "@tauri-apps/plugin-dialog";

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
    });

    it("changes source mode", async () => {
        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.setSourceMode("yt-dlp");
        });

        expect(result.current.sourceMode).toBe("yt-dlp");
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

    it("picks thumbnail through dialog", async () => {
        vi.mocked(open).mockResolvedValueOnce("/tmp/thumb.jpg");

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickThumbViaDialog();
        });

        expect(open).toHaveBeenCalled();
        expect(mockSetManualThumbPath).toHaveBeenCalledWith("/tmp/thumb.jpg");
    });

    it("keeps drag flags disabled", () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.onDragOverMedia();
            result.current.onDragLeaveMedia();
            result.current.onDragOverThumb();
            result.current.onDragLeaveThumb();
        });

        expect(result.current.isDragging).toBe(false);
        expect(result.current.isThumbDragging).toBe(false);
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
});