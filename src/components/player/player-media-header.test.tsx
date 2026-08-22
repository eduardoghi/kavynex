import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlayerMediaHeader } from "./player-media-header";
import { renderWithMantine } from "../../test/test-utils";
import { describeViolations, findAccessibilityViolations } from "../../test/axe";

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
                isLive={false}                onOpenInYoutube={vi.fn()}
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
                isLive={false}                onOpenInYoutube={vi.fn()}
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
                isLive={false}                onOpenInYoutube={onOpenInYoutube}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: /open source on youtube/i }));
        expect(onOpenInYoutube).toHaveBeenCalledTimes(1);

        // Icon only now. The name above comes from the aria-label, and the query would pass just
        // as well on a button that still printed its label, so the absence needs saying.
        expect(screen.queryByText("Open source on YouTube")).not.toBeInTheDocument();
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
                isLive={false}                isUpdatingWatchedStatus
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
                isLive={false}                isUpdatingWatchedStatus
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
                isLive={false}                isUpdatingWatchedStatus={false}
                onOpenInYoutube={vi.fn()}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        expect(screen.getByRole("button", { name: /mark as unwatched/i })).not.toBeDisabled();
    });

    it("shows the live badge only for a live media", () => {
        // The badge renders nothing unless the caller passes isLive; pin both states so a caller
        // that forgets it is caught rather than silently rendering nothing.
        const { unmount } = renderWithMantine(
            <PlayerMediaHeader
                title="Video A"
                publishedLabel=""
                createdLabel=""
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube={false}
                isWatched={false}
                isLive={false}
                onOpenInYoutube={vi.fn()}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        expect(screen.queryByText("LIVE")).not.toBeInTheDocument();

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
                onOpenInYoutube={vi.fn()}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        expect(screen.getByText("LIVE")).toBeInTheDocument();
    });
});

// The player header is the densest cluster of icon-only controls in the app, so its controls are
// the ones most dependent on an accessible name: they have no visible text to fall back on.
//
// Both kinds of check run here and neither replaces the other. The axe pass catches the class (a
// control that ends up with no accessible name at all, whichever way it happened), while the
// role-by-name assertions pin *which* name each control carries, which is what a rename or a
// copy-paste between two icon buttons changes without axe having anything to say about it.
//
// This block used to claim the project could not run axe at all, because axe-core is MPL-2.0 and
// that license is not in the allow-list in scripts/check-js-licenses.js. Both halves are true and
// the conclusion was not: that gate reads `pnpm licenses list --prod`, and axe-core is a dev
// dependency, so it is never in the tree the gate inspects. It was already installed and already
// running on five other screens. Written down because the note read as a constraint, and the screen
// it kept out of the pass is the one this file opens by calling the densest in the app.
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
                isLive={false}                isRefreshingComments={false}
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

        expect(screen.getByRole("button", { name: "More actions" })).toBeInTheDocument();

        // Open file location and Refresh comments moved behind that trigger. Their accessible
        // names are pinned by the two tests that click them, which is the only way to check them
        // here anyway, since the dropdown does not stay queryable across two assertions.

        // Text controls: their label is their accessible name.
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
                isLive={false}                isRefreshingComments={false}
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
                isLive={false}                isRefreshingComments
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

    // Open file location and Refresh comments stopped being buttons in the header. Moving a
    // control into a menu is the kind of change that quietly drops its onClick, so both are
    // driven through the menu rather than only checked for being rendered. One render each,
    // because reopening the menu after an item click is not stable in jsdom.
    it("still runs Open file location from inside the overflow menu", async () => {
        const onOpenFileLocation = vi.fn();

        renderWithMantine(
            <PlayerMediaHeader
                title="Video A"
                publishedLabel=""
                createdLabel=""
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube={false}
                isWatched={false}
                isLive={false}
                onOpenInYoutube={vi.fn()}
                onOpenFileLocation={onOpenFileLocation}
                onRefreshComments={vi.fn()}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "More actions" }));
        fireEvent.click(
            await screen.findByRole("menuitem", { name: "Open file location" })
        );

        expect(onOpenFileLocation).toHaveBeenCalledTimes(1);
    });

    it("still runs Refresh comments from inside the overflow menu", async () => {
        const onRefreshComments = vi.fn();

        renderWithMantine(
            <PlayerMediaHeader
                title="Video A"
                publishedLabel=""
                createdLabel=""
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube={false}
                isWatched={false}
                isLive={false}
                onOpenInYoutube={vi.fn()}
                onOpenFileLocation={vi.fn()}
                onRefreshComments={onRefreshComments}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "More actions" }));
        fireEvent.click(
            await screen.findByRole("menuitem", { name: "Refresh comments" })
        );

        expect(onRefreshComments).toHaveBeenCalledTimes(1);
    });

    it("drops the overflow trigger when neither of its actions was given", () => {
        // Both items are optional props, so a caller that passes neither would otherwise get a
        // menu button that opens an empty dropdown.
        renderWithMantine(<PlayerMediaHeader
                title="Video A"
                publishedLabel=""
                createdLabel=""
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube={false}
                isWatched={false}
                isLive={false}
                onOpenInYoutube={vi.fn()}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                onBack={vi.fn()}
        />);

        expect(
            screen.queryByRole("button", { name: "More actions" })
        ).not.toBeInTheDocument();
    });

    it("passes an axe sweep with every control rendered", async () => {
        // Rendered in its fullest state on purpose: `canOpenInYoutube` and the two overflow actions
        // are what put the most controls on screen, and a sweep over the sparse state would skip
        // exactly the buttons this file exists to watch.
        //
        // What it cannot answer is what `src/test/axe.ts` already records: colour contrast needs
        // computed styles and focus order needs a real layout, and jsdom has neither. So this is a
        // check on structure and naming, not a claim that the header is accessible.
        const { container } = renderWithMantine(
            <PlayerMediaHeader
                title="Video A"
                publishedLabel="31 de mar. de 2026"
                createdLabel="31 de mar. de 2026, 10:00"
                shellBorder="rgba(255,255,255,0.1)"
                canOpenInYoutube
                isWatched={false}
                isLive={false}
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

        const violations = await findAccessibilityViolations(container);

        expect(describeViolations(violations)).toBe("");
    });
});