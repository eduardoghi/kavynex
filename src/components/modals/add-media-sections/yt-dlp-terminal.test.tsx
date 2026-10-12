import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { YtDlpTerminal } from "./yt-dlp-terminal";
import type { YtDlpLogLevel, YtDlpLogLine } from "../../../hooks/use-yt-dlp-events";
import { renderWithMantine } from "../../../test/test-utils";

// The virtualized scrollback only mounts rows near the viewport, and jsdom has no layout (every
// rect is 0x0), so the real virtualizer would render no lines at all here. Mock it to yield every
// row (the same approach the media grid, comments panel and live chat replay tests take), so these
// can still assert on a specific line's content.
vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: vi.fn(({ count }: { count: number }) => ({
        getTotalSize: () => count * 21,
        getVirtualItems: () =>
            Array.from({ length: count }, (_, index) => ({
                index,
                key: index,
                start: index * 21,
            })),
        measureElement: vi.fn(),
        measure: vi.fn(),
    })),
}));

// The terminal keys rows on a stable per-line id (see YtDlpLogLine); the ids are arbitrary here, so
// number them positionally. The level defaults to "info" because most of these cases are about
// layout and virtualization rather than colour; the ones that are about colour use `leveledLogs`.
function logs(...texts: string[]): YtDlpLogLine[] {
    return texts.map((text, index) => ({ id: index, text, level: "info" }));
}

// The same, for the cases that assert on how a level is rendered.
function leveledLogs(...entries: [string, YtDlpLogLevel][]): YtDlpLogLine[] {
    return entries.map(([text, level], index) => ({ id: index, text, level }));
}

