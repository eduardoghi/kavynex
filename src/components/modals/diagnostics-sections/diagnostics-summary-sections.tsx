import { Box, Group, Paper, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { Cpu, HardDrive, MessagesSquare, Wrench } from "lucide-react";
import type { DiagnosticsSummary } from "../../../types/diagnostics";
import { DiagnosticsDatabaseIntegrityCheck } from "./diagnostics-database-integrity-check";
import { DiagnosticsMetricCard } from "./diagnostics-metric-card";
import {
    OverviewBadge,
    OverviewIcon,
    SectionIcon,
    StatusBadge,
} from "./diagnostics-summary-primitives";

type DiagnosticsSummarySectionsProps = {
    summary: DiagnosticsSummary;
};

type DiagnosticsExamplesListProps = {
    label: string;
    items: string[];
};

function DiagnosticsExamplesList({
    label,
    items,
}: DiagnosticsExamplesListProps): JSX.Element | null {
    if (items.length === 0) {
        return null;
    }

    return (
        <Paper withBorder radius="md" p="sm">
            <Text fw={700} size="sm" mb={6}>
                {label}
            </Text>

            <Stack gap={4}>
                {items.map((item) => (
                    <Text key={item} size="sm" c="dimmed">
                        {item}
                    </Text>
                ))}
            </Stack>
        </Paper>
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

                    <DiagnosticsDatabaseIntegrityCheck />
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
                        <DiagnosticsMetricCard
                            label="Invalid media paths"
                            value={diagnostics.libraryIntegrity.invalid_media_files}
                        />
                        <DiagnosticsMetricCard
                            label="Invalid thumbnail paths"
                            value={diagnostics.libraryIntegrity.invalid_thumbnail_files}
                        />
                    </Group>

                    <DiagnosticsExamplesList
                        label="Missing media examples"
                        items={diagnostics.libraryIntegrity.missing_media_examples}
                    />

                    <DiagnosticsExamplesList
                        label="Missing thumbnail examples"
                        items={diagnostics.libraryIntegrity.missing_thumbnail_examples}
                    />

                    <DiagnosticsExamplesList
                        label="Orphan media examples"
                        items={diagnostics.libraryIntegrity.orphan_media_examples}
                    />

                    <DiagnosticsExamplesList
                        label="Orphan thumbnail examples"
                        items={diagnostics.libraryIntegrity.orphan_thumbnail_examples}
                    />

                    <DiagnosticsExamplesList
                        label="Invalid path examples"
                        items={[
                            ...diagnostics.libraryIntegrity.invalid_media_examples,
                            ...diagnostics.libraryIntegrity.invalid_thumbnail_examples,
                        ]}
                    />
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

                    <DiagnosticsExamplesList
                        label="Missing live chat examples"
                        items={diagnostics.liveChatIntegrity.missing_live_chat_examples}
                    />

                    <DiagnosticsExamplesList
                        label="Orphan live chat examples"
                        items={diagnostics.liveChatIntegrity.orphan_live_chat_examples}
                    />
                </Stack>
            </Paper>
        </>
    );
}