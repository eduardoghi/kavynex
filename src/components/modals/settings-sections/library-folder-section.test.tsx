import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LibraryFolderSection } from "./library-folder-section";
import { renderWithMantine } from "../../../test/test-utils";
import type { LibrarySummaryInfo } from "../../../types/generated/LibrarySummaryInfo";

const SUMMARY: LibrarySummaryInfo = {
    total_bytes: 2048,
    formatted_size: "2.0 KB",
    video_files: 3,
    audio_files: 2,
    thumbnail_files: 5,
};

type SectionProps = Parameters<typeof LibraryFolderSection>[0];

function baseProps(overrides: Partial<SectionProps> = {}): SectionProps {
    return {
        libraryPath: "/library",
        librarySummary: SUMMARY,
        isLoadingLibrarySummary: false,
        librarySummaryError: "",
        refreshLibrarySummary: vi.fn(),
        onChooseLibraryPath: vi.fn(),
        onOpenLibraryPath: vi.fn(),
        onOpenDiagnostics: vi.fn(),
        disableLibraryPathChange: false,
        libraryPathChangeDisabledReason: "",
        isMigratingLibraryPath: false,
        ...overrides,
    };
}

describe("LibraryFolderSection", () => {
    it("renders the path and the summary counters", () => {
        renderWithMantine(<LibraryFolderSection {...baseProps()} />);

        expect(screen.getByDisplayValue("/library")).toBeInTheDocument();
        expect(screen.getByText("2.0 KB")).toBeInTheDocument();
        expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("prettifies a Windows extended-length path for display", () => {
        renderWithMantine(
            <LibraryFolderSection {...baseProps({ libraryPath: "\\\\?\\C:\\Users\\me\\Library" })} />
        );

        expect(screen.getByDisplayValue("C:\\Users\\me\\Library")).toBeInTheDocument();
    });

    it("fires the folder callbacks when the buttons are clicked", () => {
        const onChoose = vi.fn();
        const onOpen = vi.fn();
        const onDiagnostics = vi.fn();

        renderWithMantine(
            <LibraryFolderSection
                {...baseProps({
                    onChooseLibraryPath: onChoose,
                    onOpenLibraryPath: onOpen,
                    onOpenDiagnostics: onDiagnostics,
                })}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));
        fireEvent.click(screen.getByRole("button", { name: /open folder/i }));
        fireEvent.click(screen.getByRole("button", { name: /diagnostics/i }));

        expect(onChoose).toHaveBeenCalledTimes(1);
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(onDiagnostics).toHaveBeenCalledTimes(1);
    });

    it("disables the summary and open actions when no library path is set", () => {
        renderWithMantine(<LibraryFolderSection {...baseProps({ libraryPath: "   " })} />);

        expect(screen.getByRole("button", { name: /refresh/i })).toBeDisabled();
        expect(screen.getByRole("button", { name: /open folder/i })).toBeDisabled();
    });

    it("disables choosing a folder and explains why when the change is blocked", () => {
        renderWithMantine(
            <LibraryFolderSection
                {...baseProps({
                    disableLibraryPathChange: true,
                    libraryPathChangeDisabledReason: "A download is in progress.",
                })}
            />
        );

        expect(screen.getByRole("button", { name: /choose folder/i })).toBeDisabled();
        expect(screen.getByText("A download is in progress.")).toBeInTheDocument();
    });

    it("shows the summary error when one is reported", () => {
        renderWithMantine(
            <LibraryFolderSection
                {...baseProps({ librarySummaryError: "Could not read the library folder." })}
            />
        );

        expect(screen.getByText("Could not read the library folder.")).toBeInTheDocument();
    });
});
