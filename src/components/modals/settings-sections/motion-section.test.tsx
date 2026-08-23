import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { describeViolations, findAccessibilityViolations } from "../../../test/axe";
import { renderWithMantine } from "../../../test/test-utils";
import { MotionSection } from "./motion-section";

describe("MotionSection", () => {
    it("offers the three choices and reflects the current one", () => {
        renderWithMantine(
            <MotionSection motionPreference="system" onChangeMotionPreference={vi.fn()} />
        );

        expect(screen.getByRole("radiogroup")).toBeInTheDocument();
        expect(screen.getByRole("radio", { name: /follow the system setting/i })).toBeChecked();
        expect(screen.getByRole("radio", { name: /reduce motion/i })).not.toBeChecked();
        expect(screen.getByRole("radio", { name: /full motion/i })).not.toBeChecked();
    });

    it("reports the choice the user makes, in both directions", () => {
        const onChange = vi.fn();

        renderWithMantine(
            <MotionSection motionPreference="system" onChangeMotionPreference={onChange} />
        );

        fireEvent.click(screen.getByRole("radio", { name: /reduce motion/i }));
        expect(onChange).toHaveBeenLastCalledWith("reduce");

        fireEvent.click(screen.getByRole("radio", { name: /full motion/i }));
        expect(onChange).toHaveBeenLastCalledWith("full");
    });

    it("has no accessibility violations", async () => {
        const { container } = renderWithMantine(
            <MotionSection motionPreference="reduce" onChangeMotionPreference={vi.fn()} />
        );

        const violations = await findAccessibilityViolations(container);

        expect(describeViolations(violations)).toBe("");
    });
});
