import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useYtDlpFormatLoader } from "./use-yt-dlp-format-loader";

vi.mock("../services/media-download-service", () => ({
    listYtDlpFormats: vi.fn(),
}));

import { listYtDlpFormats } from "../services/media-download-service";

describe("useYtDlpFormatLoader", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("starts with empty state", () => {
        const { result } = renderHook(() =>
            useYtDlpFormatLoader({
                getUrl: () => "",
                getCurrentTitle: () => "",
                onSuggestedTitle: vi.fn(),
                onMediaTypeResolved: vi.fn(),
            })
        );

        expect(result.current.ytDlpFormats).toEqual([]);
        expect(result.current.selectedYtDlpFormatId).toBe("");
        expect(result.current.isLoadingYtDlpFormats).toBe(false);
        expect(result.current.selectedYtDlpMediaType).toBe("video");
    });

    it("loads formats and selects best candidate", async () => {
        const onSuggestedTitle = vi.fn();
        const onMediaTypeResolved = vi.fn();

        vi.mocked(listYtDlpFormats).mockResolvedValueOnce({
            suggested_title: "Video A",
            terminal_logs: [],
            formats: [
                {
                    format_id: "audio-only",
                    display_name: "Audio only",
                    ext: "m4a",
                    media_type: "audio",
                    has_video: false,
                    has_audio: true,
                    filesize_bytes: 1000,
                    height: null,
                    abr: 128,
                    tbr: null,
                    vcodec: null,
                    protocol: null,
                },
                {
                    format_id: "best",
                    display_name: "1080p",
                    ext: "mp4",
                    media_type: "video",
                    has_video: true,
                    has_audio: true,
                    filesize_bytes: 2000,
                    height: 1080,
                    abr: null,
                    tbr: 2500,
                    vcodec: "avc1",
                    protocol: "https",
                },
            ],
        });

        const { result } = renderHook(() =>
            useYtDlpFormatLoader({
                getUrl: () => "https://youtube.com/watch?v=abc",
                getCurrentTitle: () => "",
                onSuggestedTitle,
                onMediaTypeResolved,
            })
        );

        await act(async () => {
            await result.current.loadYtDlpFormats();
        });

        expect(result.current.ytDlpFormats).toHaveLength(2);
        expect(result.current.selectedYtDlpFormatId).toBe("best");
        expect(result.current.selectedYtDlpMediaType).toBe("video");
        expect(onSuggestedTitle).toHaveBeenCalledWith("Video A");
        expect(onMediaTypeResolved).toHaveBeenCalledWith("video");
    });

    it("resets state", () => {
        const onMediaTypeResolved = vi.fn();

        const { result } = renderHook(() =>
            useYtDlpFormatLoader({
                getUrl: () => "",
                getCurrentTitle: () => "",
                onSuggestedTitle: vi.fn(),
                onMediaTypeResolved,
            })
        );

        act(() => {
            result.current.resetYtDlpFormats();
        });

        expect(result.current.ytDlpFormats).toEqual([]);
        expect(result.current.selectedYtDlpFormatId).toBe("");
        expect(result.current.isLoadingYtDlpFormats).toBe(false);
        expect(onMediaTypeResolved).toHaveBeenCalledWith("video");
    });

    it("resets media type to video when url is empty", async () => {
        const onMediaTypeResolved = vi.fn();

        const { result } = renderHook(() =>
            useYtDlpFormatLoader({
                getUrl: () => "",
                getCurrentTitle: () => "",
                onSuggestedTitle: vi.fn(),
                onMediaTypeResolved,
            })
        );

        await act(async () => {
            await result.current.loadYtDlpFormats();
        });

        expect(onMediaTypeResolved).toHaveBeenCalledWith("video");
        expect(result.current.selectedYtDlpFormatId).toBe("");
    });

    it("resets media type to video when format loading fails", async () => {
        const onMediaTypeResolved = vi.fn();
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        vi.mocked(listYtDlpFormats).mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() =>
            useYtDlpFormatLoader({
                getUrl: () => "https://youtube.com/watch?v=abc",
                getCurrentTitle: () => "",
                onSuggestedTitle: vi.fn(),
                onMediaTypeResolved,
            })
        );

        await expect(
            act(async () => {
                await result.current.loadYtDlpFormats();
            })
        ).rejects.toThrow("boom");

        expect(result.current.ytDlpFormats).toEqual([]);
        expect(result.current.selectedYtDlpFormatId).toBe("");
        expect(onMediaTypeResolved).toHaveBeenCalledWith("video");

        consoleErrorSpy.mockRestore();
    });

    it("resets media type to video when selected format becomes empty", () => {
        const onMediaTypeResolved = vi.fn();

        const { result } = renderHook(() =>
            useYtDlpFormatLoader({
                getUrl: () => "",
                getCurrentTitle: () => "",
                onSuggestedTitle: vi.fn(),
                onMediaTypeResolved,
            })
        );

        act(() => {
            result.current.setSelectedYtDlpFormatId("");
        });

        expect(onMediaTypeResolved).toHaveBeenCalledWith("video");
    });
});