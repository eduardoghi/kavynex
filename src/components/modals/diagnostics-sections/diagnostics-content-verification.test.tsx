import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsContentVerification } from "./diagnostics-content-verification";
import { renderWithMantine } from "../../../test/test-utils";
import type { ContentVerificationReport } from "../../../types/generated/ContentVerificationReport";

const verify = vi.fn();
const cancel = vi.fn();
let hookState: {
    running: boolean;
    progress: { checked: number; total: number } | null;
    result: { status: "done"; report: ContentVerificationReport } | { status: "error"; message: string } | null;
};

vi.mock("../../../hooks/use-library-verification", () => ({
    useLibraryVerification: () => ({ ...hookState, verify, cancel }),
}));

function report(overrides: Partial<ContentVerificationReport> = {}): ContentVerificationReport {
    return {
        checked: 10,
        verified: 10,
        corrupt: 0,
        corruptExamples: [],
        unverifiable: 0,
        unverifiableExamples: [],
        unreadable: 0,
        unreadableExamples: [],
        cancelled: false,
        ...overrides,
    };
}

describe("DiagnosticsContentVerification", () => {
    beforeEach(() => {
        verify.mockReset();
        cancel.mockReset();
        hookState = { running: false, progress: null, result: null };
    });

    it("runs the check against the configured library folder", async () => {
        renderWithMantine(<DiagnosticsContentVerification libraryPath="/library" />);

        await userEvent.click(screen.getByRole("button", { name: "Verify saved files" }));

        expect(verify).toHaveBeenCalledWith("/library");
    });

    it("cannot be started without a library folder", () => {
        renderWithMantine(<DiagnosticsContentVerification libraryPath="" />);

        expect(screen.getByRole("button", { name: "Verify saved files" })).toBeDisabled();
    });

    it("shows the count alongside the bar while running", () => {
        // The count is what keeps a large library from looking stuck: the percentage moves slowly
        // enough to read as frozen, and "412 of 3208" visibly does not.
        hookState = { running: true, progress: { checked: 412, total: 3208 }, result: null };

        renderWithMantine(<DiagnosticsContentVerification libraryPath="/library" />);

        expect(screen.getByText("412 of 3208 file(s)")).toBeInTheDocument();
        expect(screen.getByText("13%")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    });

    it("offers no stop button when nothing is running", () => {
        renderWithMantine(<DiagnosticsContentVerification libraryPath="/library" />);

        expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    });

    it("reports a clean run", () => {
        hookState = { running: false, progress: null, result: { status: "done", report: report() } };

        renderWithMantine(<DiagnosticsContentVerification libraryPath="/library" />);

        expect(
            screen.getByText("All 10 checked file(s) match the content they were saved with")
        ).toBeInTheDocument();
    });

    it("names the damaged files and says what to do about them", () => {
        hookState = {
            running: false,
            progress: null,
            result: {
                status: "done",
                report: report({
                    verified: 8,
                    corrupt: 2,
                    corruptExamples: ["video/media_abc.mp4", "thumbnails/thumb_abc.jpg"],
                }),
            },
        };

        renderWithMantine(<DiagnosticsContentVerification libraryPath="/library" />);

        expect(
            screen.getByText("2 file(s) do not match the content they were saved with")
        ).toBeInTheDocument();
        expect(screen.getByText("video/media_abc.mp4")).toBeInTheDocument();
        expect(screen.getByText(/Re-download them if the source is still available/)).toBeInTheDocument();
    });

    it("never presents a cancelled run as a clean result", () => {
        // The one way this check could do harm: reporting "no problems" over files it never opened.
        // A cancelled run found no corruption *and* checked almost nothing, and the first half must
        // not be shown without the second.
        hookState = {
            running: false,
            progress: null,
            result: {
                status: "done",
                report: report({ checked: 4, verified: 4, cancelled: true }),
            },
        };

        renderWithMantine(<DiagnosticsContentVerification libraryPath="/library" />);

        expect(screen.getByText(/Stopped early: 4 file\(s\) checked/)).toBeInTheDocument();
        expect(screen.getByText(/This is not a clean result/)).toBeInTheDocument();
        expect(screen.queryByText(/match the content they were saved with/)).not.toBeInTheDocument();
    });

    it("explains the files it could not check rather than counting them as damage", () => {
        hookState = {
            running: false,
            progress: null,
            result: {
                status: "done",
                report: report({
                    verified: 9,
                    unverifiable: 1,
                    unverifiableExamples: ["video/holiday.mp4"],
                }),
            },
        };

        renderWithMantine(<DiagnosticsContentVerification libraryPath="/library" />);

        expect(
            screen.getByText(/1 file\(s\) could not be checked because their names/)
        ).toBeInTheDocument();
    });

    it("shows a failure message", () => {
        hookState = {
            running: false,
            progress: null,
            result: { status: "error", message: "A library check is already running." },
        };

        renderWithMantine(<DiagnosticsContentVerification libraryPath="/library" />);

        expect(screen.getByText("A library check is already running.")).toBeInTheDocument();
    });
});
