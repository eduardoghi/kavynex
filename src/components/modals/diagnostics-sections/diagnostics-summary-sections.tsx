import type { ReactNode } from "react";
import {
    Box,
    Divider,
    Grid,
    Group,
    SimpleGrid,
    Stack,
    Text,
    Title,
    VisuallyHidden,
    rem,
} from "@mantine/core";
import {
    AlertTriangle,
    CheckCircle2,
    Cpu,
    Database,
    FileCheck,
    HardDrive,
    MessageCircle,
    MessagesSquare,
    Wrench,
} from "lucide-react";
import type {
    DiagnosticsOverviewStatus,
    DiagnosticsSummary,
    ExternalToolStatus,
} from "../../../types/diagnostics";
import { formatCount } from "../../../utils/pluralize";
import { DiagnosticsContentVerification } from "./diagnostics-content-verification";
import { DiagnosticsDatabaseIntegrityCheck } from "./diagnostics-database-integrity-check";
import { StatusBadge } from "./diagnostics-summary-primitives";

type DiagnosticsSummarySectionsProps = {
    summary: DiagnosticsSummary;
};

// The status colours the overview icon used to carry inside a tinted circle. The circle went, the
// colour did not, since it is the only thing distinguishing the three states at a glance.
const OVERVIEW_ICON_COLOR: Record<DiagnosticsOverviewStatus, string> = {
    healthy: "light-dark(#15803D, rgb(134,239,172))",
    warning: "light-dark(#A16207, rgb(253,224,71))",
    error: "light-dark(#B91C1C, rgb(252,165,165))",
};

// Left rule on an external tool, standing in for the tinted card the tool used to sit in.
const TOOL_ACCENT_COLOR = {
    healthy: "light-dark(rgba(34,197,94,0.55), rgba(34,197,94,0.45))",
    unhealthy: "light-dark(rgba(239,68,68,0.60), rgba(239,68,68,0.50))",
};

function OverviewStatusIcon({ status }: { status: DiagnosticsOverviewStatus }): JSX.Element {
    return (
        <Box
            component="span"
            style={{
                color: OVERVIEW_ICON_COLOR[status],
                display: "flex",
                flexShrink: 0,
            }}
        >
            {status === "healthy" ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
        </Box>
    );
}

type SectionHeadingProps = {
    icon?: ReactNode;
    title: string;
};

// A heading is a glyph and a word. It used to be a word behind a 34px violet gradient tile with a
// shadow, repeated five times down a dialog meant to be read rather than admired.
function SectionHeading({ icon, title }: SectionHeadingProps): JSX.Element {
    return (
        <Group gap={8} wrap="nowrap" align="center">
            {icon && (
                <Box component="span" c="dimmed" style={{ display: "flex", flexShrink: 0 }}>
                    {icon}
                </Box>
            )}

            <Title order={4}>{title}</Title>
        </Group>
    );
}

type DiagnosticsMetricProps = {
    label: string;
    value: string | number;
};

// Label directly above its value, no box. Reading down a column of these is faster than reading
// across a row with the label at one edge and the number at the other, and it drops the card the
// value used to sit in without spreading the pair apart to compensate.
function DiagnosticsMetric({ label, value }: DiagnosticsMetricProps): JSX.Element {
    return (
        <Box style={{ minWidth: 0 }}>
            <Text size="xs" c="dimmed" lineClamp={1}>
                {label}
            </Text>

            <Text fw={800} lh={1.3} lineClamp={1}>
                {value}
            </Text>
        </Box>
    );
}

// The metrics grid. Column spacing is what separates one metric from the next, since neither has a
// border any more.
function DiagnosticsMetricGrid({ children }: { children: ReactNode }): JSX.Element {
    return (
        <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }} spacing="lg" verticalSpacing="sm">
            {children}
        </SimpleGrid>
    );
}

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
        <Box>
            <Text fw={700} size="sm" mb={4}>
                {label}
            </Text>

            <Stack gap={2}>
                {items.map((item) => (
                    <Text key={item} size="sm" c="dimmed">
                        {item}
                    </Text>
                ))}
            </Stack>
        </Box>
    );
}

type ToolStatusProps = {
    name: string;
    tool: ExternalToolStatus;
};

// Name, version and path against a coloured left rule. A working tool is the ordinary case, so it
// gets a mark rather than a filled card and a badge saying so. Only the state carrying a word
// worth reading keeps a badge.
function ToolStatus({ name, tool }: ToolStatusProps): JSX.Element {
    return (
        <Box
            style={{
                borderLeft: `2px solid ${
                    tool.healthy ? TOOL_ACCENT_COLOR.healthy : TOOL_ACCENT_COLOR.unhealthy
                }`,
                paddingLeft: rem(10),
            }}
        >
            <Group gap={8} wrap="wrap" align="baseline">
                <Text fw={700}>{name}</Text>

                <Text size="sm" c="dimmed">
                    {tool.version || "Version unavailable"}
                </Text>

                {!tool.healthy && <StatusBadge color="red" label="Unavailable" />}
            </Group>

            <Text size="xs" c="dimmed" lineClamp={1}>
                {tool.path || "Path unavailable"}
            </Text>

            {/* Healthy is a colour on screen, which a screen reader cannot read at all and a
                red-green colour blind viewer gets a weaker version of. The word stays for them,
                off the layout. */}
            {tool.healthy && <VisuallyHidden>Available</VisuallyHidden>}
        </Box>
    );
}

