import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppHeader } from "./app-header";
import { renderWithMantine } from "../../test/test-utils";

// The header reads the app version through this hook; stub it so branding is deterministic and the
// test does not reach for the Tauri runtime. Mutable so a test can exercise the not-yet-loaded case.
const mockedVersion = vi.hoisted(() => ({ current: "1.2.0" as string | null }));

vi.mock("../../hooks/use-app-version", () => ({
    useAppVersion: (): string | null => mockedVersion.current,
}));

describe("AppHeader", () => {
    it("renders branding with the app version and no filler badge or tagline", () => {
        mockedVersion.current = "1.2.0";

        renderWithMantine(
            <AppHeader
                appIconSrc="/icon.svg"
                shellSurface="rgba(255,255,255,0.03)"
                shellBorder="rgba(255,255,255,0.1)"
                onOpenCreateChannel={vi.fn()}
                onOpenSettings={vi.fn()}
            />,
            { withAppShell: true }
        );

        expect(screen.getByText("Kavynex")).toBeInTheDocument();
        expect(screen.getByText("v1.2.0")).toBeInTheDocument();
        expect(screen.getByAltText("Kavynex")).toBeInTheDocument();
        expect(screen.queryByText("Desktop")).not.toBeInTheDocument();
        expect(screen.queryByText("Curated media library")).not.toBeInTheDocument();
    });

    it("omits the version pill until the version resolves", () => {
        mockedVersion.current = null;

        renderWithMantine(
            <AppHeader
                appIconSrc="/icon.svg"
                shellSurface="rgba(255,255,255,0.03)"
                shellBorder="rgba(255,255,255,0.1)"
                onOpenCreateChannel={vi.fn()}
                onOpenSettings={vi.fn()}
            />,
            { withAppShell: true }
        );

        expect(screen.getByText("Kavynex")).toBeInTheDocument();
        expect(screen.queryByText(/^v/)).not.toBeInTheDocument();
    });

    it("calls settings action", () => {
        const onOpenSettings = vi.fn();

        renderWithMantine(
            <AppHeader
                appIconSrc="/icon.svg"
                shellSurface="rgba(255,255,255,0.03)"
                shellBorder="rgba(255,255,255,0.1)"
                onOpenCreateChannel={vi.fn()}
                onOpenSettings={onOpenSettings}
            />,
            { withAppShell: true }
        );

        fireEvent.click(screen.getByLabelText(/open settings/i));
        expect(onOpenSettings).toHaveBeenCalled();
    });

    it("calls create channel action", () => {
        const onOpenCreateChannel = vi.fn();

        renderWithMantine(
            <AppHeader
                appIconSrc="/icon.svg"
                shellSurface="rgba(255,255,255,0.03)"
                shellBorder="rgba(255,255,255,0.1)"
                onOpenCreateChannel={onOpenCreateChannel}
                onOpenSettings={vi.fn()}
            />,
            { withAppShell: true }
        );

        fireEvent.click(screen.getByRole("button", { name: /new channel/i }));
        expect(onOpenCreateChannel).toHaveBeenCalled();
    });
});