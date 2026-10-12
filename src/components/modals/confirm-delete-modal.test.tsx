import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDeleteModal } from "./confirm-delete-modal";
import { describeViolations, findAccessibilityViolations } from "../../test/axe";
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

    it("keeps the message it showed while it closes", () => {
        // The target is cleared in the same tick the modal closes after a delete, and the closing
        // transition would otherwise show the fallback wording.
        const props = { onClose: vi.fn(), onConfirm: vi.fn() };
        const { rerender } = renderWithMantine(
            <ConfirmDeleteModal {...props} opened message="Delete My video?" />
        );

        rerender(<ConfirmDeleteModal {...props} opened={false} message="Delete this item?" />);

        // Still mounted for the exit transition, and still saying what it said.
        expect(screen.getByText("Delete My video?")).toBeInTheDocument();
        expect(screen.queryByText("Delete this item?")).not.toBeInTheDocument();
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

    it("can be dismissed only through Cancel when it asks for an explicit choice", () => {
        const onClose = vi.fn();

        renderWithMantine(
            <ConfirmDeleteModal
                opened
                onClose={onClose}
                onConfirm={vi.fn()}
                message="The database could not be opened."
                requireExplicitChoice
            />
        );

        const dialog = screen.getByRole("dialog");
        fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes on Escape by default", () => {
        const onClose = vi.fn();

        renderWithMantine(
            <ConfirmDeleteModal opened onClose={onClose} onConfirm={vi.fn()} message="Sure?" />
        );

        fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
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

    it("sends initial focus to confirm when asked, for a prompt whose cancel slot is the risky one", async () => {
        renderWithMantine(
            <ConfirmDeleteModal
                opened
                onClose={vi.fn()}
                onConfirm={vi.fn()}
                message="Restore?"
                confirmLabel="Restore"
                cancelLabel="Start empty"
                autoFocus="confirm"
            />
        );

        const confirmButton = screen.getByRole("button", { name: "Restore" });

        expect(screen.getByRole("button", { name: "Start empty" })).not.toHaveAttribute(
            "data-autofocus"
        );
        await waitFor(() => expect(confirmButton).toHaveFocus());
    });

    it("has no detectable accessibility violations", async () => {
        // Scanned from document.body, not the render container. Mantine mounts the dialog in a
        // portal beside the container, so a scan rooted there covers an empty wrapper and passes
        // for nothing (see src/test/axe.ts).
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

        const violations = await findAccessibilityViolations(document.body);

        expect(describeViolations(violations)).toBe("");
    });
});