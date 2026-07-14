import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { AppErrorBoundary } from "./app-error-boundary";

vi.mock("../../lib/tauri-platform", () => ({
    relaunch: vi.fn(),
}));

vi.mock("../../utils/global-error-reporting", () => ({
    reportFatalError: vi.fn(),
}));

import { relaunch } from "../../lib/tauri-platform";
import { reportFatalError } from "../../utils/global-error-reporting";

function CrashingChild({ shouldThrow }: { shouldThrow: boolean }): JSX.Element {
    if (shouldThrow) {
        throw new Error("render exploded");
    }

    return <div>healthy content</div>;
}

describe("AppErrorBoundary", () => {
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
        render(
            <AppErrorBoundary>
                <CrashingChild shouldThrow={false} />
            </AppErrorBoundary>
        );

        expect(screen.getByText("healthy content")).toBeInTheDocument();
        expect(reportFatalError).not.toHaveBeenCalled();
    });

    it("shows the recovery screen and reports the error when a child crashes", () => {
        render(
            <AppErrorBoundary>
                <CrashingChild shouldThrow={true} />
            </AppErrorBoundary>
        );

        expect(screen.getByRole("alert")).toBeInTheDocument();
        expect(screen.getByText("Something went wrong")).toBeInTheDocument();
        // The raw crash message is preserved but labelled as diagnostic text rather than
        // shown as a bare, instruction-like line.
        expect(screen.getByText("Technical details: render exploded")).toBeInTheDocument();
        expect(reportFatalError).toHaveBeenCalledWith(
            "error-boundary",
            expect.stringContaining("A render error crashed the app."),
            expect.objectContaining({ message: "render exploded" })
        );
    });

    it("relaunches the app when restart is clicked", async () => {
        vi.mocked(relaunch).mockResolvedValue(undefined);
        const user = userEvent.setup();

        render(
            <AppErrorBoundary>
                <CrashingChild shouldThrow={true} />
            </AppErrorBoundary>
        );

        await user.click(screen.getByRole("button", { name: "Restart app" }));

        expect(relaunch).toHaveBeenCalledTimes(1);
    });

    it("re-renders children when try again is clicked", async () => {
        const user = userEvent.setup();
        let shouldThrow = true;

        function Child(): JSX.Element {
            return <CrashingChild shouldThrow={shouldThrow} />;
        }

        render(
            <AppErrorBoundary>
                <Child />
            </AppErrorBoundary>
        );

        expect(screen.getByRole("alert")).toBeInTheDocument();

        shouldThrow = false;
        await user.click(screen.getByRole("button", { name: "Try again" }));

        expect(screen.getByText("healthy content")).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
});
