import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { YtDlpProgressBar } from "./yt-dlp-progress-bar";
import { renderWithMantine } from "../../../test/test-utils";

describe("YtDlpProgressBar", () => {
    it("renders nothing before a stage has been reported", () => {
        renderWithMantine(<YtDlpProgressBar progress={null} isRunning />);

        expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });

    it("renders nothing once the run has stopped", () => {
        // A bar left on screen after a finished or cancelled run reports a state that is over, and
        // the last percentage it held is the most misleading thing it could keep showing.
        renderWithMantine(
            <YtDlpProgressBar
                progress={{ phase: "downloading", percent: 62 }}
                isRunning={false}
            />
        );

        expect(screen.queryByText("Downloading")).not.toBeInTheDocument();
        expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });

    it("shows the percentage while downloading", () => {
        renderWithMantine(
            <YtDlpProgressBar progress={{ phase: "downloading", percent: 62.5 }} isRunning />
        );

        expect(screen.getByText("Downloading")).toBeInTheDocument();
        expect(screen.getByText("62.5%")).toBeInTheDocument();
        expect(screen.getByLabelText("Downloading, 63%")).toBeInTheDocument();
    });

    it("names the merge in words a user can act on, and shows no percentage for it", () => {
        // The stage this whole bar exists for. yt-dlp writes one `[Merger]` line and then works
        // silently for minutes on a large file, which reads as a freeze; the terminal below shows
        // that raw line and nothing else.
        renderWithMantine(
            <YtDlpProgressBar progress={{ phase: "merging", percent: null }} isRunning />
        );

        expect(screen.getByText("Combining video and audio")).toBeInTheDocument();
        expect(screen.getByText("working")).toBeInTheDocument();
        expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
    });

    it("does not claim a measurement it does not have", () => {
        // Mantine's Progress always emits aria-valuenow from `value`, so filling the bar to 100 to
        // get the animation would announce a finished stage to a screen reader while FFmpeg is
        // still muxing. The bar is decoration here and is out of the accessibility tree; the text
        // is what carries the state.
        renderWithMantine(
            <YtDlpProgressBar progress={{ phase: "writing-metadata", percent: null }} isRunning />
        );

        expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
        expect(screen.getByText("Writing metadata")).toBeInTheDocument();
        expect(screen.getByText("working")).toBeInTheDocument();
    });

    it("reports the real value to assistive tech while downloading", () => {
        // The other half of the rule above: a percentage is a measurement, so it is announced.
        renderWithMantine(
            <YtDlpProgressBar progress={{ phase: "downloading", percent: 41 }} isRunning />
        );

        expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "41");
    });

    it("labels every post-processing stage", () => {
        for (const [phase, label] of [
            ["extracting-audio", "Extracting audio"],
            ["embedding-thumbnail", "Adding the thumbnail"],
            ["converting-thumbnail", "Converting the thumbnail"],
        ] as const) {
            const { unmount } = renderWithMantine(
                <YtDlpProgressBar progress={{ phase, percent: null }} isRunning />
            );

            expect(screen.getByText(label)).toBeInTheDocument();
            unmount();
        }
    });
});
