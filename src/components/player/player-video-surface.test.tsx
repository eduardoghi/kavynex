import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlayerVideoSurface } from "./player-video-surface";
import { renderWithMantine } from "../../test/test-utils";

describe("PlayerVideoSurface", () => {
    it("renders video element", () => {
        renderWithMantine(
            <PlayerVideoSurface
                mediaSrc="file:///video/test.mp4"
                thumbnailSrc="file:///thumb/test.jpg"
                shellBorder="rgba(255,255,255,0.1)"
                progressSeconds={0}
                onPlayerElementChange={vi.fn()}
            />
        );

        expect(screen.getByLabelText("video")).toBeInTheDocument();
    });
});