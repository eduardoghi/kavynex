import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoadingStateCard } from "./loading-state-card";
import { renderWithMantine } from "../../test/test-utils";

describe("LoadingStateCard", () => {
    it("renders loading message", () => {
        renderWithMantine(
            <LoadingStateCard
                message="Loading application..."
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
            />
        );

        expect(screen.getByText("Loading application...")).toBeInTheDocument();
    });
});