import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticsIssuesSection } from "./diagnostics-issues-section";
import { renderWithMantine } from "../../../test/test-utils";
import type { DiagnosticsIssue } from "../../../types/diagnostics";

describe("DiagnosticsIssuesSection", () => {
    it("renders a media example path as a button that jumps to that media", () => {
        const onOpenMedia = vi.fn();
        const issues: DiagnosticsIssue[] = [
            {
                code: "MISSING_MEDIA_FILES_ON_DISK",
                severity: "warning",
                title: "Some media files are missing on disk",
                description: "1 media file(s) referenced by the database were not found.",
                examples: [
                    { path: "audio/youtube_x_140.m4a", media: { channelId: 7, mediaId: 42 } },
                ],
            },
        ];

        renderWithMantine(<DiagnosticsIssuesSection issues={issues} onOpenMedia={onOpenMedia} />);

        const button = screen.getByRole("button", { name: "audio/youtube_x_140.m4a" });
        fireEvent.click(button);

        expect(onOpenMedia).toHaveBeenCalledWith({ channelId: 7, mediaId: 42 });
    });

    it("renders a plain, non-clickable path for an example without a media target", () => {
        const issues: DiagnosticsIssue[] = [
            {
                code: "ORPHAN_MEDIA_FILES",
                severity: "info",
                title: "Orphan media files were found",
                description: "1 media file(s) exist without a linked database record.",
                examples: [{ path: "video/orphan.mp4" }],
            },
        ];

        renderWithMantine(<DiagnosticsIssuesSection issues={issues} onOpenMedia={vi.fn()} />);

        expect(screen.getByText("video/orphan.mp4")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "video/orphan.mp4" })).toBeNull();
    });

    it("does not make a media example clickable when no onOpenMedia handler is given", () => {
        const issues: DiagnosticsIssue[] = [
            {
                code: "MISSING_MEDIA_FILES_ON_DISK",
                severity: "warning",
                title: "Some media files are missing on disk",
                description: "1 media file(s) referenced by the database were not found.",
                examples: [{ path: "audio/x.m4a", media: { channelId: 1, mediaId: 2 } }],
            },
        ];

        renderWithMantine(<DiagnosticsIssuesSection issues={issues} />);

        expect(screen.getByText("audio/x.m4a")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "audio/x.m4a" })).toBeNull();
    });
});
