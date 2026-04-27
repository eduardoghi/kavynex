import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsModal } from "./settings-modal";
import { renderWithMantine } from "../../test/test-utils";

vi.mock("../../services/library-service", () => ({
    getLibrarySummary: vi.fn(),
}));

import {
    getLibrarySummary,
    type LibrarySummaryInfo,
} from "../../services/library-service";

describe("SettingsModal", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        vi.mocked(getLibrarySummary).mockResolvedValue({
            total_bytes: 0,
            formatted_size: "0 B",
            video_files: 0,
            audio_files: 0,
            thumbnail_files: 0,
        });
    });

    it("loads and shows library summary when opened", async () => {
        vi.mocked(getLibrarySummary).mockResolvedValueOnce({
            total_bytes: 1024,
            formatted_size: "1 KB",
            video_files: 2,
            audio_files: 3,
            thumbnail_files: 4,
        });

        renderWithMantine(
            <SettingsModal
                opened
                onClose={vi.fn()}
                importMode="copy"
                libraryPath="/library"
                onChangeImportMode={vi.fn()}
                onChooseLibraryPath={vi.fn()}
                onOpenLibraryPath={vi.fn()}
                onOpenDiagnostics={vi.fn()}
                disableLibraryPathChange={false}
                libraryPathChangeDisabledReason=""
                isMigratingLibraryPath={false}
            />
        );

        await waitFor(() => {
            expect(getLibrarySummary).toHaveBeenCalledWith("/library");
        });

        expect(screen.getByDisplayValue("/library")).toBeInTheDocument();
        expect(screen.getByText("1 KB")).toBeInTheDocument();
        expect(screen.getByText("2")).toBeInTheDocument();
        expect(screen.getByText("3")).toBeInTheDocument();
        expect(screen.getByText("4")).toBeInTheDocument();
    });

    it("clears stale summary while loading a different library path", async () => {
        let resolveSecondRequest!: (value: LibrarySummaryInfo) => void;

        vi.mocked(getLibrarySummary)
            .mockResolvedValueOnce({
                total_bytes: 1024,
                formatted_size: "1 KB",
                video_files: 2,
                audio_files: 3,
                thumbnail_files: 4,
            })
            .mockImplementationOnce(
                () =>
                    new Promise<LibrarySummaryInfo>((resolve) => {
                        resolveSecondRequest = resolve;
                    })
            );

        const { rerender } = renderWithMantine(
            <SettingsModal
                opened
                onClose={vi.fn()}
                importMode="copy"
                libraryPath="/library-a"
                onChangeImportMode={vi.fn()}
                onChooseLibraryPath={vi.fn()}
                onOpenLibraryPath={vi.fn()}
                onOpenDiagnostics={vi.fn()}
                disableLibraryPathChange={false}
                libraryPathChangeDisabledReason=""
                isMigratingLibraryPath={false}
            />
        );

        await waitFor(() => {
            expect(screen.getByText("1 KB")).toBeInTheDocument();
        });

        rerender(
            <SettingsModal
                opened
                onClose={vi.fn()}
                importMode="copy"
                libraryPath="/library-b"
                onChangeImportMode={vi.fn()}
                onChooseLibraryPath={vi.fn()}
                onOpenLibraryPath={vi.fn()}
                onOpenDiagnostics={vi.fn()}
                disableLibraryPathChange={false}
                libraryPathChangeDisabledReason=""
                isMigratingLibraryPath={false}
            />
        );

        await waitFor(() => {
            expect(getLibrarySummary).toHaveBeenCalledWith("/library-b");
        });

        expect(screen.queryByText("1 KB")).not.toBeInTheDocument();
        expect(screen.getByText("Calculating...")).toBeInTheDocument();

        resolveSecondRequest({
            total_bytes: 2048,
            formatted_size: "2 KB",
            video_files: 5,
            audio_files: 6,
            thumbnail_files: 7,
        });

        await waitFor(() => {
            expect(screen.getByText("2 KB")).toBeInTheDocument();
        });
    });

    it("changes import mode", () => {
        const onChangeImportMode = vi.fn();

        renderWithMantine(
            <SettingsModal
                opened
                onClose={vi.fn()}
                importMode="copy"
                libraryPath="/library"
                onChangeImportMode={onChangeImportMode}
                onChooseLibraryPath={vi.fn()}
                onOpenLibraryPath={vi.fn()}
                onOpenDiagnostics={vi.fn()}
                disableLibraryPathChange={false}
                libraryPathChangeDisabledReason=""
                isMigratingLibraryPath={false}
            />
        );

        fireEvent.click(screen.getByLabelText("Move files into the library folder"));
        expect(onChangeImportMode).toHaveBeenCalledWith("move");
    });

    it("calls choose/open/diagnostics actions", () => {
        const onChooseLibraryPath = vi.fn();
        const onOpenLibraryPath = vi.fn();
        const onOpenDiagnostics = vi.fn();

        renderWithMantine(
            <SettingsModal
                opened
                onClose={vi.fn()}
                importMode="copy"
                libraryPath="/library"
                onChangeImportMode={vi.fn()}
                onChooseLibraryPath={onChooseLibraryPath}
                onOpenLibraryPath={onOpenLibraryPath}
                onOpenDiagnostics={onOpenDiagnostics}
                disableLibraryPathChange={false}
                libraryPathChangeDisabledReason=""
                isMigratingLibraryPath={false}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
        fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
        fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));

        expect(onChooseLibraryPath).toHaveBeenCalled();
        expect(onOpenLibraryPath).toHaveBeenCalled();
        expect(onOpenDiagnostics).toHaveBeenCalled();
    });

    it("shows disabled reason when library path change is blocked", () => {
        renderWithMantine(
            <SettingsModal
                opened
                onClose={vi.fn()}
                importMode="copy"
                libraryPath="/library"
                onChangeImportMode={vi.fn()}
                onChooseLibraryPath={vi.fn()}
                onOpenLibraryPath={vi.fn()}
                onOpenDiagnostics={vi.fn()}
                disableLibraryPathChange
                libraryPathChangeDisabledReason="Blocked right now"
                isMigratingLibraryPath={false}
            />
        );

        expect(screen.getByText("Blocked right now")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Choose folder" })).toBeDisabled();
    });

    it("shows summary error when loading fails", async () => {
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        vi.mocked(getLibrarySummary).mockRejectedValueOnce(new Error("boom"));

        renderWithMantine(
            <SettingsModal
                opened
                onClose={vi.fn()}
                importMode="copy"
                libraryPath="/library"
                onChangeImportMode={vi.fn()}
                onChooseLibraryPath={vi.fn()}
                onOpenLibraryPath={vi.fn()}
                onOpenDiagnostics={vi.fn()}
                disableLibraryPathChange={false}
                libraryPathChangeDisabledReason=""
                isMigratingLibraryPath={false}
            />
        );

        await waitFor(() => {
            expect(screen.getByText("Could not load library summary.")).toBeInTheDocument();
        });

        consoleErrorSpy.mockRestore();
    });
});