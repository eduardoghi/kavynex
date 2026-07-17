import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticsDatabaseIntegrityCheck } from "./diagnostics-database-integrity-check";
import { renderWithMantine } from "../../../test/test-utils";
import { checkDatabaseIntegrity } from "../../../services/database-service";

vi.mock("../../../services/database-service", () => ({
    checkDatabaseIntegrity: vi.fn(),
}));

describe("DiagnosticsDatabaseIntegrityCheck", () => {
    it("shows a healthy result when the integrity check reports ok", async () => {
        vi.mocked(checkDatabaseIntegrity).mockResolvedValueOnce({
            ok: true,
            problems: [],
            truncated: false,
        });

        renderWithMantine(<DiagnosticsDatabaseIntegrityCheck />);

        fireEvent.click(screen.getByRole("button", { name: "Run full integrity check" }));

        await waitFor(() => {
            expect(screen.getByText("No problems found")).toBeInTheDocument();
        });

        // The outcome lives in a polite live region so screen readers announce it.
        const liveRegion = screen.getByRole("status");
        expect(liveRegion).toHaveAttribute("aria-live", "polite");
        expect(liveRegion).toHaveTextContent("No problems found");
    });

    it("shows what sqlite reported and how to recover when the check finds a problem", async () => {
        vi.mocked(checkDatabaseIntegrity).mockResolvedValueOnce({
            ok: false,
            problems: ["row 3 missing from index idx_videos_channel_id", "page 42 is never used"],
            truncated: false,
        });

        renderWithMantine(<DiagnosticsDatabaseIntegrityCheck />);

        fireEvent.click(screen.getByRole("button", { name: "Run full integrity check" }));

        await waitFor(() => {
            expect(screen.getByText("Integrity check reported a problem")).toBeInTheDocument();
        });

        // The detail is the point of the report: "there is a problem" on its own leaves nothing to
        // act on or to paste into a bug report.
        expect(
            screen.getByText(/row 3 missing from index idx_videos_channel_id/)
        ).toBeInTheDocument();
        expect(screen.getByText(/page 42 is never used/)).toBeInTheDocument();
        expect(screen.getByText(/restore the database from a backup/)).toBeInTheDocument();
    });

    it("says when the problem list was cut short", async () => {
        vi.mocked(checkDatabaseIntegrity).mockResolvedValueOnce({
            ok: false,
            problems: ["page 1 is damaged", "page 2 is damaged"],
            truncated: true,
        });

        renderWithMantine(<DiagnosticsDatabaseIntegrityCheck />);

        fireEvent.click(screen.getByRole("button", { name: "Run full integrity check" }));

        // A capped list presented as the whole story would understate the damage.
        await waitFor(() => {
            expect(screen.getByText("Only the first 2 problems are shown.")).toBeInTheDocument();
        });
    });

    it("shows an error message when the command fails", async () => {
        vi.mocked(checkDatabaseIntegrity).mockRejectedValueOnce(new Error("boom"));

        renderWithMantine(<DiagnosticsDatabaseIntegrityCheck />);

        fireEvent.click(screen.getByRole("button", { name: "Run full integrity check" }));

        await waitFor(() => {
            expect(screen.getByText("Failed to run the integrity check.")).toBeInTheDocument();
        });
    });
});
