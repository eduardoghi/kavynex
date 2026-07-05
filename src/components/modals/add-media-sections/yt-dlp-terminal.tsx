import { Badge, Box, Group, ScrollArea, Text, rem } from "@mantine/core";
import { useEffect, useRef } from "react";

type YtDlpTerminalProps = {
    opened: boolean;
    visible: boolean;
    ytDlpLogs: string[];
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

    return (
        <Box>
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
                        role="log"
                        aria-live="polite"
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
                            ytDlpLogs.map((line, index) => (
                                <Text
                                    key={`${index}-${line}`}
                                    component="div"
                                    c={line.startsWith("ERROR:") ? "red.4" : "gray.3"}
                                    style={{ fontFamily: "inherit" }}
                                >
                                    {line || " "}
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