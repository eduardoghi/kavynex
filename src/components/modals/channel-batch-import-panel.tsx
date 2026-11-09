import { Badge, Group, ScrollArea, Stack, Text } from "@mantine/core";
import type { BatchImportController, BatchItemStatus } from "../../hooks/use-batch-import";
import { useYtDlpTerminal, type YtDlpTerminalStore } from "../../hooks/yt-dlp-terminal-store";
import { formatNumber } from "../../utils/number-format";
import { AppButton } from "../ui/app-button";
import { YtDlpTerminal } from "./add-media-sections/yt-dlp-terminal";

const STATUS_BADGE: Record<BatchItemStatus, { label: string; color: string }> = {
    waiting: { label: "Waiting", color: "gray" },
    downloading: { label: "Downloading", color: "yellow" },
    done: { label: "Added", color: "green" },
    failed: { label: "Failed", color: "red" },
    stopped: { label: "Stopped", color: "gray" },
};

type ChannelBatchImportPanelProps = {
    batchImport: BatchImportController;
    terminal: YtDlpTerminalStore;
    isYtDlpRunning: boolean;
};

// The download in progress, read from the add-media terminal. Its own component, so a log line
// renders this and nothing around it.
function BatchTerminal({
    terminal,
    isYtDlpRunning,
}: {
    terminal: YtDlpTerminalStore;
    isYtDlpRunning: boolean;
}): JSX.Element | null {
    const { logs, progress, outcome } = useYtDlpTerminal(terminal);

    return (
        <YtDlpTerminal
            opened
            visible
            ytDlpLogs={logs}
            isYtDlpRunning={isYtDlpRunning}
            isImporting
            ytDlpProgress={progress}
            ytDlpOutcome={outcome}
        />
    );
}

export function ChannelBatchImportPanel({
    batchImport,
    terminal,
    isYtDlpRunning,
}: ChannelBatchImportPanelProps): JSX.Element {
    const { items, isRunning, isStopping, stop, retryFailed, clear } = batchImport;
    const count = (status: BatchItemStatus): number =>
        items.filter((item) => item.status === status).length;
    const settled = items.length - count("waiting") - count("downloading");
    const failed = items.filter((item) => item.status === "failed");

    return (
        <Stack gap="sm">
            <Group justify="space-between" align="center">
                <Text size="sm" fw={600} role="status" className="kx-tabular-nums">
                    {isRunning
                        ? `Importing ${formatNumber(Math.min(settled + 1, items.length))} of ${formatNumber(items.length)}`
                        : `${formatNumber(count("done"))} added, ${formatNumber(failed.length)} failed, ${formatNumber(count("stopped"))} stopped`}
                </Text>

                {isRunning ? (
                    <AppButton
                        appVariant="danger"
                        size="xs"
                        onClick={stop}
                        disabled={isStopping}
                    >
                        {isStopping ? "Stopping..." : "Stop"}
                    </AppButton>
                ) : (
                    <Group gap="xs">
                        {failed.length > 0 && (
                            <AppButton size="xs" onClick={() => void retryFailed()}>
                                Retry failed
                            </AppButton>
                        )}
                        <AppButton appVariant="ghost" size="xs" onClick={clear}>
                            Back to the list
                        </AppButton>
                    </Group>
                )}
            </Group>

            <ScrollArea.Autosize mah="30vh" offsetScrollbars>
                <Stack gap={6} component="ul" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    {items.map((item) => {
                        const badge = STATUS_BADGE[item.status];

                        return (
                            <Group
                                key={item.youtubeVideoId}
                                component="li"
                                justify="space-between"
                                wrap="nowrap"
                                gap="sm"
                            >
                                <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                                    <Text size="sm" lineClamp={1}>
                                        {item.title}
                                    </Text>
                                    {item.message && (
                                        <Text size="xs" c="dimmed" lineClamp={2}>
                                            {item.message}
                                        </Text>
                                    )}
                                </Stack>
                                <Badge variant="light" color={badge.color}>
                                    {badge.label}
                                </Badge>
                            </Group>
                        );
                    })}
                </Stack>
            </ScrollArea.Autosize>

            {isRunning && <BatchTerminal terminal={terminal} isYtDlpRunning={isYtDlpRunning} />}
        </Stack>
    );
}