export function DiagnosticsSummarySections({
    summary,
}: DiagnosticsSummarySectionsProps): JSX.Element {
    const diagnostics = summary.diagnostics;
    const overview = summary.overview;

    // One line instead of four label and value pairs. These four always read together, and as
    // separate rows they were spending most of the Library column on labels.
    const librarySummaryLine = [
        diagnostics.librarySummary.formatted_size,
        formatCount(diagnostics.librarySummary.video_files, "video"),
        formatCount(diagnostics.librarySummary.audio_files, "audio"),
        formatCount(diagnostics.librarySummary.thumbnail_files, "thumbnail"),
    ].join(" · ");

    return (
        <>
            {/* The overview was a card wrapping an icon tile, a headline, a sentence and a badge.
                The badge said what the headline says, so the headline kept the job. */}
            <Box>
                <Group gap={8} wrap="nowrap" align="center">
                    <OverviewStatusIcon status={overview.status} />

                    <Text fw={800}>{overview.headline}</Text>
                </Group>

                <Text size="sm" c="dimmed">
                    {overview.description}
                </Text>
            </Box>

            {/* issueCount is the total, so a clean run drops the whole row rather than leaving an
                empty Group holding the Stack's gap open. */}
            {overview.issueCount > 0 && (
                <Group gap="xs" wrap="wrap">
                    <StatusBadge color="gray" label={`${overview.issueCount} issues`} />

                    {overview.errorCount > 0 && (
                        <StatusBadge color="red" label={`${overview.errorCount} errors`} />
                    )}
                    {overview.warningCount > 0 && (
                        <StatusBadge color="yellow" label={`${overview.warningCount} warnings`} />
                    )}
                    {overview.infoCount > 0 && (
                        <StatusBadge color="blue" label={`${overview.infoCount} info`} />
                    )}
                </Group>
            )}

            <Divider />

            <Stack gap="xs">
                <SectionHeading icon={<Wrench size={16} />} title="Application" />

                <Group gap={48} wrap="wrap">
                    <DiagnosticsMetric
                        label="Version"
                        value={diagnostics.appVersion ?? "Unknown"}
                    />
                    <DiagnosticsMetric
                        label="Runtime"
                        value={`${diagnostics.platform} · ${diagnostics.arch}`}
                    />
                    <DiagnosticsMetric
                        label="Import mode"
                        value={diagnostics.importMode === "copy" ? "Copy" : "Move"}
                    />
                </Group>
            </Stack>

            <Divider />

            {/* Two columns rather than three, and uneven, because the tools carry two paths and the
                library carries one plus a summary line. */}
            <Grid gap="xl" align="start">
                <Grid.Col span={{ base: 12, md: 7 }}>
                    <Stack gap="sm">
                        <SectionHeading icon={<Cpu size={16} />} title="External tools" />

                        <ToolStatus name="yt-dlp" tool={diagnostics.externalTools.yt_dlp} />
                        <ToolStatus name="ffmpeg" tool={diagnostics.externalTools.ffmpeg} />
                    </Stack>
                </Grid.Col>

                <Grid.Col span={{ base: 12, md: 5 }}>
                    <Stack gap="xs">
                        <SectionHeading icon={<HardDrive size={16} />} title="Library" />

                        <Box>
                            <Text size="xs" c="dimmed">
                                Path
                            </Text>
                            <Text fw={700} lineClamp={2}>
                                {diagnostics.libraryPath || "No library folder configured"}
                            </Text>
                        </Box>

                        <Text size="sm">{librarySummaryLine}</Text>
                    </Stack>
                </Grid.Col>
            </Grid>

            <Divider />

            <Stack gap="sm">
                <SectionHeading icon={<Database size={16} />} title="Database" />

                <DiagnosticsMetricGrid>
                    <DiagnosticsMetric
                        label="Total media rows"
                        value={diagnostics.mediaRepositoryStats.total_media}
                    />
                    <DiagnosticsMetric
                        label="Video rows"
                        value={diagnostics.mediaRepositoryStats.total_video_media}
                    />
                    <DiagnosticsMetric
                        label="Audio rows"
                        value={diagnostics.mediaRepositoryStats.total_audio_media}
                    />
                    <DiagnosticsMetric
                        label="With thumbnail"
                        value={diagnostics.mediaRepositoryStats.total_with_thumbnail}
                    />
                    <DiagnosticsMetric
                        label="Without thumbnail"
                        value={diagnostics.mediaRepositoryStats.total_without_thumbnail}
                    />
                    <DiagnosticsMetric
                        label="Watched"
                        value={diagnostics.mediaRepositoryStats.total_watched}
                    />
                    <DiagnosticsMetric
                        label="Unwatched"
                        value={diagnostics.mediaRepositoryStats.total_unwatched}
                    />
                </DiagnosticsMetricGrid>

                <DiagnosticsDatabaseIntegrityCheck />
            </Stack>

            <Divider />

            <Stack gap="sm">
                <SectionHeading icon={<MessageCircle size={16} />} title="Live chat" />

                <DiagnosticsMetricGrid>
                    <DiagnosticsMetric
                        label="Stored files"
                        value={diagnostics.liveChatStorage.live_chat_files}
                    />
                    <DiagnosticsMetric
                        label="Live media"
                        value={diagnostics.mediaRepositoryStats.total_live_media}
                    />
                    <DiagnosticsMetric
                        label="With live chat"
                        value={diagnostics.mediaRepositoryStats.total_with_live_chat}
                    />
                    <DiagnosticsMetric
                        label="Without live chat"
                        value={diagnostics.mediaRepositoryStats.total_without_live_chat}
                    />
                    <DiagnosticsMetric
                        label="Flagged without path"
                        value={
                            diagnostics.mediaRepositoryStats
                                .total_media_with_live_chat_flag_but_no_path
                        }
                    />
                    <DiagnosticsMetric
                        label="Path on non-live media"
                        value={
                            diagnostics.mediaRepositoryStats
                                .total_media_with_live_chat_path_but_not_live
                        }
                    />
                </DiagnosticsMetricGrid>
            </Stack>

            <Divider />

            <Stack gap="sm">
                <SectionHeading
                    icon={<FileCheck size={16} />}
                    title="Physical integrity"
                />

                <DiagnosticsMetricGrid>
                    <DiagnosticsMetric
                        label="Checked media files"
                        value={diagnostics.libraryIntegrity.checked_media_files}
                    />
                    <DiagnosticsMetric
                        label="Missing media files"
                        value={diagnostics.libraryIntegrity.missing_media_files}
                    />
                    <DiagnosticsMetric
                        label="Checked thumbnails"
                        value={diagnostics.libraryIntegrity.checked_thumbnail_files}
                    />
                    <DiagnosticsMetric
                        label="Missing thumbnails"
                        value={diagnostics.libraryIntegrity.missing_thumbnail_files}
                    />
                    <DiagnosticsMetric
                        label="Orphan media files"
                        value={diagnostics.libraryIntegrity.orphan_media_files}
                    />
                    <DiagnosticsMetric
                        label="Orphan thumbnails"
                        value={diagnostics.libraryIntegrity.orphan_thumbnail_files}
                    />
                    <DiagnosticsMetric
                        label="Invalid media paths"
                        value={diagnostics.libraryIntegrity.invalid_media_files}
                    />
                    <DiagnosticsMetric
                        label="Invalid thumbnail paths"
                        value={diagnostics.libraryIntegrity.invalid_thumbnail_files}
                    />
                    <DiagnosticsMetric
                        label="Corrupt media files"
                        value={diagnostics.libraryIntegrity.corrupt_media_files}
                    />
                    <DiagnosticsMetric
                        label="Corrupt thumbnails"
                        value={diagnostics.libraryIntegrity.corrupt_thumbnail_files}
                    />
                </DiagnosticsMetricGrid>

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

                <DiagnosticsExamplesList
                    label="Corrupt file examples"
                    items={[
                        ...diagnostics.libraryIntegrity.corrupt_media_examples,
                        ...diagnostics.libraryIntegrity.corrupt_thumbnail_examples,
                    ]}
                />

                {/* The deep version of this same section. Everything above it is derived from
                    `stat`, which is why it is here on open. The only damage a `stat` reveals is a
                    zero-length file. */}
                <DiagnosticsContentVerification libraryPath={diagnostics.libraryPath} />
            </Stack>

            <Divider />

            <Stack gap="sm">
                <SectionHeading icon={<MessagesSquare size={16} />} title="Live chat integrity" />

                <DiagnosticsMetricGrid>
                    <DiagnosticsMetric
                        label="Checked live chat files"
                        value={diagnostics.liveChatIntegrity.checked_live_chat_files}
                    />
                    <DiagnosticsMetric
                        label="Missing live chat files"
                        value={diagnostics.liveChatIntegrity.missing_live_chat_files}
                    />
                    <DiagnosticsMetric
                        label="Corrupt live chat files"
                        value={diagnostics.liveChatIntegrity.corrupt_live_chat_files}
                    />
                    <DiagnosticsMetric
                        label="Orphan live chat files"
                        value={diagnostics.liveChatIntegrity.orphan_live_chat_files}
                    />
                </DiagnosticsMetricGrid>

                <DiagnosticsExamplesList
                    label="Missing live chat examples"
                    items={diagnostics.liveChatIntegrity.missing_live_chat_examples}
                />

                <DiagnosticsExamplesList
                    label="Corrupt live chat examples"
                    items={diagnostics.liveChatIntegrity.corrupt_live_chat_examples}
                />

                <DiagnosticsExamplesList
                    label="Orphan live chat examples"
                    items={diagnostics.liveChatIntegrity.orphan_live_chat_examples}
                />
            </Stack>
        </>
    );
}
