import { Box, Group, Text } from "@mantine/core";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { DiagnosticsOverview, DiagnosticsOverviewStatus } from "../../../types/diagnostics";
import { StatusBadge } from "./diagnostics-summary-primitives";

// The status colours the overview icon used to carry inside a tinted circle. The circle went, the
// colour did not, since it is the only thing distinguishing the three states at a glance.
const OVERVIEW_ICON_COLOR: Record<DiagnosticsOverviewStatus, string> = {
    healthy: "light-dark(#15803D, rgb(134,239,172))",
    warning: "light-dark(#A16207, rgb(253,224,71))",
    error: "light-dark(#B91C1C, rgb(252,165,165))",
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

// The headline of the report: one line of status, one of explanation, and the issue counts when
// there are any. The overview was a card wrapping an icon tile, a headline, a sentence and a badge.
// The badge said what the headline says, so the headline kept the job.
export function DiagnosticsOverviewHeader({
    overview,
}: {
    overview: DiagnosticsOverview;
}): JSX.Element {
    return (
        <>
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
        </>
    );
}
