import { Box, Divider, Group, Paper, Stack, Text, ThemeIcon, Title, Badge } from "@mantine/core";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import type { DiagnosticsIssue } from "../../../types/diagnostics";

type DiagnosticsIssuesSectionProps = {
    issues: DiagnosticsIssue[];
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
}: DiagnosticsIssuesSectionProps): JSX.Element {
    return (
        <Paper
            withBorder
            radius="xl"
            p="md"
            style={{
                background:
                    "linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015))",
            }}
        >
            <Stack gap="sm">
                <Title order={4}>Issues</Title>

                {issues.length === 0 && (
                    <Paper withBorder radius="lg" p="md" style={{ background: "rgba(255,255,255,0.02)" }}>
                        <Group gap="sm">
                            <ThemeIcon color="green" variant="light" radius="xl">
                                <CheckCircle2 size={16} />
                            </ThemeIcon>

                            <Box>
                                <Text fw={700}>No issues detected</Text>
                                <Text size="sm" c="dimmed">
                                    The current environment looks healthy.
                                </Text>
                            </Box>
                        </Group>
                    </Paper>
                )}

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
                                            {issue.examples.map((path) => (
                                                <Text
                                                    key={path}
                                                    size="xs"
                                                    c="dimmed"
                                                    ff="monospace"
                                                    style={{ overflowWrap: "anywhere" }}
                                                >
                                                    {path}
                                                </Text>
                                            ))}
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