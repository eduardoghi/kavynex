import { Anchor, Box, Divider, Group, Paper, Stack, Text, ThemeIcon, Title, Badge } from "@mantine/core";
import { AlertTriangle, Info } from "lucide-react";
import type { DiagnosticsIssue, DiagnosticsMediaTarget } from "../../../types/diagnostics";

type DiagnosticsIssuesSectionProps = {
    issues: DiagnosticsIssue[];
    // When given, example paths that map to an existing media row become clickable and jump to
    // that media in the library (used for "missing media": the file is gone but the row remains).
    onOpenMedia?: (target: DiagnosticsMediaTarget) => void;
};

function IssueSeverityBadge({
    severity,
}: {
    severity: DiagnosticsIssue["severity"];
}): JSX.Element {
    if (severity === "error") {
        return (
            <Badge color="red" variant="light">
                Error
            </Badge>
        );
    }

    if (severity === "warning") {
        return (
            <Badge color="yellow" variant="light">
                Warning
            </Badge>
        );
    }

    return (
        <Badge color="blue" variant="light">
            Info
        </Badge>
    );
}

function IssueSeverityIcon({
    severity,
}: {
    severity: DiagnosticsIssue["severity"];
}): JSX.Element {
    if (severity === "error") {
        return (
            <ThemeIcon color="red" variant="light" radius="xl">
                <AlertTriangle size={16} />
            </ThemeIcon>
        );
    }

    if (severity === "warning") {
        return (
            <ThemeIcon color="yellow" variant="light" radius="xl">
                <AlertTriangle size={16} />
            </ThemeIcon>
        );
    }

    return (
        <ThemeIcon color="blue" variant="light" radius="xl">
            <Info size={16} />
        </ThemeIcon>
    );
}

export function DiagnosticsIssuesSection({
    issues,
    onOpenMedia,
}: DiagnosticsIssuesSectionProps): JSX.Element | null {
    // Nothing to list, nothing to show. The heading plus a card saying the environment
    // looks healthy repeated the green status at the top of the dialog, and it did it in
    // the largest block on the screen.
    if (issues.length === 0) {
        return null;
    }

    return (
        <Paper
            withBorder
            radius="xl"
            p="md"
            style={{
                background:
                    "light-dark(linear-gradient(180deg, rgba(0,0,0,0.028), rgba(0,0,0,0.015)), linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015)))",
            }}
        >
            <Stack gap="sm">
                <Title order={4}>Issues</Title>


                {issues.map((issue, index) => (
                    <Box key={issue.code}>
                        <Group justify="space-between" align="start" wrap="nowrap" gap="md">
                            <Group gap="sm" align="start" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                                <IssueSeverityIcon severity={issue.severity} />

                                <Box style={{ minWidth: 0 }}>
                                    <Text fw={700}>{issue.title}</Text>
                                    <Text size="sm" c="dimmed">
                                        {issue.description}
                                    </Text>

                                    {issue.examples && issue.examples.length > 0 && (
                                        <Stack gap={2} mt={6}>
                                            {issue.examples.map((example) => {
                                                const target = example.media;

                                                if (target && onOpenMedia) {
                                                    return (
                                                        <Anchor
                                                            key={example.path}
                                                            component="button"
                                                            type="button"
                                                            size="xs"
                                                            ff="monospace"
                                                            ta="left"
                                                            style={{ overflowWrap: "anywhere" }}
                                                            title="Open this media in the library"
                                                            onClick={() => onOpenMedia(target)}
                                                        >
                                                            {example.path}
                                                        </Anchor>
                                                    );
                                                }

                                                return (
                                                    <Text
                                                        key={example.path}
                                                        size="xs"
                                                        c="dimmed"
                                                        ff="monospace"
                                                        style={{ overflowWrap: "anywhere" }}
                                                    >
                                                        {example.path}
                                                    </Text>
                                                );
                                            })}
                                        </Stack>
                                    )}
                                </Box>
                            </Group>

                            <IssueSeverityBadge severity={issue.severity} />
                        </Group>

                        {index < issues.length - 1 && <Divider mt="md" />}
                    </Box>
                ))}
            </Stack>
        </Paper>
    );
}