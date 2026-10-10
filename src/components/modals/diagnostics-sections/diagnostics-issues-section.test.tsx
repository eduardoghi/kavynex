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

    it("renders a plain path when there is neither a media target nor a reveal handler", () => {
        // Both actions are absent here, which is the only remaining way a path stays inert. An
        // orphan has no media row by definition, and no onRevealPath is supplied.
        const issues: DiagnosticsIssue[] = [
            {
                code: "ORPHAN_MEDIA_FILES",
                severity: "info",
                title: "Orphan media files were found",
                description: "1 media file(s) exist without a linked database record.",
                examples: [{ path: "video/orphan.mp4" }],
                examplesAreOnDisk: true,
            },
        ];

        renderWithMantine(<DiagnosticsIssuesSection issues={issues} onOpenMedia={vi.fn()} />);

        expect(screen.getByText("video/orphan.mp4")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "video/orphan.mp4" })).toBeNull();
    });

    it("reveals an orphan path in the file manager when the issue's files are on disk", () => {
        // A content-addressed name is not one to find by hand, so the path itself shows the file.
        const onRevealPath = vi.fn();
        const issues: DiagnosticsIssue[] = [
            {
                code: "ORPHAN_MEDIA_FILES",
                severity: "info",
                title: "Orphan media files were found",
                description: "1 media file(s) exist without a linked database record.",
                examples: [{ path: "video/orphan.mp4" }],
                examplesAreOnDisk: true,
            },
        ];

        renderWithMantine(
            <DiagnosticsIssuesSection issues={issues} onRevealPath={onRevealPath} />
        );

        fireEvent.click(screen.getByRole("button", { name: "video/orphan.mp4" }));

        expect(onRevealPath).toHaveBeenCalledWith("video/orphan.mp4");
    });

    it("offers no reveal for an issue whose paths are not on disk, even with a handler", () => {
        // The gate is the issue, not the example. A missing thumbnail carries no media target
        // either, so keying the reveal off that absence would offer it here, on a file that is not
        // there, producing a link that fails every time it is clicked.
        const onRevealPath = vi.fn();
        const issues: DiagnosticsIssue[] = [
            {
                code: "MISSING_THUMBNAIL_FILES_ON_DISK",
                severity: "info",
                title: "Some thumbnail files are missing on disk",
                description: "1 thumbnail file(s) referenced by the database were not found.",
                examples: [{ path: "thumbnails/gone.jpg" }],
            },
        ];

        renderWithMantine(
            <DiagnosticsIssuesSection issues={issues} onRevealPath={onRevealPath} />
        );

        expect(screen.getByText("thumbnails/gone.jpg")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "thumbnails/gone.jpg" })).toBeNull();
        expect(onRevealPath).not.toHaveBeenCalled();
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

    it("offers one orphan removal, under the first orphan issue it covers", () => {
        const onRemoveOrphans = vi.fn();
        const issues: DiagnosticsIssue[] = [
            {
                code: "ORPHAN_LIVE_CHAT_FILES",
                severity: "info",
                title: "Orphan live chat files were found",
                description: "1 live chat file(s) exist without a linked media record.",
            },
            {
                code: "ORPHAN_MEDIA_FILES",
                severity: "info",
                title: "Orphan media files were found",
                description: "1 media file(s) exist without a linked database record.",
            },
            {
                code: "ORPHAN_THUMBNAIL_FILES",
                severity: "info",
                title: "Orphan thumbnail files were found",
                description: "1 thumbnail file(s) exist without a linked database record.",
            },
        ];

        renderWithMantine(
            <DiagnosticsIssuesSection issues={issues} onRemoveOrphans={onRemoveOrphans} />
        );

        const buttons = screen.getAllByRole("button", { name: "Remove orphan files" });
        expect(buttons).toHaveLength(1);

        fireEvent.click(buttons[0]!);
        expect(onRemoveOrphans).toHaveBeenCalledTimes(1);
    });

    it("offers no removal without a handler or without a removable orphan issue", () => {
        const liveChatOnly: DiagnosticsIssue[] = [
            {
                code: "ORPHAN_LIVE_CHAT_FILES",
                severity: "info",
                title: "Orphan live chat files were found",
                description: "1 live chat file(s) exist without a linked media record.",
            },
        ];

        renderWithMantine(
            <DiagnosticsIssuesSection issues={liveChatOnly} onRemoveOrphans={vi.fn()} />
        );

        expect(screen.queryByRole("button", { name: "Remove orphan files" })).toBeNull();
    });
});