describe("YtDlpTerminal", () => {
    it("returns null when not visible", () => {
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible={false}
                ytDlpLogs={[]}
                isYtDlpRunning={false}
                ytDlpProgress={null}
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
                ytDlpProgress={null}
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
                ytDlpProgress={null}
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
                ytDlpProgress={null}
            />
        );

        expect(screen.getByText("ready")).toBeInTheDocument();
        expect(screen.getAllByText("Done").length).toBeGreaterThan(0);
    });

    it("shows failed rather than ready after a run that failed", () => {
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={logs("ERROR: boom")}
                isYtDlpRunning={false}
                ytDlpProgress={null}
                ytDlpOutcome="failed"
            />
        );

        expect(screen.getByText("failed")).toBeInTheDocument();
        expect(screen.queryByText("ready")).not.toBeInTheDocument();
    });

    it("shows stopped after a cancelled run", () => {
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={logs("Cancelled: by user")}
                isYtDlpRunning={false}
                ytDlpProgress={null}
                ytDlpOutcome="cancelled"
            />
        );

        expect(screen.getByText("stopped")).toBeInTheDocument();
    });

    it("shows running over a previous outcome while an import is still going", () => {
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={logs("Download finished: video.mp4")}
                isYtDlpRunning={false}
                isImporting
                ytDlpProgress={null}
                ytDlpOutcome="finished"
            />
        );

        expect(screen.getByText("running")).toBeInTheDocument();
    });

    it("renders error log line", () => {
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={logs("ERROR: download failed")}
                isYtDlpRunning={false}
                ytDlpProgress={null}
            />
        );

        expect(screen.getAllByText("ERROR: download failed").length).toBeGreaterThan(0);
    });

    it("colours a line by its level rather than by what its text starts with", () => {
        // The three levels must be visually distinct, and a warning in particular has to be. yt-dlp
        // warnings are no longer suppressed on a download, and they are the lines that explain an
        // outcome the user did not ask for. Rendering them like ordinary progress output would put
        // them back out of reach in a terminal that scrolls fast.
        //
        // Asserted as "these three differ" rather than against the exact CSS variable Mantine emits,
        // so a palette change is not a failing test while a level collapsing into another one is.
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={leveledLogs(
                    ["plain progress", "info"],
                    ["WARNING: requested format is not available", "warn"],
                    ["ERROR: download failed", "error"]
                )}
                isYtDlpRunning={false}
                ytDlpProgress={null}
            />
        );

        const styleOf = (text: string): string =>
            screen.getAllByText(text)[0]?.getAttribute("style") ?? "";

        const info = styleOf("plain progress");
        const warn = styleOf("WARNING: requested format is not available");
        const error = styleOf("ERROR: download failed");

        expect(warn).not.toBe(info);
        expect(error).not.toBe(info);
        expect(error).not.toBe(warn);
    });

    it("announces only the latest line while keeping the full log present", () => {
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={logs("Resolving metadata", "Starting download")}
                isYtDlpRunning={false}
                ytDlpProgress={null}
            />
        );

        // Only the most recent line lives in the polite live region, so appending a line announces
        // just that delta rather than re-announcing the whole (up to 500-line) scrollback.
        const liveRegion = screen.getByRole("log", { name: "yt-dlp latest output" });
        expect(liveRegion).toHaveAttribute("aria-live", "polite");
        expect(liveRegion).toHaveTextContent("Starting download");
        expect(liveRegion).not.toHaveTextContent("Resolving metadata");

        // The earlier line is not announced again, but stays rendered in the browsable scrollback.
        expect(screen.getByText("Resolving metadata")).toBeInTheDocument();
    });

    it("does not read out the percentage lines a download prints several times a second", () => {
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={logs(
                    "Starting download",
                    "[download]  12.0% of 50.00MiB at 2.00MiB/s ETA 00:21",
                    "[download]  12.5% of 50.00MiB at 2.00MiB/s ETA 00:20"
                )}
                isYtDlpRunning
                ytDlpProgress={null}
            />
        );

        // The live region holds the last line that is not a percentage, so a screen reader hears
        // the stage once instead of every tick. The progress bar carries the number.
        const liveRegion = screen.getByRole("log", { name: "yt-dlp latest output" });
        expect(liveRegion).toHaveTextContent("Starting download");
        expect(liveRegion).not.toHaveTextContent("12.5%");
    });

    it("lets the scrollback be reached and scrolled from the keyboard", () => {
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={logs("Starting download")}
                isYtDlpRunning={false}
                ytDlpProgress={null}
            />
        );

        const scrollback = screen.getByRole("region", { name: "yt-dlp output" });
        expect(scrollback).toHaveAttribute("tabindex", "0");
        // Not a live region. The virtualizer mounts rows as the view scrolls, and a live region
        // would announce each of those as if it were new output.
        expect(scrollback).not.toHaveAttribute("aria-live");
    });

    // jsdom has no layout, so the viewport's geometry is set by hand. 1000px of content in a 200px
    // box, with the scroll position the test chooses.
    function giveScrollGeometry(element: HTMLElement, scrollTop: number): { top: () => number } {
        let top = scrollTop;

        Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1000 });
        Object.defineProperty(element, "clientHeight", { configurable: true, value: 200 });
        Object.defineProperty(element, "scrollTop", {
            configurable: true,
            get: () => top,
            set: (value: number) => {
                top = value;
            },
        });

        fireEvent.scroll(element);

        return { top: () => top };
    }

    async function nextFrame(): Promise<void> {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    }

    it("leaves the scrollback where the user scrolled it while lines keep arriving", async () => {
        const { rerender } = renderWithMantine(
            <YtDlpTerminal opened visible ytDlpLogs={logs("one")} isYtDlpRunning ytDlpProgress={null} />
        );

        const scrollback = screen.getByRole("region", { name: "yt-dlp output" });
        const geometry = giveScrollGeometry(scrollback, 100);

        rerender(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={logs("one", "two")}
                isYtDlpRunning
                ytDlpProgress={null}
            />
        );
        await nextFrame();

        expect(geometry.top()).toBe(100);
    });

    it("follows new lines while the user is at the bottom", async () => {
        const { rerender } = renderWithMantine(
            <YtDlpTerminal opened visible ytDlpLogs={logs("one")} isYtDlpRunning ytDlpProgress={null} />
        );

        const scrollback = screen.getByRole("region", { name: "yt-dlp output" });
        const geometry = giveScrollGeometry(scrollback, 800);

        rerender(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={logs("one", "two")}
                isYtDlpRunning
                ytDlpProgress={null}
            />
        );
        await nextFrame();

        expect(geometry.top()).toBe(1000);
    });

    it("stays running while the import continues past yt-dlp", () => {
        // yt-dlp exits well before the import does. Registering the media, fetching comments
        // and fetching live chat all run after it, and the panel used to go green on ready
        // while the log under it was still printing those steps.
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={logs("Fetching YouTube comments...")}
                isYtDlpRunning={false}
                isImporting
                ytDlpProgress={null}
            />
        );

        expect(screen.getByText("running")).toBeInTheDocument();
        expect(screen.queryByText("ready")).not.toBeInTheDocument();
    });

    it("reports ready once nothing is running any more", () => {
        renderWithMantine(
            <YtDlpTerminal
                opened
                visible
                ytDlpLogs={logs("Media registered successfully.")}
                isYtDlpRunning={false}
                isImporting={false}
                ytDlpProgress={null}
            />
        );

        expect(screen.getByText("ready")).toBeInTheDocument();
    });
});