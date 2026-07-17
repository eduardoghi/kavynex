import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppUpdateSection } from "./app-update-section";
import { renderWithMantine } from "../../../test/test-utils";

type SectionProps = Parameters<typeof AppUpdateSection>[0];

function baseProps(overrides: Partial<SectionProps> = {}): SectionProps {
    return {
        appUpdateStatus: "idle",
        updateInfo: null,
        appUpdateProgress: null,
        appUpdateErrorMessage: "",
        checkForUpdate: vi.fn(),
        installUpdate: vi.fn(),
        checkUpdatesOnStartup: false,
        onChangeCheckUpdatesOnStartup: vi.fn(),
        ...overrides,
    };
}

const STARTUP_SWITCH = "Check for updates on startup";

describe("AppUpdateSection", () => {
    it("checks for an update when the button is clicked", () => {
        const checkForUpdate = vi.fn();

        renderWithMantine(<AppUpdateSection {...baseProps({ checkForUpdate })} />);

        fireEvent.click(screen.getByRole("button", { name: /check update/i }));

        expect(checkForUpdate).toHaveBeenCalledTimes(1);
    });

    it("disables the check button while a check is already running", () => {
        renderWithMantine(<AppUpdateSection {...baseProps({ appUpdateStatus: "checking" })} />);

        expect(screen.getByRole("button", { name: /check update/i })).toBeDisabled();
    });

    it("reports when the app is already up to date", () => {
        renderWithMantine(
            <AppUpdateSection {...baseProps({ appUpdateStatus: "not-available" })} />
        );

        expect(screen.getByText("Kavynex is already up to date.")).toBeInTheDocument();
    });

    it("offers to install an available update", () => {
        const installUpdate = vi.fn();

        renderWithMantine(
            <AppUpdateSection
                {...baseProps({
                    appUpdateStatus: "available",
                    updateInfo: {
                        version: "1.2.0",
                        currentVersion: "1.1.1",
                        body: "Bug fixes.",
                    },
                    installUpdate,
                })}
            />
        );

        expect(screen.getByText("Version 1.2.0 is available.")).toBeInTheDocument();
        expect(screen.getByText("Current version: 1.1.1")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /download and install/i }));

        expect(installUpdate).toHaveBeenCalledTimes(1);
    });

    it("shows an update error message", () => {
        renderWithMantine(
            <AppUpdateSection
                {...baseProps({
                    appUpdateStatus: "error",
                    appUpdateErrorMessage: "Could not reach the update server.",
                })}
            />
        );

        expect(screen.getByText("Could not reach the update server.")).toBeInTheDocument();
    });

    it("reflects and toggles the check-on-startup preference", () => {
        const onChange = vi.fn();

        renderWithMantine(
            <AppUpdateSection
                {...baseProps({ checkUpdatesOnStartup: false, onChangeCheckUpdatesOnStartup: onChange })}
            />
        );

        const startupSwitch = screen.getByLabelText(STARTUP_SWITCH);
        expect(startupSwitch).not.toBeChecked();

        fireEvent.click(startupSwitch);

        expect(onChange).toHaveBeenCalledWith(true);
    });
});
