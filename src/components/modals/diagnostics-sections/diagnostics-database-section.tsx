import { Stack } from "@mantine/core";
import { Database } from "lucide-react";
import type { MediaRepositoryStats } from "../../../types/diagnostics";
import { DiagnosticsDatabaseIntegrityCheck } from "./diagnostics-database-integrity-check";
import {
    DiagnosticsMetric,
    DiagnosticsMetricGrid,
    SectionHeading,
} from "./diagnostics-summary-primitives";

export function DiagnosticsDatabaseSection({
    stats,
}: {
    stats: MediaRepositoryStats;
}): JSX.Element {
    return (
        <Stack gap="sm">
            <SectionHeading icon={<Database size={16} />} title="Database" />

            <DiagnosticsMetricGrid>
                <DiagnosticsMetric label="Total media rows" value={stats.total_media} />
                <DiagnosticsMetric label="Video rows" value={stats.total_video_media} />
                <DiagnosticsMetric label="Audio rows" value={stats.total_audio_media} />
                <DiagnosticsMetric label="With thumbnail" value={stats.total_with_thumbnail} />
                <DiagnosticsMetric
                    label="Without thumbnail"
                    value={stats.total_without_thumbnail}
                />
                <DiagnosticsMetric label="Watched" value={stats.total_watched} />
                <DiagnosticsMetric label="Unwatched" value={stats.total_unwatched} />
            </DiagnosticsMetricGrid>

            <DiagnosticsDatabaseIntegrityCheck />
        </Stack>
    );
}
