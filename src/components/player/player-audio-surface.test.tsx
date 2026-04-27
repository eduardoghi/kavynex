import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlayerAudioSurface } from "./player-audio-surface";
import { renderWithMantine } from "../../test/test-utils";

describe("PlayerAudioSurface", () => {
    it("renders audio metadata", () => {
        renderWithMantine(
            <PlayerAudioSurface
                title="Audio A"
                thumbnailSrc=""
                mediaSrc="file:///audio/test.mp3"
                shellBorder="rgba(255,255,255,0.1)"
                publishedLabel="31 de mar. de 2026"
                createdLabel="31 de mar. de 2026, 10:00"
                filePathLabel="audio/test.mp3"
                progressSeconds={0}
                onPlayerElementChange={vi.fn()}
            />
        );

        expect(screen.getByText("Audio A")).toBeInTheDocument();
        expect(screen.getByText(/Published:/i)).toBeInTheDocument();
        expect(screen.getByText(/Added to Kavynex:/i)).toBeInTheDocument();
        expect(screen.getByText("audio/test.mp3")).toBeInTheDocument();
    });
});