import {
    Box,
    Group,
    Paper,
    SimpleGrid,
    Stack,
    Text,
    ThemeIcon,
    Title,
    Badge,
} from "@mantine/core";
import {
    AlertTriangle,
    CheckCircle2,
    Cpu,
    HardDrive,
    MessagesSquare,
    Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import type {
    DiagnosticsOverviewStatus,
    DiagnosticsSummary,
} from "../../../types/diagnostics";
import { DiagnosticsMetricCard } from "./diagnostics-metric-card";

type DiagnosticsSummarySectionsProps = {
    summary: DiagnosticsSummary;
};

function StatusBadge({
    color,
    label,
}: {
    color: "green" | "yellow" | "red" | "gray" | "blue";
    label: string;
}): JSX.Element {
    return (
        <Badge color={color} variant="light">
            {label}
        </Badge>
    );
}

function OverviewBadge({
    status,
}: {
    status: DiagnosticsOverviewStatus;
}): JSX.Element {
    if (status === "error") {
        return <StatusBadge color="red" label="Needs action" />;
    }

    if (status === "warning") {
        return <StatusBadge color="yellow" label="Attention" />;
    }

    return <StatusBadge color="green" label="Healthy" />;
}

function SectionIcon({
    children,
}: {
    children: ReactNode;
}): JSX.Element {
    return (
        <ThemeIcon
            size="lg"
            radius="xl"
            variant="light"
            style={{
                background:
                    "linear-gradient(135deg, rgba(124,92,255,0.24), rgba(37,99,235,0.10))",
                border: "1px solid rgba(139,92,246,0.30)",
                color: "rgba(237,233,254,0.96)",
                boxShadow: "0 10px 24px rgba(80,50,180,0.12)",
            }}
        >
            {children}
        </ThemeIcon>
    );
}

function OverviewIcon({
    status,
}: {
    status: DiagnosticsOverviewStatus;
}): JSX.Element {
    const isHealthy = status === "healthy";
    const isWarning = status === "warning";

    return (
        <ThemeIcon
            size="lg"
            radius="xl"
            variant="light"
            style={{
                background: isHealthy
                    ? "rgba(34,197,94,0.16)"
                    : isWarning
                      ? "rgba(234,179,8,0.16)"
                      : "rgba(239,68,68,0.16)",
                border: isHealthy
                    ? "1px solid rgba(34,197,94,0.30)"
                    : isWarning
                      ? "1px solid rgba(234,179,8,0.30)"
                      : "1px solid rgba(239,68,68,0.30)",
                color: isHealthy
                    ? "rgb(134,239,172)"
                    : isWarning
                      ? "rgb(253,224,71)"
                      : "rgb(252,165,165)",
            }}
        >
            {isHealthy ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
        </ThemeIcon>
    );
}

export function DiagnosticsSummarySections({
    summary,
}: DiagnosticsSummarySectionsProps): JSX.Element {
    const diagnostics = summary.diagnostics;
    const overview = summary.overview;

    return (
        <>
            <Paper withBorder radius="lg" p="md">
                <Stack gap="sm">
                    <Group justify="space-between" align="center">
                        <Group gap="sm" wrap="nowrap" align="flex-start">
                            <OverviewIcon status={overview.status} />

                            <Box>
                                <Title order={4}>{overview.headline}</Title>
                                <Text size="sm" c="dimmed">
                                    {overview.description}
                                </Text>
                            </Box>
                        </Group>

                        <OverviewBadge status={overview.status} />
                    </Group>

                    <Group gap="xs" wrap="wrap">
                        {overview.issueCount > 0 && (
                            <StatusBadge color="gray" label={`${overview.issueCount} issues`} />
                        )}
                        {overview.errorCount > 0 && (
                            <StatusBadge color="red" label={`${overview.errorCount} errors`} />
                        )}
                        {overview.warningCount > 0 && (
                            <StatusBadge color="yellow" label={`${overview.warningCount} warnings`} />
                        )}
                        {overview.infoCount > 0 && (
                            <StatusBadge color="blue" label={`${overview.infoCount} info`} />
                        )}

                        {overview.issueCount === 0 && (
                            <StatusBadge color="green" label="No issues detected" />
                        )}
                    </Group>
                </Stack>
            </Paper>

            <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
                <Paper withBorder radius="lg" p="md">
                    <Group gap="xs" mb="sm">
                        <SectionIcon>
                            <Wrench size={16} />
                        </SectionIcon>

                        <Title order={4}>Application</Title>
                    </Group>

                    <Stack gap="sm">
                        <DiagnosticsMetricCard
                            label="Version"
                            value={diagnostics.appVersion ?? "Unknown"}
                        />
                        <DiagnosticsMetricCard
                            label="Runtime"
                            value={`${diagnostics.platform} · ${diagnostics.arch}`}
                        />
                        <DiagnosticsMetricCard
                            label="Import mode"
                            value={diagnostics.importMode === "copy" ? "Copy" : "Move"}
                        />
                    </Stack>
                </Paper>

                <Paper withBorder radius="lg" p="md">
                    <Group gap="xs" mb="sm">
                        <SectionIcon>
                            <Cpu size={16} />
                        </SectionIcon>

                        <Title order={4}>External tools</Title>
                    </Group>

                    <Stack gap="sm">
                        <Paper withBorder radius="md" p="sm">
                            <Group justify="space-between" align="flex-start">
                                <Box style={{ minWidth: 0, flex: 1 }}>
                                    <Text fw={700}>yt-dlp</Text>
                                    <Text size="sm" c="dimmed">
                                        {diagnostics.externalTools.yt_dlp.version || "Version unavailable"}
                                    </Text>
                                    <Text size="xs" c="dimmed" mt={4} lineClamp={1}>
                                        {diagnostics.externalTools.yt_dlp.path || "Path unavailable"}
                                    </Text>
                                </Box>

                                <StatusBadge
                                    color={
                                        diagnostics.externalTools.yt_dlp.healthy
                                            ? "green"
                                            : "yellow"
                                    }
                                    label={
                                        diagnostics.externalTools.yt_dlp.healthy
                                            ? "Available"
                                            : "Unavailable"
                                    }
                                />
                            </Group>
                        </Paper>

                        <Paper withBorder radius="md" p="sm">
                            <Group justify="space-between" align="flex-start">
                                <Box style={{ minWidth: 0, flex: 1 }}>
                                    <Text fw={700}>ffmpeg</Text>
                                    <Text size="sm" c="dimmed">
                                        {diagnostics.externalTools.ffmpeg.version || "Version unavailable"}
                                    </Text>
                                    <Text size="xs" c="dimmed" mt={4} lineClamp={1}>
                                        {diagnostics.externalTools.ffmpeg.path || "Path unavailable"}
                                    </Text>
                                </Box>

                                <StatusBadge
                                    color={
                                        diagnostics.externalTools.ffmpeg.healthy
                                            ? "green"
                                            : "yellow"
                                    }
                                    label={
                                        diagnostics.externalTools.ffmpeg.healthy
                                            ? "Available"
                                            : "Unavailable"
                                    }
                                />
                            </Group>
                        </Paper>
                    </Stack>
                </Paper>

                <Paper withBorder radius="lg" p="md">
                    <Group gap="xs" mb="sm">
                        <SectionIcon>
                            <HardDrive size={16} />
                        </SectionIcon>

                        <Title order={4}>Library</Title>
                    </Group>

                    <Stack gap="sm">
                        <Paper withBorder radius="md" p="sm">
                            <Text size="sm" c="dimmed">
                                Path
                            </Text>
                            <Text fw={700} lineClamp={2}>
                                {diagnostics.libraryPath || "No library folder configured"}
                            </Text>
                        </Paper>

                        <DiagnosticsMetricCard
                            label="Total size"
                            value={diagnostics.librarySummary.formatted_size}
                        />
                        <DiagnosticsMetricCard
                            label="Video files"
                            value={diagnostics.librarySummary.video_files}
                        />
                        <DiagnosticsMetricCard
                            label="Audio files"
                            value={diagnostics.librarySummary.audio_files}
                        />
                        <DiagnosticsMetricCard
                            label="Thumbnails"
                            value={diagnostics.librarySummary.thumbnail_files}
                        />
                    </Stack>
                </Paper>
            </SimpleGrid>

            <Paper withBorder radius="lg" p="md">
                <Stack gap="sm">
                    <Title order={4}>Database</Title>

                    <Group grow align="stretch">
                        <DiagnosticsMetricCard
                            label="Total media rows"
                            value={diagnostics.mediaRepositoryStats.total_media}
                        />
                        <DiagnosticsMetricCard
                            label="Video rows"
                            value={diagnostics.mediaRepositoryStats.total_video_media}
                        />
                        <DiagnosticsMetricCard
                            label="Audio rows"
                            value={diagnostics.mediaRepositoryStats.total_audio_media}
                        />
                        <DiagnosticsMetricCard
                            label="With thumbnail"
                            value={diagnostics.mediaRepositoryStats.total_with_thumbnail}
                        />
                        <DiagnosticsMetricCard
                            label="Without thumbnail"
                            value={diagnostics.mediaRepositoryStats.total_without_thumbnail}
                        />
                        <DiagnosticsMetricCard
                            label="Watched"
                            value={diagnostics.mediaRepositoryStats.total_watched}
                        />
                        <DiagnosticsMetricCard
                            label="Unwatched"
                            value={diagnostics.mediaRepositoryStats.total_unwatched}
                        />
                    </Group>
                </Stack>
            </Paper>

            <Paper withBorder radius="lg" p="md">
                <Stack gap="sm">
                    <Title order={4}>Live chat</Title>

                    <Group grow align="stretch">
                        <DiagnosticsMetricCard
                            label="Stored files"
                            value={diagnostics.liveChatStorage.live_chat_files}
                        />
                        <DiagnosticsMetricCard
                            label="Live media"
                            value={diagnostics.mediaRepositoryStats.total_live_media}
                        />
                        <DiagnosticsMetricCard
                            label="With live chat"
                            value={diagnostics.mediaRepositoryStats.total_with_live_chat}
                        />
                        <DiagnosticsMetricCard
                            label="Without live chat"
                            value={diagnostics.mediaRepositoryStats.total_without_live_chat}
                        />
                        <DiagnosticsMetricCard
                            label="Flagged without path"
                            value={
                                diagnostics.mediaRepositoryStats
                                    .total_media_with_live_chat_flag_but_no_path
                            }
                        />
                        <DiagnosticsMetricCard
                            label="Path on non-live media"
                            value={
                                diagnostics.mediaRepositoryStats
                                    .total_media_with_live_chat_path_but_not_live
                            }
                        />
                    </Group>
                </Stack>
            </Paper>

            <Paper withBorder radius="lg" p="md">
                <Stack gap="sm">
                    <Title order={4}>Physical integrity</Title>

                    <Group grow align="stretch">
                        <DiagnosticsMetricCard
                            label="Checked media files"
                            value={diagnostics.libraryIntegrity.checked_media_files}
                        />
                        <DiagnosticsMetricCard
                            label="Missing media files"
                            value={diagnostics.libraryIntegrity.missing_media_files}
                        />
                        <DiagnosticsMetricCard
                            label="Checked thumbnails"
                            value={diagnostics.libraryIntegrity.checked_thumbnail_files}
                        />
                        <DiagnosticsMetricCard
                            label="Missing thumbnails"
                            value={diagnostics.libraryIntegrity.missing_thumbnail_files}
                        />
                    </Group>

                    <Group grow align="stretch">
                        <DiagnosticsMetricCard
                            label="Orphan media files"
                            value={diagnostics.libraryIntegrity.orphan_media_files}
                        />
                        <DiagnosticsMetricCard
                            label="Orphan thumbnails"
                            value={diagnostics.libraryIntegrity.orphan_thumbnail_files}
                        />
                    </Group>

                    {diagnostics.libraryIntegrity.missing_media_examples.length > 0 && (
                        <Paper withBorder radius="md" p="sm">
                            <Text fw={700} size="sm" mb={6}>
                                Missing media examples
                            </Text>

                            <Stack gap={4}>
                                {diagnostics.libraryIntegrity.missing_media_examples.map((item) => (
                                    <Text key={item} size="sm" c="dimmed">
                                        {item}
                                    </Text>
                                ))}
                            </Stack>
                        </Paper>
                    )}

                    {diagnostics.libraryIntegrity.missing_thumbnail_examples.length > 0 && (
                        <Paper withBorder radius="md" p="sm">
                            <Text fw={700} size="sm" mb={6}>
                                Missing thumbnail examples
                            </Text>

                            <Stack gap={4}>
                                {diagnostics.libraryIntegrity.missing_thumbnail_examples.map((item) => (
                                    <Text key={item} size="sm" c="dimmed">
                                        {item}
                                    </Text>
                                ))}
                            </Stack>
                        </Paper>
                    )}

                    {diagnostics.libraryIntegrity.orphan_media_examples.length > 0 && (
                        <Paper withBorder radius="md" p="sm">
                            <Text fw={700} size="sm" mb={6}>
                                Orphan media examples
                            </Text>

                            <Stack gap={4}>
                                {diagnostics.libraryIntegrity.orphan_media_examples.map((item) => (
                                    <Text key={item} size="sm" c="dimmed">
                                        {item}
                                    </Text>
                                ))}
                            </Stack>
                        </Paper>
                    )}

                    {diagnostics.libraryIntegrity.orphan_thumbnail_examples.length > 0 && (
                        <Paper withBorder radius="md" p="sm">
                            <Text fw={700} size="sm" mb={6}>
                                Orphan thumbnail examples
                            </Text>

                            <Stack gap={4}>
                                {diagnostics.libraryIntegrity.orphan_thumbnail_examples.map((item) => (
                                    <Text key={item} size="sm" c="dimmed">
                                        {item}
                                    </Text>
                                ))}
                            </Stack>
                        </Paper>
                    )}
                </Stack>
            </Paper>

            <Paper withBorder radius="lg" p="md">
                <Stack gap="sm">
                    <Group gap="xs" mb={2}>
                        <SectionIcon>
                            <MessagesSquare size={16} />
                        </SectionIcon>

                        <Title order={4}>Live chat integrity</Title>
                    </Group>

                    <Group grow align="stretch">
                        <DiagnosticsMetricCard
                            label="Checked live chat files"
                            value={diagnostics.liveChatIntegrity.checked_live_chat_files}
                        />
                        <DiagnosticsMetricCard
                            label="Missing live chat files"
                            value={diagnostics.liveChatIntegrity.missing_live_chat_files}
                        />
                        <DiagnosticsMetricCard
                            label="Orphan live chat files"
                            value={diagnostics.liveChatIntegrity.orphan_live_chat_files}
                        />
                    </Group>

                    {diagnostics.liveChatIntegrity.missing_live_chat_examples.length > 0 && (
                        <Paper withBorder radius="md" p="sm">
                            <Text fw={700} size="sm" mb={6}>
                                Missing live chat examples
                            </Text>

                            <Stack gap={4}>
                                {diagnostics.liveChatIntegrity.missing_live_chat_examples.map((item) => (
                                    <Text key={item} size="sm" c="dimmed">
                                        {item}
                                    </Text>
                                ))}
                            </Stack>
                        </Paper>
                    )}

                    {diagnostics.liveChatIntegrity.orphan_live_chat_examples.length > 0 && (
                        <Paper withBorder radius="md" p="sm">
                            <Text fw={700} size="sm" mb={6}>
                                Orphan live chat examples
                            </Text>

                            <Stack gap={4}>
                                {diagnostics.liveChatIntegrity.orphan_live_chat_examples.map((item) => (
                                    <Text key={item} size="sm" c="dimmed">
                                        {item}
                                    </Text>
                                ))}
                            </Stack>
                        </Paper>
                    )}
                </Stack>
            </Paper>
        </>
    );
}