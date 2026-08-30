import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MediaRow } from "../../types/media";
import { MediaPlayerView } from "./media-player-view";
import { createMedia } from "../../test/factories/media";
import { renderWithMantine } from "../../test/test-utils";
import { describeViolations, findAccessibilityViolations } from "../../test/axe";

vi.mock("../../services/media-service", () => ({
    listMediaComments: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../services/live-chat-service", () => ({
    getVisibleLiveChatMessages: vi.fn(() => []),
    getActiveLiveChatPin: vi.fn(() => null),
    extractLiveChatPins: vi.fn(() => []),
    getActiveLiveChatPinFromPins: vi.fn(() => null),
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
                onSaveProgress={vi.fn()}
                onBack={vi.fn()}
            />
        );

        expect(screen.getByText("Unable to open media")).toBeInTheDocument();
    });

    it("passes the live and chat replay state through to the header", async () => {
        // The regression this pins was in the wiring, not the header. The header rendered both
        // badges correctly all along, but MediaPlayerView never passed the props, so they silently
        // defaulted to false and neither badge ever appeared. A header-only test cannot see that.
        renderWithMantine(
            <MediaPlayerView
                media={createMedia({
                    title: "Live Test",
                    is_live: 1,
                    has_live_chat: 1,
                    live_chat_file_path: "live_chat/test.live_chat.json.gz",
                })}
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
                onSaveProgress={vi.fn()}
                onBack={vi.fn()}
            />
        );

        expect(screen.getByText("LIVE")).toBeInTheDocument();
        // The replay panel is code-split, so it arrives a microtask after the first commit.
        // `find*` waits for its chunk. The badge above is in the header and is there immediately,
        // which is what keeps this test still covering the wiring it was written for.
        //
        // The explicit timeout is the part worth keeping. What is being waited on is a dynamic
        // import, and how long that takes has nothing to do with this component. Run alone it
        // lands in a few milliseconds. Run as one of 160-odd files competing for workers it can
        // pass the 1s default, and then this fails for load rather than for behavior. It did,
        // reproducibly, the day a single unrelated test file was deleted and the scheduler dealt
        // this file a different set of neighbours.
        expect(
            await screen.findByText("Live chat replay", undefined, { timeout: 10_000 })
        ).toBeInTheDocument();
    });

    // A longer timeout than the suite default, and this is the one place that needs it. This is the
    // largest tree the app renders, and axe walks every node against every enabled rule in jsdom (// which has no layout engine to short-circuit anything), so it runs several times longer here
    // than over the grid or the sidebar. The default 5s is what it exceeded; this is well clear of
    // the measured time rather than just above it.
    it("has no detectable accessibility violations", { timeout: 30_000 }, async () => {
        // The largest surface in the app and the one with the most controls. Transport buttons, the
        // header actions, the comments panel and the chat replay all render into one subtree. Its
        // aria-live regions are also the ones deliberately decoupled from the lists they describe
        // (virtualization breaks aria-live over a sliding window), which is the kind of structure a
        // refactor can quietly undo. See src/test/axe.ts for what this cannot answer.
        const { container } = renderWithMantine(
            <MediaPlayerView
                media={createMedia({ title: "A media" })}
                mediaSrc="file:///media/test.mp4"
                thumbnailSrc=""
                isAudio={false}
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube
                isWatched={false}
                libraryPath="/library"
                onOpenInYoutube={vi.fn()}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onSaveProgress={vi.fn()}
                onBack={vi.fn()}
            />
        );

        const violations = await findAccessibilityViolations(container);

        expect(describeViolations(violations)).toBe("");
    });

    it("does not show a chat replay panel when the media has no live chat file", () => {
        // `has_live_chat` alone is not enough. The replay panel needs the file path, so with an
        // empty path the media is still marked LIVE but no chat panel is shown.
        renderWithMantine(
            <MediaPlayerView
                media={createMedia({
                    title: "Live Test",
                    is_live: 1,
                    has_live_chat: 1,
                    live_chat_file_path: "",
                })}
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
                onSaveProgress={vi.fn()}
                onBack={vi.fn()}
            />
        );

        expect(screen.getByText("LIVE")).toBeInTheDocument();
        expect(screen.queryByText("Live chat replay")).not.toBeInTheDocument();
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
                onSaveProgress={vi.fn()}
                onBack={vi.fn()}
            />
        );

        // Once, not twice. The header printed the title and the audio surface printed it again
        // right below, so this counted the duplication rather than guarding against it.
        expect(screen.getAllByText("Audio Test")).toHaveLength(1);
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
                onSaveProgress={vi.fn()}
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
                onSaveProgress={vi.fn()}
                onBack={vi.fn()}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: /open source on youtube/i }));

        expect(onOpenInYoutube).toHaveBeenCalledTimes(1);
    });

    describe("progress persistence", () => {
        function renderVideo(
            media: MediaRow,
            onSaveProgress: (mediaId: number, progressSeconds: number) => void
        ) {
            return renderWithMantine(
                <MediaPlayerView
                    media={media}
                    mediaSrc="file:///media/test.mp4"
                    thumbnailSrc=""
                    isAudio={false}
                    shellBorder="rgba(255,255,255,0.1)"
                    canOpenInYoutube={false}
                    isWatched={Boolean(media.watched_at)}
                    libraryPath="/library"
                    onOpenInYoutube={vi.fn()}
                    onMarkWatched={vi.fn()}
                    onMarkUnwatched={vi.fn()}
                    onSaveProgress={onSaveProgress}
                    onBack={vi.fn()}
                />
            );
        }

        it("saves the element position on timeupdate", () => {
            const onSaveProgress = vi.fn();
            renderVideo(createMedia({ id: 7 }), onSaveProgress);

            const video = screen.getByLabelText(/video player/i) as HTMLVideoElement;
            Object.defineProperty(video, "currentTime", { configurable: true, value: 30 });

            fireEvent.timeUpdate(video);

            expect(onSaveProgress).toHaveBeenCalledWith(7, 30);
        });

        it("saves the stored position when the player unmounts", () => {
            const onSaveProgress = vi.fn();
            const { unmount } = renderVideo(
                createMedia({ id: 7, progress_seconds: 42 }),
                onSaveProgress
            );

            unmount();

            expect(onSaveProgress).toHaveBeenCalledWith(7, 42);
        });

        it("does not save progress for watched media", () => {
            const onSaveProgress = vi.fn();
            const { unmount } = renderVideo(
                createMedia({ id: 7, watched_at: "2026-03-31T12:00:00.000Z" }),
                onSaveProgress
            );

            const video = screen.getByLabelText(/video player/i) as HTMLVideoElement;
            Object.defineProperty(video, "currentTime", { configurable: true, value: 30 });
            fireEvent.timeUpdate(video);
            unmount();

            expect(onSaveProgress).not.toHaveBeenCalled();
        });
    });

    describe("playback errors", () => {
        it("shows a banner with an open-location action when the media element fails", () => {
            const onOpenFileLocation = vi.fn();

            renderWithMantine(
                <MediaPlayerView
                    media={createMedia({ title: "Broken", file_path: "video/broken.wmv" })}
                    mediaSrc="file:///media/broken.wmv"
                    thumbnailSrc=""
                    isAudio={false}
                    shellBorder="rgba(255,255,255,0.1)"
                    canOpenInYoutube={false}
                    isWatched={false}
                    libraryPath="/library"
                    onOpenInYoutube={vi.fn()}
                    onOpenFileLocation={onOpenFileLocation}
                    onMarkWatched={vi.fn()}
                    onMarkUnwatched={vi.fn()}
                    onSaveProgress={vi.fn()}
                    onBack={vi.fn()}
                />
            );

            expect(screen.queryByText(/can't be played here/i)).not.toBeInTheDocument();

            const video = screen.getByLabelText(/video player/i);
            fireEvent.error(video);

            const banner = screen.getByRole("alert");
            expect(within(banner).getByText(/can't be played here/i)).toBeInTheDocument();

            fireEvent.click(
                within(banner).getByRole("button", { name: /open file location/i })
            );
            expect(onOpenFileLocation).toHaveBeenCalledTimes(1);
        });

        it("clears the banner once the media can play again", () => {
            renderWithMantine(
                <MediaPlayerView
                    media={createMedia({ title: "Recovers" })}
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
                    onSaveProgress={vi.fn()}
                    onBack={vi.fn()}
                />
            );

            const video = screen.getByLabelText(/video player/i);
            fireEvent.error(video);
            expect(screen.getByText(/can't be played here/i)).toBeInTheDocument();

            fireEvent.canPlay(video);
            expect(screen.queryByText(/can't be played here/i)).not.toBeInTheDocument();
        });
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
                    onSaveProgress={vi.fn()}
                    onBack={vi.fn()}
                />
            );
        }

        it("mutes on M keypress", () => {
            renderVideoPlayer();
            const video = screen.getByLabelText(/video player/i) as HTMLVideoElement;
            expect(video.muted).toBe(false);
            fireEvent.keyDown(document, { code: "KeyM" });
            expect(video.muted).toBe(true);
        });

        it("unmutes on M keypress when already muted", () => {
            renderVideoPlayer();
            const video = screen.getByLabelText(/video player/i) as HTMLVideoElement;
            video.muted = true;
            fireEvent.keyDown(document, { code: "KeyM" });
            expect(video.muted).toBe(false);
        });

        it("seeks backward on ArrowLeft and clamps to zero", () => {
            renderVideoPlayer();
            const video = screen.getByLabelText(/video player/i) as HTMLVideoElement;
            fireEvent.keyDown(document, { code: "ArrowLeft" });
            expect(video.currentTime).toBe(0);
        });

        it("does not seek forward on ArrowRight when duration is unknown", () => {
            renderVideoPlayer();
            const video = screen.getByLabelText(/video player/i) as HTMLVideoElement;
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
            const video = screen.getByLabelText(/video player/i) as HTMLVideoElement;
            expect(video.muted).toBe(false);
            fireEvent.keyDown(document, { code: "KeyM", repeat: true });
            expect(video.muted).toBe(false);
        });

        it("ignores shortcuts when an input is focused", () => {
            renderVideoPlayer();
            const video = screen.getByLabelText(/video player/i) as HTMLVideoElement;
            const input = document.createElement("input");
            document.body.appendChild(input);
            fireEvent.keyDown(input, { code: "KeyM" });
            expect(video.muted).toBe(false);
            document.body.removeChild(input);
        });

        it("ignores shortcuts while a modal is open over the player", () => {
            renderVideoPlayer();
            const video = screen.getByLabelText(/video player/i) as HTMLVideoElement;

            const modal = document.createElement("div");
            modal.setAttribute("aria-modal", "true");
            document.body.appendChild(modal);

            fireEvent.keyDown(document, { code: "KeyM" });
            expect(video.muted).toBe(false);

            document.body.removeChild(modal);

            // Shortcuts work again once the modal is gone.
            fireEvent.keyDown(document, { code: "KeyM" });
            expect(video.muted).toBe(true);
        });
    });
});