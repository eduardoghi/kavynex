import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlayerAudioSurface } from "./player-audio-surface";
import { renderWithMantine } from "../../test/test-utils";

function renderSurface() {
    renderWithMantine(
        <PlayerAudioSurface
            title="Audio A"
            thumbnailSrc=""
            mediaSrc="file:///audio/test.mp3"
            shellBorder="rgba(255,255,255,0.1)"
            progressSeconds={0}
            onPlayerElementChange={vi.fn()}
        />
    );
}

describe("PlayerAudioSurface", () => {
    it("renders the transport", () => {
        renderSurface();

        expect(screen.getByLabelText("Audio player: Audio A")).toBeInTheDocument();
    });

    it("leaves the title and both dates to the header instead of printing them again", () => {
        // The surface must not repeat the title and the published and added dates directly under the
        // header that already carries all three. The title stays as a prop because the cover image
        // and the audio element still need it for their accessible names, which is why this checks
        // for rendered text rather than for the prop being gone.
        renderSurface();

        expect(screen.queryByText("Audio A")).not.toBeInTheDocument();
        expect(screen.queryByText(/^Published /)).not.toBeInTheDocument();
        expect(screen.queryByText(/^Added /)).not.toBeInTheDocument();
    });
});
