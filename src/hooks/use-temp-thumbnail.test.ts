import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTempThumbnail } from "./use-temp-thumbnail";

vi.mock("../services/thumbnail-service", () => ({
    deleteTemporaryThumbnail: vi.fn(),
    generateTemporaryThumbnail: vi.fn(),
}));

import {
    deleteTemporaryThumbnail,
    generateTemporaryThumbnail,
} from "../services/thumbnail-service";

describe("useTempThumbnail", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("starts empty", () => {
        const { result } = renderHook(() => useTempThumbnail());

        expect(result.current.thumbPath).toBe("");
        expect(result.current.isGeneratingThumb).toBe(false);
    });

    it("sets manual thumb path", async () => {
        const { result } = renderHook(() => useTempThumbnail());

        await act(async () => {
            await result.current.setManualThumbPath("/tmp/thumb.jpg");
        });

        expect(result.current.thumbPath).toBe("/tmp/thumb.jpg");
    });

    it("generates thumbnail for video media", async () => {
        vi.mocked(generateTemporaryThumbnail).mockResolvedValue("/tmp/generated.jpg");

        const { result } = renderHook(() => useTempThumbnail());

        await act(async () => {
            await result.current.generateThumbForMedia("/tmp/video.mp4");
        });

        expect(generateTemporaryThumbnail).toHaveBeenCalledWith("/tmp/video.mp4");
        expect(result.current.thumbPath).toBe("/tmp/generated.jpg");
        expect(result.current.isGeneratingThumb).toBe(false);
    });

    it("generates thumbnail for audio media when embedded cover exists", async () => {
        vi.mocked(generateTemporaryThumbnail).mockResolvedValue("/tmp/audio-cover.jpg");

        const { result } = renderHook(() => useTempThumbnail());

        await act(async () => {
            await result.current.generateThumbForMedia("/tmp/audio.mp3");
        });

        expect(generateTemporaryThumbnail).toHaveBeenCalledWith("/tmp/audio.mp3");
        expect(result.current.thumbPath).toBe("/tmp/audio-cover.jpg");
        expect(result.current.isGeneratingThumb).toBe(false);
    });

    it("clears thumbnail when audio thumbnail generation fails", async () => {
        vi.mocked(generateTemporaryThumbnail).mockRejectedValueOnce(new Error("no embedded cover"));
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        const { result } = renderHook(() => useTempThumbnail());

        await act(async () => {
            await result.current.setManualThumbPath("/tmp/thumb.jpg");
            await result.current.generateThumbForMedia("/tmp/audio.mp3");
        });

        expect(generateTemporaryThumbnail).toHaveBeenCalledWith("/tmp/audio.mp3");
        expect(result.current.thumbPath).toBe("");
        expect(result.current.isGeneratingThumb).toBe(false);

        consoleErrorSpy.mockRestore();
    });

    it("resets thumbnail state", async () => {
        const { result } = renderHook(() => useTempThumbnail());

        await act(async () => {
            await result.current.setManualThumbPath("/tmp/thumb.jpg");
            await result.current.resetThumbState();
        });

        expect(result.current.thumbPath).toBe("");
        expect(result.current.isGeneratingThumb).toBe(false);
    });

    it("cleans previous temp thumbnail when replacing generated one", async () => {
        vi.mocked(generateTemporaryThumbnail)
            .mockResolvedValueOnce("/tmp/one.jpg")
            .mockResolvedValueOnce("/tmp/two.jpg");

        const { result } = renderHook(() => useTempThumbnail());

        await act(async () => {
            await result.current.generateThumbForMedia("/tmp/video1.mp4");
            await result.current.generateThumbForMedia("/tmp/video2.mp4");
        });

        expect(deleteTemporaryThumbnail).toHaveBeenCalledWith("/tmp/one.jpg");
        expect(result.current.thumbPath).toBe("/tmp/two.jpg");
    });

    it("keeps manual thumbnail when async generation finishes later", async () => {
        let resolveGeneration: ((value: string) => void) | null = null;

        vi.mocked(generateTemporaryThumbnail).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveGeneration = resolve;
                })
        );

        const { result } = renderHook(() => useTempThumbnail());

        await act(async () => {
            void result.current.generateThumbForMedia("/tmp/video.mp4");
        });

        expect(result.current.isGeneratingThumb).toBe(true);

        await act(async () => {
            await result.current.setManualThumbPath("/tmp/manual.jpg");
        });

        expect(result.current.thumbPath).toBe("/tmp/manual.jpg");
        expect(result.current.isGeneratingThumb).toBe(false);

        await act(async () => {
            resolveGeneration?.("/tmp/generated-late.jpg");
        });

        expect(result.current.thumbPath).toBe("/tmp/manual.jpg");
        expect(result.current.isGeneratingThumb).toBe(false);
        expect(deleteTemporaryThumbnail).toHaveBeenCalledWith("/tmp/generated-late.jpg");
    });

    it("clears state when thumbnail generation fails", async () => {
        vi.mocked(generateTemporaryThumbnail).mockRejectedValueOnce(new Error("boom"));
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        const { result } = renderHook(() => useTempThumbnail());

        await act(async () => {
            await result.current.generateThumbForMedia("/tmp/video.mp4");
        });

        expect(result.current.thumbPath).toBe("");
        expect(result.current.isGeneratingThumb).toBe(false);

        consoleErrorSpy.mockRestore();
    });
});