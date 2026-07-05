import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MediaRow } from "../types/media";
import { useHomePlayerPanel } from "./use-home-player-panel";

function createMediaRow(overrides: Partial<MediaRow> = {}): MediaRow {
    return {
        id: 1,
        channel_id: 10,
        title: "Video A",
        file_path: "video/a.mp4",
        thumbnail_path: "thumbnails/a.jpg",
        media_type: "video",
        youtube_video_id: "abc123",
        watched_at: "2026-03-31T12:00:00.000Z",
        published_at: "2026-03-31",
        duration_seconds: 125,
        progress_seconds: 0,
        created_at: "2026-03-31T10:00:00.000Z",
        has_comments: 0,
        comments_count: 0,
        is_live: 0,
        has_live_chat: 0,
        live_chat_file_path: null,
        ...overrides,
    };
}

describe("useHomePlayerPanel", () => {
    it("returns empty-safe state when there is no active media", () => {
        const { result } = renderHook(() =>
            useHomePlayerPanel({
                mediaPlayer: {
                    activeMedia: null,
                    activeIsAudio: false,
                    activeSrc: "",
                    activeThumbSrc: "",
                    canOpenInYoutube: false,
                    activeIsWatched: false,
                },
            })
        );

        expect(result.current.media).toBeNull();
        expect(result.current.mediaSrc).toBe("");
        expect(result.current.thumbnailSrc).toBe("");
        expect(result.current.isAudio).toBe(false);
        expect(result.current.canOpenInYoutube).toBe(false);
        expect(result.current.isWatched).toBe(false);
    });

    it("maps active media player state into panel state", () => {
        const activeMedia = createMediaRow();

        const { result } = renderHook(() =>
            useHomePlayerPanel({
                mediaPlayer: {
                    activeMedia,
                    activeIsAudio: false,
                    activeSrc: "/library/video/a.mp4",
                    activeThumbSrc: "/library/thumbnails/a.jpg",
                    canOpenInYoutube: true,
                    activeIsWatched: true,
                },
            })
        );

        expect(result.current.media).toEqual(activeMedia);
        expect(result.current.mediaSrc).toBe("/library/video/a.mp4");
        expect(result.current.thumbnailSrc).toBe("/library/thumbnails/a.jpg");
        expect(result.current.isAudio).toBe(false);
        expect(result.current.canOpenInYoutube).toBe(true);
        expect(result.current.isWatched).toBe(true);
    });

    it("recomputes the panel state when the media player state changes across a re-render", () => {
        const { result, rerender } = renderHook(
            (props: {
                mediaPlayer: {
                    activeMedia: MediaRow | null;
                    activeIsAudio: boolean;
                    activeSrc: string;
                    activeThumbSrc: string;
                    canOpenInYoutube: boolean;
                    activeIsWatched: boolean;
                };
            }) => useHomePlayerPanel({ mediaPlayer: props.mediaPlayer }),
            {
                initialProps: {
                    mediaPlayer: {
                        activeMedia: null as MediaRow | null,
                        activeIsAudio: false,
                        activeSrc: "",
                        activeThumbSrc: "",
                        canOpenInYoutube: false,
                        activeIsWatched: false,
                    },
                },
            }
        );

        expect(result.current.mediaSrc).toBe("");
        expect(result.current.isWatched).toBe(false);

        const nextActiveMedia = createMediaRow({ id: 2, title: "Video B" });

        rerender({
            mediaPlayer: {
                activeMedia: nextActiveMedia,
                activeIsAudio: true,
                activeSrc: "/library/video/b.mp4",
                activeThumbSrc: "/library/thumbnails/b.jpg",
                canOpenInYoutube: true,
                activeIsWatched: true,
            },
        });

        expect(result.current.media).toEqual(nextActiveMedia);
        expect(result.current.mediaSrc).toBe("/library/video/b.mp4");
        expect(result.current.thumbnailSrc).toBe("/library/thumbnails/b.jpg");
        expect(result.current.isAudio).toBe(true);
        expect(result.current.canOpenInYoutube).toBe(true);
        expect(result.current.isWatched).toBe(true);
    });

    it("does not recompute the panel state when the re-render carries the same values", () => {
        const mediaPlayer = {
            activeMedia: null,
            activeIsAudio: false,
            activeSrc: "",
            activeThumbSrc: "",
            canOpenInYoutube: false,
            activeIsWatched: false,
        };

        const { result, rerender } = renderHook(
            (props: { mediaPlayer: typeof mediaPlayer }) =>
                useHomePlayerPanel({ mediaPlayer: props.mediaPlayer }),
            { initialProps: { mediaPlayer } }
        );

        const firstState = result.current;

        rerender({ mediaPlayer });

        expect(result.current).toBe(firstState);
    });
});