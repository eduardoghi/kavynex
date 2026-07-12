import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithMantine } from "../../test/test-utils";
import { SectionErrorBoundary } from "./section-error-boundary";

vi.mock("../../utils/global-error-reporting", () => ({
    reportFatalError: vi.fn(),
}));

import { reportFatalError } from "../../utils/global-error-reporting";

function CrashingChild({ shouldThrow }: { shouldThrow: boolean }): JSX.Element {
    if (shouldThrow) {
        throw new Error("player exploded");
    }

    return <div>healthy content</div>;
}

describe("SectionErrorBoundary", () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        // React logs caught render errors to console.error; keep test output clean.
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    it("renders children while there is no error", () => {
        renderWithMantine(
            <SectionErrorBoundary
                scope="media-player"
                title="Player problem"
                description="Something failed"
            >
                <CrashingChild shouldThrow={false} />
            </SectionErrorBoundary>
        );

        expect(screen.getByText("healthy content")).toBeInTheDocument();
        expect(reportFatalError).not.toHaveBeenCalled();
    });

    it("shows the inline fallback and reports the error when a child crashes", () => {
        renderWithMantine(
            <SectionErrorBoundary
                scope="media-player"
                title="Player problem"
                description="Something failed"
            >
                <CrashingChild shouldThrow={true} />
            </SectionErrorBoundary>
        );

        expect(screen.getByRole("alert")).toBeInTheDocument();
        expect(screen.getByText("Player problem")).toBeInTheDocument();
        expect(screen.getByText("Technical details: player exploded")).toBeInTheDocument();
        expect(reportFatalError).toHaveBeenCalledWith(
            "media-player",
            expect.stringContaining("A render error crashed the media-player section."),
            expect.objectContaining({ message: "player exploded" })
        );
    });

    it("runs the extra action when its button is clicked", async () => {
        const onAction = vi.fn();
        const user = userEvent.setup();

        renderWithMantine(
            <SectionErrorBoundary
                scope="media-player"
                title="Player problem"
                description="Something failed"
                actionLabel="Close player"
                onAction={onAction}
            >
                <CrashingChild shouldThrow={true} />
            </SectionErrorBoundary>
        );

        await user.click(screen.getByRole("button", { name: "Close player" }));

        expect(onAction).toHaveBeenCalledTimes(1);
    });

    it("clears the caught error when a reset key changes", () => {
        let shouldThrow = true;

        function Child(): JSX.Element {
            return <CrashingChild shouldThrow={shouldThrow} />;
        }

        const { rerender } = renderWithMantine(
            <SectionErrorBoundary
                scope="media-player"
                title="Player problem"
                description="Something failed"
                resetKeys={[1]}
            >
                <Child />
            </SectionErrorBoundary>
        );

        expect(screen.getByRole("alert")).toBeInTheDocument();

        // Switching to another media (a new reset key) re-arms the boundary and re-renders
        // the now-healthy child instead of staying stuck on the fallback.
        shouldThrow = false;
        rerender(
            <SectionErrorBoundary
                scope="media-player"
                title="Player problem"
                description="Something failed"
                resetKeys={[2]}
            >
                <Child />
            </SectionErrorBoundary>
        );

        expect(screen.getByText("healthy content")).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
});
