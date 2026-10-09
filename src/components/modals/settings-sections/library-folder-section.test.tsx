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

    it("offers to try again, and keeps the folder shown, while it cannot be reached", () => {
        const onRetry = vi.fn();

        renderWithMantine(
            <LibraryFolderSection
                {...baseProps({ isLibraryUnreachable: true, onRetryLibraryFolder: onRetry })}
            />
        );

        expect(screen.getByDisplayValue("/library")).toBeInTheDocument();
        expect(screen.getByText("The library folder cannot be reached")).toBeInTheDocument();
        // Revealing a folder that is not there would only fail.
        expect(screen.getByRole("button", { name: /open folder/i })).toBeDisabled();

        fireEvent.click(screen.getByRole("button", { name: /try again/i }));

        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it("shows nothing about reaching the folder while it is reachable", () => {
        renderWithMantine(<LibraryFolderSection {...baseProps()} />);

        expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
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

    it("explains nothing when the change is not blocked, even with a reason on hand", () => {
        // The other direction of the same guard, and the one nothing asserted. The reason prop is
        // deliberately non-empty here. The caller keeps its last value around, so "there is a reason
        // string" must not be what decides whether the alert renders. Being blocked is. A guard
        // weakened to always-true puts a stale explanation under the buttons while they are enabled,
        // which reads as the app refusing an action it is in fact offering.
        renderWithMantine(
            <LibraryFolderSection
                {...baseProps({
                    disableLibraryPathChange: false,
                    libraryPathChangeDisabledReason: "A download is in progress.",
                })}
            />
        );

        expect(screen.getByRole("button", { name: /choose folder/i })).toBeEnabled();
        expect(screen.queryByText("A download is in progress.")).not.toBeInTheDocument();
    });

    it("asks before moving, naming the destination and what will be copied", () => {
        const onConfirmLibraryMove = vi.fn();
        const onCancelLibraryMove = vi.fn();

        renderWithMantine(
            <LibraryFolderSection
                {...baseProps({
                    pendingLibraryMove: {
                        currentLibraryPath: "/library",
                        destination: "\\\\?\\E:\\Library",
                        summary: { ...SUMMARY, video_files: 1 },
                        currentFolderUnreachable: false,
                    },
                    onConfirmLibraryMove,
                    onCancelLibraryMove,
                })}
            />
        );

        expect(screen.getByText("Move the library to E:\\Library?")).toBeInTheDocument();
        expect(
            screen.getByText(/2\.0 KB in 1 video file, 2 audio files and 5 thumbnails will be copied there/)
        ).toBeInTheDocument();
        // A second folder cannot be chosen while one is waiting for an answer.
        expect(screen.getByRole("button", { name: /choose folder/i })).toBeDisabled();

        fireEvent.click(screen.getByRole("button", { name: /move library/i }));
        expect(onConfirmLibraryMove).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onCancelLibraryMove).toHaveBeenCalledTimes(1);
    });

    it("shows the copy's progress and a way to stop it while the move runs", () => {
        const onCancelRunningLibraryMove = vi.fn();

        renderWithMantine(
            <LibraryFolderSection
                {...baseProps({
                    isMigratingLibraryPath: true,
                    pendingLibraryMove: {
                        currentLibraryPath: "/library",
                        destination: "/new-library",
                        summary: SUMMARY,
                        currentFolderUnreachable: false,
                    },
                    libraryMoveProgress: {
                        copiedFiles: 3,
                        totalFiles: 10,
                        copiedBytes: 1024,
                        totalBytes: 2048,
                    },
                    onCancelRunningLibraryMove,
                })}
            />
        );

        expect(screen.getByText("Copied 3 of 10 files")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /move library/i })).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /cancel move/i }));
        expect(onCancelRunningLibraryMove).toHaveBeenCalledTimes(1);
    });

    it("says nothing will move when the current folder cannot be reached", () => {
        const onConfirmLibraryMove = vi.fn();

        renderWithMantine(
            <LibraryFolderSection
                {...baseProps({
                    pendingLibraryMove: {
                        currentLibraryPath: "/library",
                        destination: "/new-library",
                        summary: null,
                        currentFolderUnreachable: true,
                    },
                    onConfirmLibraryMove,
                })}
            />
        );

        expect(screen.getByText("The current library folder cannot be reached")).toBeInTheDocument();
        expect(screen.getByText(/moves nothing/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /use the new folder anyway/i }));
        expect(onConfirmLibraryMove).toHaveBeenCalledTimes(1);
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
