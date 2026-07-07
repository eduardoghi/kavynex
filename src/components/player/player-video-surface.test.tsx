import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlayerVideoSurface } from "./player-video-surface";
import { renderWithMantine } from "../../test/test-utils";

describe("PlayerVideoSurface", () => {
    it("labels the video element with the media title for screen readers", () => {
        renderWithMantine(
            <PlayerVideoSurface
                title="My Video"
                mediaSrc="file:///video/test.mp4"
                thumbnailSrc="file:///thumb/test.jpg"
                shellBorder="rgba(255,255,255,0.1)"
                progressSeconds={0}
                onPlayerElementChange={vi.fn()}
            />
        );

        expect(screen.getByLabelText("Video player: My Video")).toBeInTheDocument();
    });

    it("falls back to a generic label when the title is empty", () => {
        renderWithMantine(
            <PlayerVideoSurface
                title=""
                mediaSrc="file:///video/test.mp4"
                thumbnailSrc="file:///thumb/test.jpg"
                shellBorder="rgba(255,255,255,0.1)"
                progressSeconds={0}
                onPlayerElementChange={vi.fn()}
            />
        );

        expect(screen.getByLabelText("Video player")).toBeInTheDocument();
    });
});