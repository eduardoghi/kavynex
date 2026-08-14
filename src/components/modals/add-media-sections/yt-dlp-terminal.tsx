import { Badge, Box, Group, Text, VisuallyHidden, rem } from "@mantine/core";
import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { YtDlpLogLine } from "../../../hooks/use-yt-dlp-events";

type YtDlpTerminalProps = {
    opened: boolean;
    visible: boolean;
    ytDlpLogs: YtDlpLogLine[];
    isYtDlpRunning: boolean;
};

// Height of the scrollback viewport. Previously a Mantine ScrollArea `h`; the virtualizer needs a
// plain scrolling element it owns, so this is applied to that element directly.
//
// Scales with the viewport rather than sitting at a fixed 320px: the modal around it is now sized
// off the viewport too, and this is the element that actually wants the extra room. It is what the
// user watches for the minutes a download runs. `clamp` keeps it a definite computed height, which
// is what the virtualizer measures the scroll element for, so virtualization is unaffected. The
// lower bound keeps it usable on a short window; the upper one stops it from crowding out the form
// controls above it on a tall one.
const TERMINAL_HEIGHT = "clamp(220px, 32vh, 460px)";

// First guess at a log row's height (one line of the 13px/1.6 monospace text below). Real heights
// are measured after mount via measureElement, so this only shapes the first paint's scrollbar
// estimate. A wrapped long line is measured at its true height, not this one.
const ESTIMATED_LINE_HEIGHT = 21;

export function YtDlpTerminal({
    opened,
    visible,
    ytDlpLogs,
    isYtDlpRunning,
}: YtDlpTerminalProps): JSX.Element | null {
    const terminalViewportRef = useRef<HTMLDivElement | null>(null);

    // Only the rows near the viewport are in the DOM. The log is a hot path (a line arrives every
    // few milliseconds during a download, with the modal open and the user watching), and the
    // buffer holds up to 500 of them, so rendering the whole scrollback meant re-rendering hundreds
    // of nodes on every append. Matches the virtualization the media grid, comments panel and live
    // chat replay already use.
    const virtualizer = useVirtualizer({
        count: ytDlpLogs.length,
        getScrollElement: () => terminalViewportRef.current,
        estimateSize: () => ESTIMATED_LINE_HEIGHT,
        overscan: 12,
        // Key on the line's own stable id rather than the index, so a row keeps its identity as the
        // window slides and React reuses the node instead of remounting it.
        getItemKey: (index) => ytDlpLogs[index]?.id ?? index,
    });

    const virtualRows = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();

    // Follow the tail as lines arrive. Re-applied on totalSize as well as on the log itself: with
    // virtualization the scrollable height grows only once the new row has been measured, so
    // scrolling on the log change alone would stop one row short of the bottom.
    useEffect(() => {
        if (!opened || !visible) {
            return;
        }

        const viewport = terminalViewportRef.current;

        if (!viewport) {
            return;
        }

        const frameId = requestAnimationFrame(() => {
            viewport.scrollTop = viewport.scrollHeight;
        });

        return () => {
            cancelAnimationFrame(frameId);
        };
    }, [opened, visible, ytDlpLogs, totalSize]);

    if (!visible) {
        return null;
    }

    // Screen readers announce changes to a live region, and the scrollback below is not one: it
    // holds up to 500 lines and now renders only the rows near the viewport, so making it live
    // would announce whatever the virtualizer happened to mount rather than the new line. Instead
    // this hidden region carries only the most recent line, so assistive tech announces just that
    // delta while the scrollback stays a normal, browsable region.
    const latestLine = ytDlpLogs[ytDlpLogs.length - 1]?.text ?? "";

    return (
        <Box>
            <VisuallyHidden role="log" aria-live="polite" aria-label="yt-dlp latest output">
                {latestLine}
            </VisuallyHidden>

            <Group justify="space-between" mb="xs">
                <Text fw={800}>Integrated terminal</Text>

                <Badge
                    variant="light"
                    color={
                        isYtDlpRunning ? "yellow" : ytDlpLogs.length > 0 ? "green" : "gray"
                    }
                >
                    {isYtDlpRunning ? "running" : ytDlpLogs.length > 0 ? "ready" : "idle"}
                </Badge>
            </Group>

            <Box
                style={{
                    borderRadius: rem(14),
                    border: "1px solid rgba(255,255,255,0.12)",
                    background: "#05070C",
                    overflow: "hidden",
                }}
            >
                <Box
                    ref={terminalViewportRef}
                    aria-label="yt-dlp output"
                    style={{
                        height: TERMINAL_HEIGHT,
                        overflowY: "auto",
                        overflowX: "hidden",
                        padding: rem(14),
                        fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace",
                        fontSize: rem(13),
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        lineHeight: 1.6,
                    }}
                >
                    {ytDlpLogs.length > 0 ? (
                        <Box
                            style={{
                                height: `${totalSize}px`,
                                width: "100%",
                                position: "relative",
                            }}
                        >
                            {virtualRows.map((virtualRow) => {
                                const line = ytDlpLogs[virtualRow.index];

                                // The virtualizer only yields in-range indices, so this is never
                                // null in practice; the guard satisfies the checked-index type.
                                if (!line) {
                                    return null;
                                }

                                return (
                                    <Text
                                        key={virtualRow.key}
                                        ref={virtualizer.measureElement}
                                        data-index={virtualRow.index}
                                        component="div"
                                        c={line.text.startsWith("ERROR:") ? "red.4" : "gray.3"}
                                        style={{
                                            fontFamily: "inherit",
                                            position: "absolute",
                                            top: 0,
                                            left: 0,
                                            width: "100%",
                                            transform: `translateY(${virtualRow.start}px)`,
                                        }}
                                    >
                                        {line.text || " "}
                                    </Text>
                                );
                            })}
                        </Box>
                    ) : (
                        <Text c="dimmed" style={{ fontFamily: "inherit" }}>
                            The yt-dlp execution log will appear here.
                        </Text>
                    )}
                </Box>
            </Box>
        </Box>
    );
}
