import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticsDatabaseCompaction } from "./diagnostics-database-compaction";
import { renderWithMantine } from "../../../test/test-utils";
import { compactDatabase } from "../../../services/database-service";

vi.mock("../../../services/database-service", () => ({
    compactDatabase: vi.fn(),
}));

describe("DiagnosticsDatabaseCompaction", () => {
    it("says how much space the compaction freed", async () => {
        vi.mocked(compactDatabase).mockResolvedValueOnce({
            freedBytes: 52_428_800,
            formattedFreedSize: "50.0 MB",
        });

        renderWithMantine(<DiagnosticsDatabaseCompaction />);

        fireEvent.click(screen.getByRole("button", { name: "Compact database" }));

        await waitFor(() => {
            expect(screen.getByRole("status")).toHaveTextContent("Freed 50.0 MB");
        });
    });

    it("says there was nothing to free instead of reporting zero bytes", async () => {
        vi.mocked(compactDatabase).mockResolvedValueOnce({
            freedBytes: 0,
            formattedFreedSize: "0 B",
        });

        renderWithMantine(<DiagnosticsDatabaseCompaction />);

        fireEvent.click(screen.getByRole("button", { name: "Compact database" }));

        await waitFor(() => {
            expect(screen.getByRole("status")).toHaveTextContent(
                "There was no unused space to free"
            );
        });
        expect(screen.queryByText(/Freed/)).not.toBeInTheDocument();
    });

    it("shows why the compaction failed", async () => {
        vi.mocked(compactDatabase).mockRejectedValueOnce(new Error("database or disk is full"));

        renderWithMantine(<DiagnosticsDatabaseCompaction />);

        fireEvent.click(screen.getByRole("button", { name: "Compact database" }));

        await waitFor(() => {
            expect(screen.getByRole("status")).not.toBeEmptyDOMElement();
        });
        expect(screen.queryByText(/Freed/)).not.toBeInTheDocument();
    });
});
