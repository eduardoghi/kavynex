import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmptyStateCard } from "./empty-state-card";
import { renderWithMantine } from "../../test/test-utils";

describe("EmptyStateCard", () => {
    it("renders the title, description and primary action", () => {
        renderWithMantine(
            <EmptyStateCard
                title="No channels yet"
                description="Create a channel to start backing up its videos."
                actionLabel="Create your first channel"
                onAction={vi.fn()}
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
            />
        );

        expect(screen.getByText("No channels yet")).toBeInTheDocument();
        expect(
            screen.getByText("Create a channel to start backing up its videos.")
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /create your first channel/i })
        ).toBeInTheDocument();
    });

    it("invokes the action when the button is clicked", () => {
        const onAction = vi.fn();

        renderWithMantine(
            <EmptyStateCard
                title="No channels yet"
                description="Create a channel to start backing up its videos."
                actionLabel="Create your first channel"
                onAction={onAction}
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
            />
        );

        fireEvent.click(screen.getByRole("button", { name: /create your first channel/i }));
        expect(onAction).toHaveBeenCalledTimes(1);
    });
});
