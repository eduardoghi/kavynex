import { Box, Grid, Group, Stack, Text, VisuallyHidden, rem } from "@mantine/core";
import { Cpu, HardDrive } from "lucide-react";
import type {
    ExternalToolStatus,
    ExternalToolsStatus,
    LibrarySummaryInfo,
} from "../../../types/diagnostics";
import { formatCount } from "../../../utils/pluralize";
import { SectionHeading, StatusBadge } from "./diagnostics-summary-primitives";

// Left rule on an external tool, standing in for the tinted card the tool used to sit in.
const TOOL_ACCENT_COLOR = {
    healthy: "light-dark(rgba(34,197,94,0.55), rgba(34,197,94,0.45))",
    unhealthy: "light-dark(rgba(239,68,68,0.60), rgba(239,68,68,0.50))",
};

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

type DiagnosticsToolsAndLibrarySectionProps = {
    externalTools: ExternalToolsStatus;
    libraryPath: string;
    librarySummary: LibrarySummaryInfo;
};

// The two external tools and the library folder share one row: two columns rather than three,
// and uneven, because the tools carry two paths and the library carries one plus a summary line.
export function DiagnosticsToolsAndLibrarySection({
    externalTools,
    libraryPath,
    librarySummary,
}: DiagnosticsToolsAndLibrarySectionProps): JSX.Element {
    // One line instead of four label and value pairs. These four always read together, and as
    // separate rows they were spending most of the Library column on labels.
    const librarySummaryLine = [
        librarySummary.formatted_size,
        formatCount(librarySummary.video_files, "video"),
        formatCount(librarySummary.audio_files, "audio"),
        formatCount(librarySummary.thumbnail_files, "thumbnail"),
    ].join(" · ");

    return (
        <Grid gap="xl" align="start">
            <Grid.Col span={{ base: 12, md: 7 }}>
                <Stack gap="sm">
                    <SectionHeading icon={<Cpu size={16} />} title="External tools" />

                    <ToolStatus name="yt-dlp" tool={externalTools.yt_dlp} />
                    <ToolStatus name="ffmpeg" tool={externalTools.ffmpeg} />
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
                            {libraryPath || "No library folder configured"}
                        </Text>
                    </Box>

                    <Text size="sm">{librarySummaryLine}</Text>
                </Stack>
            </Grid.Col>
        </Grid>
    );
}
