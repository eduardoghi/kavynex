import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTempThumbnail } from "./use-temp-thumbnail";

vi.mock("../services/thumbnail-service", () => ({
    deleteTemporaryThumbnail: vi.fn(),
    generateTemporaryThumbnail: vi.fn(),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import {
    deleteTemporaryThumbnail,
    generateTemporaryThumbnail,
} from "../services/thumbnail-service";
import { logError } from "../utils/app-logger";

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

        const { result } = renderHook(() => useTempThumbnail());

        await act(async () => {
            await result.current.setManualThumbPath("/tmp/thumb.jpg");
            await result.current.generateThumbForMedia("/tmp/audio.mp3");
        });

        expect(generateTemporaryThumbnail).toHaveBeenCalledWith("/tmp/audio.mp3");
        expect(result.current.thumbPath).toBe("");
        expect(result.current.isGeneratingThumb).toBe(false);
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

        const { result } = renderHook(() => useTempThumbnail());

        await act(async () => {
            await result.current.generateThumbForMedia("/tmp/video.mp4");
        });

        expect(result.current.thumbPath).toBe("");
        expect(result.current.isGeneratingThumb).toBe(false);
    });

    it("does not generate a thumbnail for a blank media path", async () => {
        const { result } = renderHook(() => useTempThumbnail());

        await act(async () => {
            await result.current.generateThumbForMedia("   ");
        });

        expect(generateTemporaryThumbnail).not.toHaveBeenCalled();
        expect(result.current.isGeneratingThumb).toBe(false);
    });

    it("trims the media path before generating", async () => {
        vi.mocked(generateTemporaryThumbnail).mockResolvedValue("/tmp/generated.jpg");

        const { result } = renderHook(() => useTempThumbnail());

        await act(async () => {
            await result.current.generateThumbForMedia("  /tmp/video.mp4  ");
        });

        expect(generateTemporaryThumbnail).toHaveBeenCalledWith("/tmp/video.mp4");
    });

    it("deletes the previous generated temp thumbnail when setting a manual path", async () => {
        vi.mocked(generateTemporaryThumbnail).mockResolvedValueOnce("/tmp/generated.jpg");

        const { result } = renderHook(() => useTempThumbnail());

        await act(async () => {
            await result.current.generateThumbForMedia("/tmp/video.mp4");
        });

        expect(result.current.thumbPath).toBe("/tmp/generated.jpg");

        await act(async () => {
            await result.current.setManualThumbPath("  /tmp/manual.jpg  ");
        });

        expect(deleteTemporaryThumbnail).toHaveBeenCalledWith("/tmp/generated.jpg");
        expect(result.current.thumbPath).toBe("/tmp/manual.jpg");
    });

    it("does not delete anything when setting a manual path with no generated temp", async () => {
        const { result } = renderHook(() => useTempThumbnail());

        await act(async () => {
            await result.current.setManualThumbPath("/tmp/manual.jpg");
        });

        expect(deleteTemporaryThumbnail).not.toHaveBeenCalled();
        expect(result.current.thumbPath).toBe("/tmp/manual.jpg");
    });

    it("does not re-delete the temp thumbnail when regenerating the same path", async () => {
        vi.mocked(generateTemporaryThumbnail).mockResolvedValue("/tmp/same.jpg");

        const { result } = renderHook(() => useTempThumbnail());

        await act(async () => {
            await result.current.generateThumbForMedia("/tmp/video.mp4");
            await result.current.generateThumbForMedia("/tmp/video.mp4");
        });

        expect(deleteTemporaryThumbnail).not.toHaveBeenCalled();
        expect(result.current.thumbPath).toBe("/tmp/same.jpg");
    });

    it("deletes the current temp thumbnail on unmount", async () => {
        vi.mocked(generateTemporaryThumbnail).mockResolvedValueOnce("/tmp/generated.jpg");

        const { result, unmount } = renderHook(() => useTempThumbnail());

        await act(async () => {
            await result.current.generateThumbForMedia("/tmp/video.mp4");
        });

        unmount();

        expect(deleteTemporaryThumbnail).toHaveBeenCalledWith("/tmp/generated.jpg");
    });

    it("does not attempt cleanup on unmount when there is no temp thumbnail", () => {
        const { unmount } = renderHook(() => useTempThumbnail());

        unmount();

        expect(deleteTemporaryThumbnail).not.toHaveBeenCalled();
    });

    it("deletes the temp thumbnail when resetting state", async () => {
        vi.mocked(generateTemporaryThumbnail).mockResolvedValueOnce("/tmp/generated.jpg");

        const { result } = renderHook(() => useTempThumbnail());

        await act(async () => {
            await result.current.generateThumbForMedia("/tmp/video.mp4");
        });

        await act(async () => {
            await result.current.resetThumbState();
        });

        expect(deleteTemporaryThumbnail).toHaveBeenCalledWith("/tmp/generated.jpg");
        expect(result.current.thumbPath).toBe("");
    });

    it("swallows and logs a failure to delete a temp thumbnail during cleanup", async () => {
        vi.mocked(generateTemporaryThumbnail)
            .mockResolvedValueOnce("/tmp/one.jpg")
            .mockResolvedValueOnce("/tmp/two.jpg");
        vi.mocked(deleteTemporaryThumbnail).mockRejectedValueOnce(new Error("busy"));

        const { result } = renderHook(() => useTempThumbnail());

        await act(async () => {
            await result.current.generateThumbForMedia("/tmp/video1.mp4");
            await result.current.generateThumbForMedia("/tmp/video2.mp4");
        });

        expect(logError).toHaveBeenCalledWith(
            "temp-thumbnail",
            "Failed to clean up the temporary thumbnail.",
            expect.any(Error)
        );
        // The failed cleanup must not block adopting the new thumbnail.
        expect(result.current.thumbPath).toBe("/tmp/two.jpg");
    });
});