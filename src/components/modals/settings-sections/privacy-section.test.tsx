import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PrivacySection } from "./privacy-section";
import { renderWithMantine } from "../../../test/test-utils";

const IMAGES_LABEL = "Load comment and live chat images from Google";

// The section renders exactly one Switch, and Mantine wraps its label and (long) description in
// the same <label>, so getByLabelText cannot match the label text alone. Query the single switch
// by role instead (Mantine renders the input with role="switch"), and assert the label copy
// separately with getByText.
describe("PrivacySection", () => {
    it("reflects the current loadRemoteImages state", () => {
        renderWithMantine(
            <PrivacySection loadRemoteImages onChangeLoadRemoteImages={vi.fn()} />
        );

        expect(screen.getByText("Privacy")).toBeInTheDocument();
        expect(screen.getByText(IMAGES_LABEL)).toBeInTheDocument();
        expect(screen.getByRole("switch")).toBeChecked();
    });

    it("calls onChangeLoadRemoteImages with the new value when toggled on", () => {
        const onChange = vi.fn();

        renderWithMantine(
            <PrivacySection loadRemoteImages={false} onChangeLoadRemoteImages={onChange} />
        );

        fireEvent.click(screen.getByRole("switch"));

        expect(onChange).toHaveBeenCalledWith(true);
    });

    it("calls onChangeLoadRemoteImages with false when toggled off", () => {
        const onChange = vi.fn();

        renderWithMantine(
            <PrivacySection loadRemoteImages onChangeLoadRemoteImages={onChange} />
        );

        fireEvent.click(screen.getByRole("switch"));

        expect(onChange).toHaveBeenCalledWith(false);
    });
});
