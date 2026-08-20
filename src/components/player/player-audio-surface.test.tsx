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
        // The surface used to repeat the title, Published and Added to Kavynex directly under the
        // header that already carries all three. The title stays as a prop because the cover image
        // and the audio element still need it for their accessible names, which is why this checks
        // for rendered text rather than for the prop being gone.
        renderSurface();

        expect(screen.queryByText("Audio A")).not.toBeInTheDocument();
        expect(screen.queryByText(/Published:/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Added to Kavynex:/i)).not.toBeInTheDocument();
    });
});
