import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorModal } from "./error-modal";
import { renderWithMantine } from "../../test/test-utils";

describe("ErrorModal", () => {
    it("renders default error title and message", () => {
        renderWithMantine(
            <ErrorModal
                opened
                onClose={vi.fn()}
                message="Something failed badly"
            />
        );

        expect(screen.getByText("Error")).toBeInTheDocument();
        expect(screen.getByText("Something went wrong")).toBeInTheDocument();
        expect(screen.getByText("Something failed badly")).toBeInTheDocument();
    });

    it("renders custom title", () => {
        renderWithMantine(
            <ErrorModal
                opened
                onClose={vi.fn()}
                title="Custom error"
                message="Something failed badly"
            />
        );

        expect(screen.getByText("Custom error")).toBeInTheDocument();
    });

    it("calls onClose when close button is clicked", () => {
        const onClose = vi.fn();

        renderWithMantine(
            <ErrorModal
                opened
                onClose={onClose}
                message="Something failed badly"
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalled();
    });

    it("preserves long message rendering", () => {
        renderWithMantine(
            <ErrorModal
                opened
                onClose={vi.fn()}
                message={"Line 1\nLine 2\nLine 3"}
            />
        );

        expect(
            screen.getByText(
                (content) =>
                    content.includes("Line 1") &&
                    content.includes("Line 2") &&
                    content.includes("Line 3")
            )
        ).toBeInTheDocument();
    });
});