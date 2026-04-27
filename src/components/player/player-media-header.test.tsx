import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlayerMediaHeader } from "./player-media-header";
import { renderWithMantine } from "../../test/test-utils";

describe("PlayerMediaHeader", () => {
    it("renders title and metadata", () => {
        renderWithMantine(
            <PlayerMediaHeader
                title="Video A"
                publishedLabel="31 de mar. de 2026"
                createdLabel="31 de mar. de 2026, 10:00"
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube={false}
                isWatched={false}
                onOpenInYoutube={vi.fn()}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        expect(screen.getByText("Video A")).toBeInTheDocument();
        expect(screen.getByText(/Published:/i)).toBeInTheDocument();
        expect(screen.getByText(/Added to Kavynex:/i)).toBeInTheDocument();
    });

    it("calls watched and back actions", () => {
        const onMarkWatched = vi.fn();
        const onBack = vi.fn();

        renderWithMantine(
            <PlayerMediaHeader
                title="Video A"
                publishedLabel=""
                createdLabel=""
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube={false}
                isWatched={false}
                onOpenInYoutube={vi.fn()}
                onMarkWatched={onMarkWatched}
                onMarkUnwatched={vi.fn()}
                onBack={onBack}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: /mark as watched/i }));
        fireEvent.click(screen.getByLabelText(/back to library/i));

        expect(onMarkWatched).toHaveBeenCalledTimes(1);
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it("shows youtube action when available", () => {
        const onOpenInYoutube = vi.fn();

        renderWithMantine(
            <PlayerMediaHeader
                title="Video A"
                publishedLabel=""
                createdLabel=""
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube
                isWatched
                onOpenInYoutube={onOpenInYoutube}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: /open source on youtube/i }));
        expect(onOpenInYoutube).toHaveBeenCalledTimes(1);
    });
});