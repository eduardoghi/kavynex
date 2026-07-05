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
            isDragging: false,
            isThumbDragging: false,
        });
    });

    it("resets state when source mode changes", () => {
        const { result } = renderHook(() => useAddMediaFormState());

        act(() => {
            result.current.setTitleState("Test");
            result.current.setMediaUrlState("https://youtube.com/watch?v=123");
            result.current.setPublishedAtState("2026-03-31");
            result.current.setIsDraggingState(true);
            result.current.setIsThumbDraggingState(true);
            result.current.setSourceModeState("yt-dlp");
        });

        expect(result.current.state).toEqual({
            sourceMode: "yt-dlp",
            mediaUrl: "",
            title: "",
            mediaPath: "",
            mediaType: "video",
            publishedAt: "",
            isDragging: false,
            isThumbDragging: false,
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
        expect(result.current.state.isDragging).toBe(false);
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

    it("toggles the media dragging flag without touching the thumb dragging flag", () => {
        const { result } = renderHook(() => useAddMediaFormState());

        act(() => {
            result.current.setIsDraggingState(true);
        });

        expect(result.current.state.isDragging).toBe(true);
        expect(result.current.state.isThumbDragging).toBe(false);

        act(() => {
            result.current.setIsDraggingState(false);
        });

        expect(result.current.state.isDragging).toBe(false);
    });

    it("toggles the thumb dragging flag without touching the media dragging flag", () => {
        const { result } = renderHook(() => useAddMediaFormState());

        act(() => {
            result.current.setIsThumbDraggingState(true);
        });

        expect(result.current.state.isThumbDragging).toBe(true);
        expect(result.current.state.isDragging).toBe(false);

        act(() => {
            result.current.setIsThumbDraggingState(false);
        });

        expect(result.current.state.isThumbDragging).toBe(false);
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
            isDragging: false,
            isThumbDragging: false,
        });
    });
});