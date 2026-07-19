import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { YtDlpTerminal } from "./yt-dlp-terminal";
import type { YtDlpLogLine } from "../../../hooks/use-yt-dlp-events";
import { renderWithMantine } from "../../../test/test-utils";

// The terminal keys rows on a stable per-line id (see YtDlpLogLine); the ids are arbitrary here, so
// number them positionally.
function logs(...texts: string[]): YtDlpLogLine[] {
    return texts.map((text, index) => ({ id: index, text }));
}

describe("YtDlpTerminal", () => {
    it("returns null when not visible", () => {
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible={false}
                ytDlpLogs={[]}
                isYtDlpRunning={false}
            />
        );

        expect(screen.queryByText("Integrated terminal")).not.toBeInTheDocument();
    });

    it("shows idle state with empty log", () => {
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={[]}
                isYtDlpRunning={false}
            />
        );

        expect(screen.getByText("Integrated terminal")).toBeInTheDocument();
        expect(screen.getByText("idle")).toBeInTheDocument();
        expect(screen.getByText("The yt-dlp execution log will appear here.")).toBeInTheDocument();
    });

    it("shows running state", () => {
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={logs("Downloading...")}
                isYtDlpRunning
            />
        );

        expect(screen.getByText("running")).toBeInTheDocument();
        // The latest line is rendered both in the scrollback and in the hidden live region below,
        // so it appears more than once by design.
        expect(screen.getAllByText("Downloading...").length).toBeGreaterThan(0);
    });

    it("shows ready state when logs exist and process is not running", () => {
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={logs("Done")}
                isYtDlpRunning={false}
            />
        );

        expect(screen.getByText("ready")).toBeInTheDocument();
        expect(screen.getAllByText("Done").length).toBeGreaterThan(0);
    });

    it("renders error log line", () => {
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={logs("ERROR: download failed")}
                isYtDlpRunning={false}
            />
        );

        expect(screen.getAllByText("ERROR: download failed").length).toBeGreaterThan(0);
    });

    it("announces only the latest line while keeping the full log present", () => {
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={logs("Downloading...", "[download] 5%")}
                isYtDlpRunning={false}
            />
        );

        // Only the most recent line lives in the polite live region, so appending a line announces
        // just that delta rather than re-announcing the whole (up to 500-line) scrollback.
        const liveRegion = screen.getByRole("log", { name: "yt-dlp latest output" });
        expect(liveRegion).toHaveAttribute("aria-live", "polite");
        expect(liveRegion).toHaveTextContent("[download] 5%");
        expect(liveRegion).not.toHaveTextContent("Downloading...");

        // The earlier line is not announced again, but stays rendered in the browsable scrollback.
        expect(screen.getByText("Downloading...")).toBeInTheDocument();
    });
});