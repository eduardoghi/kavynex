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
            },
            liveChatIntegrity: {
                checked_live_chat_files: 1,
                missing_live_chat_files: 0,
                missing_live_chat_examples: [],
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
        expect(screen.getByText("2 KB")).toBeInTheDocument();
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

        expect(screen.getAllByText("No issues detected")).toHaveLength(2);
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
});