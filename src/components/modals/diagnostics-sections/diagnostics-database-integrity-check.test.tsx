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
        vi.mocked(checkDatabaseIntegrity).mockResolvedValueOnce(true);

        renderWithMantine(<DiagnosticsDatabaseIntegrityCheck />);

        fireEvent.click(screen.getByRole("button", { name: "Run full integrity check" }));

        await waitFor(() => {
            expect(screen.getByText("No problems found")).toBeInTheDocument();
        });
    });

    it("shows a problem result when the integrity check reports an issue", async () => {
        vi.mocked(checkDatabaseIntegrity).mockResolvedValueOnce(false);

        renderWithMantine(<DiagnosticsDatabaseIntegrityCheck />);

        fireEvent.click(screen.getByRole("button", { name: "Run full integrity check" }));

        await waitFor(() => {
            expect(screen.getByText("Integrity check reported a problem")).toBeInTheDocument();
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
