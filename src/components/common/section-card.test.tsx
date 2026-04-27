import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SectionCard } from "./section-card";
import { renderWithMantine } from "../../test/test-utils";

describe("SectionCard", () => {
    it("renders title, description and children", () => {
        renderWithMantine(
            <SectionCard
                title="Section title"
                description="Section description"
            >
                <div>Section body</div>
            </SectionCard>
        );

        expect(screen.getByText("Section title")).toBeInTheDocument();
        expect(screen.getByText("Section description")).toBeInTheDocument();
        expect(screen.getByText("Section body")).toBeInTheDocument();
    });
});