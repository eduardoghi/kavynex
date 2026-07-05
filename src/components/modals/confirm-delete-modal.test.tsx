import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDeleteModal } from "./confirm-delete-modal";
import { renderWithMantine } from "../../test/test-utils";

describe("ConfirmDeleteModal", () => {
    it("renders title, message and description", () => {
        renderWithMantine(
            <ConfirmDeleteModal
                opened
                onClose={vi.fn()}
                onConfirm={vi.fn()}
                title="Delete item"
                message="Are you sure?"
                description="This action cannot be undone."
            />
        );

        expect(screen.getByText("Delete item")).toBeInTheDocument();
        expect(screen.getByText("Are you sure?")).toBeInTheDocument();
        expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument();
    });

    it("uses default button labels", () => {
        renderWithMantine(
            <ConfirmDeleteModal
                opened
                onClose={vi.fn()}
                onConfirm={vi.fn()}
                message="Are you sure?"
            />
        );

        expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });

    it("uses custom button labels", () => {
        renderWithMantine(
            <ConfirmDeleteModal
                opened
                onClose={vi.fn()}
                onConfirm={vi.fn()}
                message="Are you sure?"
                confirmLabel="Remove"
                cancelLabel="Back"
            />
        );

        expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    });

    it("calls onClose", () => {
        const onClose = vi.fn();

        renderWithMantine(
            <ConfirmDeleteModal
                opened
                onClose={onClose}
                onConfirm={vi.fn()}
                message="Are you sure?"
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onClose).toHaveBeenCalled();
    });

    it("calls onConfirm", () => {
        const onConfirm = vi.fn();

        renderWithMantine(
            <ConfirmDeleteModal
                opened
                onClose={vi.fn()}
                onConfirm={onConfirm}
                message="Are you sure?"
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        expect(onConfirm).toHaveBeenCalled();
    });

    it("disables cancel while loading", () => {
        renderWithMantine(
            <ConfirmDeleteModal
                opened
                onClose={vi.fn()}
                onConfirm={vi.fn()}
                message="Are you sure?"
                loading
            />
        );

        expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    });

    it("sends initial focus to the cancel button to avoid accidental deletion on Enter", async () => {
        renderWithMantine(
            <ConfirmDeleteModal
                opened
                onClose={vi.fn()}
                onConfirm={vi.fn()}
                message="Are you sure?"
            />
        );

        const cancelButton = screen.getByRole("button", { name: "Cancel" });

        expect(cancelButton).toHaveAttribute("data-autofocus");
        await waitFor(() => expect(cancelButton).toHaveFocus());
    });
});