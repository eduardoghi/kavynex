import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AsyncStatusRegion } from "./async-status-region";
import { renderWithMantine } from "../../test/test-utils";

describe("AsyncStatusRegion", () => {
    it("is a polite status region and shows the loading message while loading", () => {
        renderWithMantine(
            <AsyncStatusRegion loading loadingMessage="Loading comments...">
                <span>settled content</span>
            </AsyncStatusRegion>
        );

        expect(screen.getByText("Loading comments...")).toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    });

    it("shows the error text instead of the loading message once a load has failed", () => {
        renderWithMantine(
            <AsyncStatusRegion loading={false} loadingMessage="Loading comments..." error="boom">
                <span>settled content</span>
            </AsyncStatusRegion>
        );

        expect(screen.getByText("boom")).toBeInTheDocument();
        expect(screen.queryByText("Loading comments...")).not.toBeInTheDocument();
    });

    it("renders children even alongside an error so a panel can keep an action visible", () => {
        // The comments panel shows its "fetch comments" action even when a read errored; the shell
        // must never gate children on !error, or that behavior would silently disappear. Each panel
        // keeps its own showing conditions on its children rather than relying on the shell to hide
        // them.
        renderWithMantine(
            <AsyncStatusRegion loading={false} loadingMessage="Loading comments..." error="boom">
                <span>action stays visible</span>
            </AsyncStatusRegion>
        );

        expect(screen.getByText("boom")).toBeInTheDocument();
        expect(screen.getByText("action stays visible")).toBeInTheDocument();
    });

    it("shows the children with no loading or error text once settled", () => {
        renderWithMantine(
            <AsyncStatusRegion loading={false} loadingMessage="Loading comments...">
                <span>settled content</span>
            </AsyncStatusRegion>
        );

        expect(screen.getByText("settled content")).toBeInTheDocument();
        expect(screen.queryByText("Loading comments...")).not.toBeInTheDocument();
    });
});
