import { Badge, Box, Group, ScrollArea, Text, VisuallyHidden, rem } from "@mantine/core";
import { useEffect, useRef } from "react";
import type { YtDlpLogLine } from "../../../hooks/use-yt-dlp-events";

type YtDlpTerminalProps = {
    opened: boolean;
    visible: boolean;
    ytDlpLogs: YtDlpLogLine[];
    isYtDlpRunning: boolean;
};

export function YtDlpTerminal({
    opened,
    visible,
    ytDlpLogs,
    isYtDlpRunning,
}: YtDlpTerminalProps): JSX.Element | null {
    const terminalViewportRef = useRef<HTMLDivElement | null>(null);

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
    }, [opened, visible, ytDlpLogs]);

    if (!visible) {
        return null;
    }

    // Screen readers announce changes to a live region, and the scrollback below is not one: it
    // holds up to 500 lines and its whole subtree is replaced on every append, so making it live
    // would re-announce far more than the new line during an active download. Instead this hidden
    // region carries only the most recent line, so assistive tech announces just that delta while
    // the scrollback stays a normal, browsable region.
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
                <ScrollArea h={320} offsetScrollbars viewportRef={terminalViewportRef}>
                    <Box
                        aria-label="yt-dlp output"
                        style={{
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
                            ytDlpLogs.map((line) => (
                                <Text
                                    key={line.id}
                                    component="div"
                                    c={line.text.startsWith("ERROR:") ? "red.4" : "gray.3"}
                                    style={{ fontFamily: "inherit" }}
                                >
                                    {line.text || " "}
                                </Text>
                            ))
                        ) : (
                            <Text c="dimmed" style={{ fontFamily: "inherit" }}>
                                The yt-dlp execution log will appear here.
                            </Text>
                        )}
                    </Box>
                </ScrollArea>
            </Box>
        </Box>
    );
}