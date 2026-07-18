import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DatabaseSection } from "./database-section";
import { renderWithMantine } from "../../../test/test-utils";

type SectionProps = Parameters<typeof DatabaseSection>[0];

function baseProps(overrides: Partial<SectionProps> = {}): SectionProps {
    return {
        databaseBusy: "idle",
        databaseMessage: null,
        pendingImportPath: null,
        exportDatabaseAction: vi.fn(),
        pickImportFileAction: vi.fn(),
        confirmImportAction: vi.fn(),
        cancelImport: vi.fn(),
        canUndoImport: false,
        isUndoImportConfirmOpen: false,
        requestUndoImport: vi.fn(),
        cancelUndoImport: vi.fn(),
        confirmUndoImportAction: vi.fn(),
        externalBackupDir: "",
        isSavingExternalBackupDir: false,
        onChooseExternalBackupDir: vi.fn(),
        onClearExternalBackupDir: vi.fn(),
        ...overrides,
    };
}

describe("DatabaseSection", () => {
    it("runs export and import from their buttons", () => {
        const exportDatabaseAction = vi.fn();
        const pickImportFileAction = vi.fn();

        renderWithMantine(
            <DatabaseSection {...baseProps({ exportDatabaseAction, pickImportFileAction })} />
        );

        fireEvent.click(screen.getByRole("button", { name: /export database/i }));
        fireEvent.click(screen.getByRole("button", { name: /import database/i }));

        expect(exportDatabaseAction).toHaveBeenCalledTimes(1);
        expect(pickImportFileAction).toHaveBeenCalledTimes(1);
    });

    it("disables the actions while a database operation is running", () => {
        renderWithMantine(<DatabaseSection {...baseProps({ databaseBusy: "exporting" })} />);

        expect(screen.getByRole("button", { name: /export database/i })).toBeDisabled();
        expect(screen.getByRole("button", { name: /import database/i })).toBeDisabled();
    });

    it("only offers the undo action when an import can be undone", () => {
        const { rerender } = renderWithMantine(<DatabaseSection {...baseProps()} />);

        expect(
            screen.queryByRole("button", { name: /undo last import/i })
        ).not.toBeInTheDocument();

        rerender(<DatabaseSection {...baseProps({ canUndoImport: true })} />);

        expect(
            screen.getByRole("button", { name: /undo last import/i })
        ).toBeInTheDocument();
    });

    it("confirms and cancels a pending import", () => {
        const confirmImportAction = vi.fn();
        const cancelImport = vi.fn();

        renderWithMantine(
            <DatabaseSection
                {...baseProps({
                    pendingImportPath: "/tmp/other.db",
                    confirmImportAction,
                    cancelImport,
                })}
            />
        );

        expect(screen.getByText("Replace the current database?")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /replace and restart/i }));
        fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

        expect(confirmImportAction).toHaveBeenCalledTimes(1);
        expect(cancelImport).toHaveBeenCalledTimes(1);
    });

    it("confirms an undo from its confirmation prompt", () => {
        const confirmUndoImportAction = vi.fn();

        renderWithMantine(
            <DatabaseSection
                {...baseProps({
                    canUndoImport: true,
                    isUndoImportConfirmOpen: true,
                    confirmUndoImportAction,
                })}
            />
        );

        expect(screen.getByText("Undo the last database import?")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /undo and restart/i }));

        expect(confirmUndoImportAction).toHaveBeenCalledTimes(1);
    });

    it("shows a database status message", () => {
        renderWithMantine(
            <DatabaseSection
                {...baseProps({
                    databaseMessage: { tone: "success", text: "Database exported successfully." },
                })}
            />
        );

        expect(screen.getByText("Database exported successfully.")).toBeInTheDocument();
    });

    it("chooses an external backup folder and offers no turn-off while none is set", () => {
        const onChooseExternalBackupDir = vi.fn();

        renderWithMantine(
            <DatabaseSection {...baseProps({ onChooseExternalBackupDir })} />
        );

        expect(
            screen.queryByRole("button", { name: /turn off/i })
        ).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /choose backup folder/i }));

        expect(onChooseExternalBackupDir).toHaveBeenCalledTimes(1);
    });

    it("shows the current external backup folder and can turn it off", () => {
        const onClearExternalBackupDir = vi.fn();

        renderWithMantine(
            <DatabaseSection
                {...baseProps({
                    externalBackupDir: "/mnt/backups",
                    onClearExternalBackupDir,
                })}
            />
        );

        expect(screen.getByDisplayValue("/mnt/backups")).toBeInTheDocument();
        // With a folder configured, the button flips to "Change backup folder" and a turn-off appears.
        expect(
            screen.getByRole("button", { name: /change backup folder/i })
        ).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /turn off/i }));

        expect(onClearExternalBackupDir).toHaveBeenCalledTimes(1);
    });
});
