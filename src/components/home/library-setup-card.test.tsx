import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UI_TEXT } from "../../constants/ui-text";
import { describeViolations, findAccessibilityViolations } from "../../test/axe";
import { renderWithMantine } from "../../test/test-utils";
import { LibrarySetupCard } from "./library-setup-card";

function renderCard(overrides: { loading?: boolean; onChooseLibraryPath?: () => void } = {}) {
    const onChooseLibraryPath = overrides.onChooseLibraryPath ?? vi.fn();

    const rendered = renderWithMantine(
        <LibrarySetupCard
            loading={overrides.loading ?? false}
            onChooseLibraryPath={onChooseLibraryPath}
            shellBorder="rgba(255,255,255,0.1)"
            shellSurface="rgba(255,255,255,0.03)"
        />
    );

    return { ...rendered, onChooseLibraryPath };
}

describe("LibrarySetupCard", () => {
    it("names the problem, says what the folder holds, and offers the picker", () => {
        renderCard();

        expect(
            screen.getByRole("region", { name: UI_TEXT.home.librarySetupTitle })
        ).toBeInTheDocument();
        expect(screen.getByText(UI_TEXT.home.librarySetupDescription)).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: UI_TEXT.home.librarySetupAction })
        ).toBeInTheDocument();
    });

    it("opens the folder picker when the button is clicked", () => {
        const { onChooseLibraryPath } = renderCard();

        fireEvent.click(screen.getByRole("button", { name: UI_TEXT.home.librarySetupAction }));

        expect(onChooseLibraryPath).toHaveBeenCalledTimes(1);
    });

    it("shows the in-progress label and blocks a second click while the folder is being set up", () => {
        // First-time setup reuses the migration flag, so the same busy state that guards a
        // library move guards this button: a second click mid-setup would open a second dialog.
        const { onChooseLibraryPath } = renderCard({ loading: true });

        const button = screen.getByRole("button", { name: UI_TEXT.home.librarySetupInProgress });
        expect(button).toBeDisabled();

        fireEvent.click(button);
        expect(onChooseLibraryPath).not.toHaveBeenCalled();
    });

    it("has no accessibility violations", async () => {
        const { container } = renderCard();

        const violations = await findAccessibilityViolations(container);

        expect(describeViolations(violations)).toBe("");
    });
});
