import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImportBehaviorSection } from "./import-behavior-section";
import { renderWithMantine } from "../../../test/test-utils";

describe("ImportBehaviorSection", () => {
    it("marks the active import mode", () => {
        renderWithMantine(
            <ImportBehaviorSection
                importMode="copy"
                onChangeImportMode={vi.fn()}
                isMigratingLibraryPath={false}
            />
        );

        expect(screen.getByRole("radio", { name: /copy files/i })).toBeChecked();
        expect(screen.getByRole("radio", { name: /move files/i })).not.toBeChecked();
    });

    it("calls onChangeImportMode when another mode is chosen", () => {
        const onChange = vi.fn();

        renderWithMantine(
            <ImportBehaviorSection
                importMode="copy"
                onChangeImportMode={onChange}
                isMigratingLibraryPath={false}
            />
        );

        fireEvent.click(screen.getByRole("radio", { name: /move files/i }));

        expect(onChange).toHaveBeenCalledWith("move");
    });

    it("disables both options while a library migration is in progress", () => {
        renderWithMantine(
            <ImportBehaviorSection
                importMode="copy"
                onChangeImportMode={vi.fn()}
                isMigratingLibraryPath
            />
        );

        expect(screen.getByRole("radio", { name: /copy files/i })).toBeDisabled();
        expect(screen.getByRole("radio", { name: /move files/i })).toBeDisabled();
    });
});
