import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppHeader } from "./app-header";
import { renderWithMantine } from "../../test/test-utils";

describe("AppHeader", () => {
    it("renders branding", () => {
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
        expect(screen.getByText("Desktop")).toBeInTheDocument();
        expect(screen.getByText("Curated media library")).toBeInTheDocument();
        expect(screen.getByAltText("Kavynex")).toBeInTheDocument();
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