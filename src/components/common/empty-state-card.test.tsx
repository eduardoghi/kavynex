import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyStateCard } from "./empty-state-card";
import { renderWithMantine } from "../../test/test-utils";

describe("EmptyStateCard", () => {
    it("renders title, description and features", () => {
        renderWithMantine(
            <EmptyStateCard
                title="Empty library"
                description="Start by creating a channel."
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                features={[
                    {
                        title: "Channels",
                        description: "Group media by source.",
                    },
                    {
                        title: "Media",
                        description: "Import local files.",
                    },
                    {
                        title: "Diagnostics",
                        description: "Check environment health.",
                    },
                ]}
            />
        );

        expect(screen.getByText("Empty library")).toBeInTheDocument();
        expect(screen.getByText("Start by creating a channel.")).toBeInTheDocument();
        expect(screen.getByText("Channels")).toBeInTheDocument();
        expect(screen.getByText("Group media by source.")).toBeInTheDocument();
        expect(screen.getByText("Media")).toBeInTheDocument();
        expect(screen.getByText("Import local files.")).toBeInTheDocument();
        expect(screen.getByText("Diagnostics")).toBeInTheDocument();
        expect(screen.getByText("Check environment health.")).toBeInTheDocument();
    });
});