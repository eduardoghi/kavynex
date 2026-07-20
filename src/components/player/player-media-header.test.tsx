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
                isLive={false}
                hasLiveChat={false}
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
                isLive={false}
                hasLiveChat={false}
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
                isLive={false}
                hasLiveChat={false}
                onOpenInYoutube={onOpenInYoutube}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: /open source on youtube/i }));
        expect(onOpenInYoutube).toHaveBeenCalledTimes(1);
    });

    it("shows loading feedback on the watched/unwatched buttons while a toggle is in flight", () => {
        // Mirrors the Refresh comments button's loading pattern (isRefreshingComments): before
        // this, clicking Mark as watched/unwatched gave no visual feedback while the request was
        // in flight.
        const { unmount } = renderWithMantine(
            <PlayerMediaHeader
                title="Video A"
                publishedLabel=""
                createdLabel=""
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube={false}
                isWatched={false}
                isLive={false}
                hasLiveChat={false}
                isUpdatingWatchedStatus
                onOpenInYoutube={vi.fn()}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        expect(screen.getByRole("button", { name: /mark as watched/i })).toBeDisabled();

        unmount();

        const { rerender } = renderWithMantine(
            <PlayerMediaHeader
                title="Video A"
                publishedLabel=""
                createdLabel=""
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube={false}
                isWatched
                isLive={false}
                hasLiveChat={false}
                isUpdatingWatchedStatus
                onOpenInYoutube={vi.fn()}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        expect(screen.getByRole("button", { name: /mark as unwatched/i })).toBeDisabled();

        rerender(
            <PlayerMediaHeader
                title="Video A"
                publishedLabel=""
                createdLabel=""
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube={false}
                isWatched
                isLive={false}
                hasLiveChat={false}
                isUpdatingWatchedStatus={false}
                onOpenInYoutube={vi.fn()}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        expect(screen.getByRole("button", { name: /mark as unwatched/i })).not.toBeDisabled();
    });

    it("shows the live and chat replay badges only for a live media that has a chat replay", () => {
        // These badges were dead for as long as they existed: the props defaulted to false and the
        // only caller never passed them, so nothing rendered and nothing failed. Pin both states.
        const { unmount } = renderWithMantine(
            <PlayerMediaHeader
                title="Video A"
                publishedLabel=""
                createdLabel=""
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube={false}
                isWatched={false}
                isLive={false}
                hasLiveChat={false}
                onOpenInYoutube={vi.fn()}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        expect(screen.queryByText("LIVE")).not.toBeInTheDocument();
        expect(screen.queryByText("CHAT REPLAY")).not.toBeInTheDocument();

        unmount();

        renderWithMantine(
            <PlayerMediaHeader
                title="Video A"
                publishedLabel=""
                createdLabel=""
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube={false}
                isWatched={false}
                isLive
                hasLiveChat
                onOpenInYoutube={vi.fn()}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        expect(screen.getByText("LIVE")).toBeInTheDocument();
        expect(screen.getByText("CHAT REPLAY")).toBeInTheDocument();
    });
});

// The player header is the densest cluster of icon-only controls in the app, so its controls are
// the ones most dependent on an accessible name (they have no visible text to fall back on). The
// project cannot run an automated axe pass (axe-core is MPL-2.0, outside the license allow-list in
// scripts/check-js-licenses.js), so these role-by-name assertions stand in for that on this screen.
describe("PlayerMediaHeader accessibility", () => {
    it("exposes an accessible name for every interactive control", () => {
        renderWithMantine(
            <PlayerMediaHeader
                title="Video A"
                publishedLabel=""
                createdLabel=""
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube
                isWatched={false}
                isLive={false}
                hasLiveChat={false}
                isRefreshingComments={false}
                onOpenInYoutube={vi.fn()}
                onOpenFileLocation={vi.fn()}
                onRefreshComments={vi.fn()}
                onCancelRefreshComments={vi.fn()}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        // Icon-only controls: their aria-label is the only accessible name they have.
        expect(screen.getByRole("button", { name: "Back to library" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Keyboard shortcuts" })).toBeInTheDocument();

        // Text controls: their label is their accessible name.
        expect(screen.getByRole("button", { name: "Open file location" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Refresh comments" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Mark as watched" })).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Open source on YouTube" })
        ).toBeInTheDocument();
    });

    it("surfaces a named Cancel control only while a comment refresh is running", () => {
        const { rerender } = renderWithMantine(
            <PlayerMediaHeader
                title="Video A"
                publishedLabel=""
                createdLabel=""
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube={false}
                isWatched={false}
                isLive={false}
                hasLiveChat={false}
                isRefreshingComments={false}
                onOpenInYoutube={vi.fn()}
                onRefreshComments={vi.fn()}
                onCancelRefreshComments={vi.fn()}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        // Nothing to cancel yet, so the control is absent rather than present-but-disabled.
        expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();

        rerender(
            <PlayerMediaHeader
                title="Video A"
                publishedLabel=""
                createdLabel=""
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube={false}
                isWatched={false}
                isLive={false}
                hasLiveChat={false}
                isRefreshingComments
                onOpenInYoutube={vi.fn()}
                onRefreshComments={vi.fn()}
                onCancelRefreshComments={vi.fn()}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    });
});