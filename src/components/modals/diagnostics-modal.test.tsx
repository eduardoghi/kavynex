import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticsModal } from "./diagnostics-modal";
import { renderWithMantine } from "../../test/test-utils";
import type { DiagnosticsSummary } from "../../types/diagnostics";

function createSummary(): DiagnosticsSummary {
    return {
        diagnostics: {
            appVersion: "0.1.0",
            platform: "windows",
            arch: "x86_64",
            libraryPath: "/library",
            importMode: "copy",
            externalTools: {
                yt_dlp: {
                    path: "/tools/yt-dlp",
                    version: "2026.01.01",
                    healthy: true,
                    release_age_days: null,
                },
                ffmpeg: {
                    path: "/tools/ffmpeg",
                    version: "7.0",
                    healthy: false,
                    release_age_days: null,
                },
            },
            librarySummary: {
                total_bytes: 2048,
                formatted_size: "2 KB",
                video_files: 5,
                audio_files: 1,
                thumbnail_files: 4,
            },
            liveChatStorage: {
                live_chat_files: 2,
            },
            mediaRepositoryStats: {
                total_media: 6,
                total_video_media: 5,
                total_audio_media: 1,
                total_with_thumbnail: 4,
                total_without_thumbnail: 2,
                total_watched: 3,
                total_unwatched: 3,
                total_live_media: 1,
                total_with_live_chat: 1,
                total_without_live_chat: 5,
                total_media_with_live_chat_flag_but_no_path: 0,
                total_media_with_live_chat_path_but_not_live: 0,
            },
            libraryIntegrity: {
                checked_media_files: 6,
                missing_media_files: 1,
                missing_media_examples: ["video/missing.mp4"],
                checked_thumbnail_files: 4,
                missing_thumbnail_files: 1,
                missing_thumbnail_examples: ["thumbnails/missing.jpg"],
                orphan_media_files: 0,
                orphan_media_examples: [],
                orphan_thumbnail_files: 0,
                orphan_thumbnail_examples: [],
                invalid_media_files: 0,
                invalid_media_examples: [],
                invalid_thumbnail_files: 0,
                invalid_thumbnail_examples: [],
                corrupt_media_files: 0,
                corrupt_media_examples: [],
                corrupt_thumbnail_files: 0,
                corrupt_thumbnail_examples: [],
                checked_live_chat_files: 0,
                missing_live_chat_files: 0,
                missing_live_chat_examples: [],
                corrupt_live_chat_files: 0,
                corrupt_live_chat_examples: [],
                orphan_live_chat_files: 0,
                orphan_live_chat_examples: [],
                invalid_live_chat_files: 0,
                invalid_live_chat_examples: [],
            },
            liveChatIntegrity: {
                checked_live_chat_files: 1,
                missing_live_chat_files: 0,
                missing_live_chat_examples: [],
                corrupt_live_chat_files: 0,
                corrupt_live_chat_examples: [],
                orphan_live_chat_files: 0,
                orphan_live_chat_examples: [],
            },
        },
        issues: [
            {
                code: "missing-media",
                severity: "warning",
                title: "Missing media file",
                description: "One media file is missing from disk.",
            },
        ],
        overview: {
            status: "warning",
            issueCount: 1,
            errorCount: 0,
            warningCount: 1,
            infoCount: 0,
            headline: "Attention needed",
            description: "Some issues were detected.",
        },
    };
}

