import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { YtDlpTerminal } from "./yt-dlp-terminal";
import { renderWithMantine } from "../../../test/test-utils";

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
                ytDlpLogs={["Downloading..."]}
                isYtDlpRunning
            />
        );

        expect(screen.getByText("running")).toBeInTheDocument();
        expect(screen.getByText("Downloading...")).toBeInTheDocument();
    });

    it("shows ready state when logs exist and process is not running", () => {
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={["Done"]}
                isYtDlpRunning={false}
            />
        );

        expect(screen.getByText("ready")).toBeInTheDocument();
        expect(screen.getByText("Done")).toBeInTheDocument();
    });

    it("renders error log line", () => {
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={["ERROR: download failed"]}
                isYtDlpRunning={false}
            />
        );

        expect(screen.getByText("ERROR: download failed")).toBeInTheDocument();
    });

    it("exposes the log region for screen readers", () => {
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={["Downloading..."]}
                isYtDlpRunning={false}
            />
        );

        const logRegion = screen.getByRole("log", { name: "yt-dlp output" });

        expect(logRegion).toHaveAttribute("aria-live", "polite");
        expect(logRegion).toContainElement(screen.getByText("Downloading..."));
    });
});