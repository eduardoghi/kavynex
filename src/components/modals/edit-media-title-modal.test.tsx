import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditMediaTitleModal } from "./edit-media-title-modal";
import { createMedia } from "../../test/factories/media";
import { renderWithMantine } from "../../test/test-utils";
import { describeViolations, findAccessibilityViolations } from "../../test/axe";

describe("EditMediaTitleModal", () => {
    it("puts initial focus on the title, so typing goes into it", async () => {
        // React's autoFocus loses to Mantine's focus trap, which moves focus to the header's close
        // button unless a field carries data-autofocus.
        renderWithMantine(
            <EditMediaTitleModal
                media={createMedia({ title: "Old title" })}
                onClose={vi.fn()}
                onSave={vi.fn()}
            />
        );

        const field = screen.getByLabelText(/Title/);

        expect(field).toHaveAttribute("data-autofocus");
        await waitFor(() => expect(field).toHaveFocus());
    });
});

describe("EditMediaTitleModal accessibility", () => {
    it("has no detectable accessibility violations", async () => {
        // Scanned from document.body, since the dialog is portaled beside the render container
        // (see src/test/axe.ts).
        renderWithMantine(
            <EditMediaTitleModal
                media={createMedia({ title: "Old title" })}
                onClose={vi.fn()}
                onSave={vi.fn()}
            />
        );

        const violations = await findAccessibilityViolations(document.body);

        expect(violations, describeViolations(violations)).toEqual([]);
    });
});
