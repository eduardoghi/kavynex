import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAddMediaFormState } from "./use-add-media-form-state";

describe("useAddMediaFormState", () => {
    it("starts with default values", () => {
        const { result } = renderHook(() => useAddMediaFormState());

        expect(result.current.state).toEqual({
            sourceMode: "local",
            mediaUrl: "",
            title: "",
            mediaPath: "",
            mediaType: "video",
            publishedAt: "",
        });
    });

    it("resets state when source mode changes", () => {
        const { result } = renderHook(() => useAddMediaFormState());

        act(() => {
            result.current.setTitleState("Test");
            result.current.setMediaUrlState("https://youtube.com/watch?v=123");
            result.current.setPublishedAtState("2026-03-31");
            result.current.setSourceModeState("yt-dlp");
        });

        expect(result.current.state).toEqual({
            sourceMode: "yt-dlp",
            mediaUrl: "",
            title: "",
            mediaPath: "",
            mediaType: "video",
            publishedAt: "",
        });
    });

    it("applies local media selection and preserves custom title when provided", () => {
        const { result } = renderHook(() => useAddMediaFormState());

        act(() => {
            result.current.setTitleState("Custom title");
            result.current.applyLocalMediaSelectionState(
                "/tmp/video.mp4",
                "video",
                null
            );
        });

        expect(result.current.state.mediaPath).toBe("/tmp/video.mp4");
        expect(result.current.state.mediaType).toBe("video");
        expect(result.current.state.title).toBe("Custom title");
        expect(result.current.state.mediaUrl).toBe("");
        expect(result.current.state.publishedAt).toBe("");
    });

    it("applies local media selection and fills title when current title is empty", () => {
        const { result } = renderHook(() => useAddMediaFormState());

        act(() => {
            result.current.applyLocalMediaSelectionState(
                "/tmp/video.mp4",
                "video",
                "video"
            );
        });

        expect(result.current.state.mediaPath).toBe("/tmp/video.mp4");
        expect(result.current.state.mediaType).toBe("video");
        expect(result.current.state.title).toBe("video");
    });

    it("updates media type in isolation", () => {
        const { result } = renderHook(() => useAddMediaFormState());

        act(() => {
            result.current.setTitleState("Keep me");
            result.current.setMediaTypeState("audio");
        });

        expect(result.current.state.mediaType).toBe("audio");
        expect(result.current.state.title).toBe("Keep me");
        expect(result.current.state.sourceMode).toBe("local");
    });

    it("resets the whole form", () => {
        const { result } = renderHook(() => useAddMediaFormState());

        act(() => {
            result.current.setSourceModeState("yt-dlp");
            result.current.setMediaUrlState("https://youtube.com/watch?v=123");
            result.current.setTitleState("Test");
            result.current.resetFormState();
        });

        expect(result.current.state).toEqual({
            sourceMode: "local",
            mediaUrl: "",
            title: "",
            mediaPath: "",
            mediaType: "video",
            publishedAt: "",
        });
    });
});