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

    it("reports itself busy while the rewrite runs, so the modal can stay open", async () => {
        let finish: () => void = () => {};
        vi.mocked(compactDatabase).mockReturnValueOnce(
            new Promise((resolve) => {
                finish = () => resolve({ freedBytes: 0, formattedFreedSize: "0 B" });
            })
        );
        const onBusyChange = vi.fn();

        renderWithMantine(<DiagnosticsDatabaseCompaction onBusyChange={onBusyChange} />);
        fireEvent.click(screen.getByRole("button", { name: "Compact database" }));

        await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));

        finish();

        await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
    });

    it("shows why the compaction was refused", async () => {
        vi.mocked(compactDatabase).mockRejectedValueOnce({
            code: "DATABASE_COMPACTION_REFUSED",
            message: "the database was not compacted",
            details: "the disk holding the database does not have room for the rewritten copy",
        });

        renderWithMantine(<DiagnosticsDatabaseCompaction />);

        fireEvent.click(screen.getByRole("button", { name: "Compact database" }));

        await waitFor(() => {
            expect(screen.getByRole("status")).toHaveTextContent("does not have room");
        });
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