describe("DiagnosticsModal", () => {
    it("shows loading state when there is no summary yet", () => {
        renderWithMantine(
            <DiagnosticsModal
                opened
                onClose={vi.fn()}
                onReload={vi.fn()}
                loading
                summary={null}
            />
        );

        expect(screen.getByText("Loading diagnostics.")).toBeInTheDocument();
    });

    it("renders diagnostics summary details", () => {
        renderWithMantine(
            <DiagnosticsModal
                opened
                onClose={vi.fn()}
                onReload={vi.fn()}
                loading={false}
                summary={createSummary()}
            />
        );

        expect(screen.getByText("Attention needed")).toBeInTheDocument();
        expect(screen.getByText("Some issues were detected.")).toBeInTheDocument();
        expect(screen.getByText("/library")).toBeInTheDocument();
        // The four library figures share one line now. Asserting the whole line also pins the
        // singular, since one audio file must not read as "1 audios".
        expect(
            screen.getByText("2 KB · 5 videos · 1 audio · 4 thumbnails")
        ).toBeInTheDocument();
        expect(screen.getByText("0.1.0")).toBeInTheDocument();
        expect(screen.getByText("windows · x86_64")).toBeInTheDocument();
        expect(screen.getByText("Missing media file")).toBeInTheDocument();
        expect(screen.getByText("video/missing.mp4")).toBeInTheDocument();
        expect(screen.getByText("thumbnails/missing.jpg")).toBeInTheDocument();
    });

    it("keeps current summary visible while refreshing", () => {
        renderWithMantine(
            <DiagnosticsModal
                opened
                onClose={vi.fn()}
                onReload={vi.fn()}
                loading
                summary={createSummary()}
            />
        );

        expect(screen.getByText("Refreshing diagnostics...")).toBeInTheDocument();
        expect(screen.getByText("Attention needed")).toBeInTheDocument();
        expect(screen.getByText("Missing media file")).toBeInTheDocument();
    });

    it("calls reload action", () => {
        const onReload = vi.fn();

        renderWithMantine(
            <DiagnosticsModal
                opened
                onClose={vi.fn()}
                onReload={onReload}
                loading={false}
                summary={createSummary()}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

        expect(onReload).toHaveBeenCalledTimes(1);
    });

    it("shows no issues message when issue list is empty", () => {
        const summary = createSummary();

        summary.issues = [];
        summary.overview.issueCount = 0;
        summary.overview.warningCount = 0;
        summary.overview.status = "healthy";
        summary.overview.headline = "Everything looks good";
        summary.overview.description = "No blocking issues were detected.";

        renderWithMantine(
            <DiagnosticsModal
                opened
                onClose={vi.fn()}
                onReload={vi.fn()}
                loading={false}
                summary={summary}
            />
        );

        // The Issues section does not render at all without issues, so neither does the
        // card that used to say the environment looks healthy. The status line at the top
        // is what reports a clean run now.
        expect(screen.queryByText("No issues detected")).not.toBeInTheDocument();
        expect(screen.getByText("Everything looks good")).toBeInTheDocument();
    });

    it("shows empty idle state when not loading and there is no summary", () => {
        renderWithMantine(
            <DiagnosticsModal
                opened
                onClose={vi.fn()}
                onReload={vi.fn()}
                loading={false}
                summary={null}
            />
        );

        expect(screen.getByText("No diagnostics loaded")).toBeInTheDocument();
    });
    it("reveals the log folder from the button", () => {
        const onOpenLogFolder = vi.fn();

        renderWithMantine(
            <DiagnosticsModal
                opened
                onClose={vi.fn()}
                onReload={vi.fn()}
                loading={false}
                summary={createSummary()}
                onOpenLogFolder={onOpenLogFolder}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "Open log folder" }));

        expect(onOpenLogFolder).toHaveBeenCalledTimes(1);
    });

    it("omits the log folder button when no handler is supplied", () => {
        // The prop is optional so the modal renders bare in isolation; rendering a dead button in
        // that case would be worse than rendering none.
        renderWithMantine(
            <DiagnosticsModal
                opened
                onClose={vi.fn()}
                onReload={vi.fn()}
                loading={false}
                summary={createSummary()}
            />
        );

        expect(screen.queryByRole("button", { name: "Open log folder" })).not.toBeInTheDocument();
    });

    it("disables the log folder button while it is opening", () => {
        // `loading` alone would rely on Mantine having re-rendered before the next click lands,
        // which is a promise about timing rather than about state, and a second click here spawns
        // a second file-manager window. Same reasoning as the update-check button in Settings.
        const onOpenLogFolder = vi.fn();

        renderWithMantine(
            <DiagnosticsModal
                opened
                onClose={vi.fn()}
                onReload={vi.fn()}
                loading={false}
                summary={createSummary()}
                onOpenLogFolder={onOpenLogFolder}
                openingLogFolder
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "Open log folder" }));

        expect(onOpenLogFolder).not.toHaveBeenCalled();
    });

    it("keeps the log folder button usable while diagnostics are refreshing", () => {
        // The two actions have separate in-flight flags on purpose: reaching the log folder is most
        // useful exactly when a refresh is grinding or has just failed.
        const onOpenLogFolder = vi.fn();

        renderWithMantine(
            <DiagnosticsModal
                opened
                onClose={vi.fn()}
                onReload={vi.fn()}
                loading
                summary={createSummary()}
                onOpenLogFolder={onOpenLogFolder}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "Open log folder" }));

        expect(onOpenLogFolder).toHaveBeenCalledTimes(1);
    });
});
