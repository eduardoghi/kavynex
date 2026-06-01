import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MediaPlayerView } from "./media-player-view";
import { createMedia } from "../../test/factories/media";
import { renderWithMantine } from "../../test/test-utils";

vi.mock("../../services/media-service", () => ({
    listMediaComments: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../services/live-chat-service", () => ({
    getVisibleLiveChatMessages: vi.fn(() => []),
    readLiveChatMessagesFromFile: vi.fn().mockResolvedValue([]),
}));

describe("MediaPlayerView", () => {
    it("shows fallback when media cannot be played", () => {
        renderWithMantine(
            <MediaPlayerView
                media={null}
                mediaSrc=""
                thumbnailSrc=""
                isAudio={false}
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube={false}
                isWatched={false}
                libraryPath="/library"
                onOpenInYoutube={vi.fn()}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        expect(screen.getByText("Unable to open media")).toBeInTheDocument();
    });

    it("renders audio player state", () => {
        renderWithMantine(
            <MediaPlayerView
                media={createMedia({
                    title: "Audio Test",
                    media_type: "audio",
                    file_path: "media/test.mp3",
                })}
                mediaSrc="file:///media/test.mp3"
                thumbnailSrc=""
                isAudio
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube={false}
                isWatched={false}
                libraryPath="/library"
                onOpenInYoutube={vi.fn()}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        expect(screen.getAllByText("Audio Test")).toHaveLength(2);
        expect(screen.getByRole("button", { name: /mark as watched/i })).toBeInTheDocument();
    });

    it("calls watched action", () => {
        const onMarkWatched = vi.fn();

        renderWithMantine(
            <MediaPlayerView
                media={createMedia({ title: "Video Test" })}
                mediaSrc="file:///media/test.mp4"
                thumbnailSrc=""
                isAudio={false}
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube
                isWatched={false}
                libraryPath="/library"
                onOpenInYoutube={vi.fn()}
                onMarkWatched={onMarkWatched}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: /mark as watched/i }));

        expect(onMarkWatched).toHaveBeenCalledTimes(1);
    });

    it("calls youtube action when source is available", () => {
        const onOpenInYoutube = vi.fn();

        renderWithMantine(
            <MediaPlayerView
                media={createMedia({ title: "Video Test" })}
                mediaSrc="file:///media/test.mp4"
                thumbnailSrc=""
                isAudio={false}
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube
                isWatched
                libraryPath="/library"
                onOpenInYoutube={onOpenInYoutube}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: /open source on youtube/i }));

        expect(onOpenInYoutube).toHaveBeenCalledTimes(1);
    });

    describe("keyboard shortcuts", () => {
        function renderVideoPlayer() {
            renderWithMantine(
                <MediaPlayerView
                    media={createMedia({ title: "Video" })}
                    mediaSrc="file:///media/test.mp4"
                    thumbnailSrc=""
                    isAudio={false}
                    shellBorder="rgba(255,255,255,0.1)"
                    canOpenInYoutube={false}
                    isWatched={false}
                    libraryPath="/library"
                    onOpenInYoutube={vi.fn()}
                    onMarkWatched={vi.fn()}
                    onMarkUnwatched={vi.fn()}
                    onBack={vi.fn()}
                />
            );
        }

        it("mutes on M keypress", () => {
            renderVideoPlayer();
            const video = screen.getByLabelText("video") as HTMLVideoElement;
            expect(video.muted).toBe(false);
            fireEvent.keyDown(document, { code: "KeyM" });
            expect(video.muted).toBe(true);
        });

        it("unmutes on M keypress when already muted", () => {
            renderVideoPlayer();
            const video = screen.getByLabelText("video") as HTMLVideoElement;
            video.muted = true;
            fireEvent.keyDown(document, { code: "KeyM" });
            expect(video.muted).toBe(false);
        });

        it("seeks backward on ArrowLeft and clamps to zero", () => {
            renderVideoPlayer();
            const video = screen.getByLabelText("video") as HTMLVideoElement;
            fireEvent.keyDown(document, { code: "ArrowLeft" });
            expect(video.currentTime).toBe(0);
        });

        it("does not seek forward on ArrowRight when duration is unknown", () => {
            renderVideoPlayer();
            const video = screen.getByLabelText("video") as HTMLVideoElement;
            const before = video.currentTime;
            fireEvent.keyDown(document, { code: "ArrowRight" });
            expect(video.currentTime).toBe(before);
        });

        it("requests fullscreen on F keypress", () => {
            const originalDescriptor = Object.getOwnPropertyDescriptor(
                HTMLVideoElement.prototype,
                "requestFullscreen"
            );
            const requestFullscreen = vi.fn().mockResolvedValue(undefined);
            Object.defineProperty(HTMLVideoElement.prototype, "requestFullscreen", {
                configurable: true,
                value: requestFullscreen,
            });

            renderVideoPlayer();
            fireEvent.keyDown(document, { code: "KeyF" });

            expect(requestFullscreen).toHaveBeenCalledTimes(1);

            if (originalDescriptor) {
                Object.defineProperty(
                    HTMLVideoElement.prototype,
                    "requestFullscreen",
                    originalDescriptor
                );
            } else {
                delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>)[
                    "requestFullscreen"
                ];
            }
        });

        it("ignores repeated keydown events", () => {
            renderVideoPlayer();
            const video = screen.getByLabelText("video") as HTMLVideoElement;
            expect(video.muted).toBe(false);
            fireEvent.keyDown(document, { code: "KeyM", repeat: true });
            expect(video.muted).toBe(false);
        });

        it("ignores shortcuts when an input is focused", () => {
            renderVideoPlayer();
            const video = screen.getByLabelText("video") as HTMLVideoElement;
            const input = document.createElement("input");
            document.body.appendChild(input);
            fireEvent.keyDown(input, { code: "KeyM" });
            expect(video.muted).toBe(false);
            document.body.removeChild(input);
        });
    });
});