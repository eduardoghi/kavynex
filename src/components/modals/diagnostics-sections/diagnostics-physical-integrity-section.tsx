import { Stack } from "@mantine/core";
import { FileCheck } from "lucide-react";
import type { LibraryIntegrityReport } from "../../../types/diagnostics";
import { DiagnosticsContentVerification } from "./diagnostics-content-verification";
import {
    DiagnosticsExamplesList,
    DiagnosticsMetric,
    DiagnosticsMetricGrid,
    SectionHeading,
} from "./diagnostics-summary-primitives";

type DiagnosticsPhysicalIntegritySectionProps = {
    libraryIntegrity: LibraryIntegrityReport;
    libraryPath: string;
};

// What `stat` can say about the library against the database. Present, missing, orphaned,
// invalid, and the one corruption a size reveals (a zero-length file). The deep check that reads
// every byte sits at the foot of the section, user-triggered, because it costs what it costs.
export function DiagnosticsPhysicalIntegritySection({
    libraryIntegrity,
    libraryPath,
}: DiagnosticsPhysicalIntegritySectionProps): JSX.Element {
    return (
        <Stack gap="sm">
            <SectionHeading icon={<FileCheck size={16} />} title="Physical integrity" />

            <DiagnosticsMetricGrid>
                <DiagnosticsMetric
                    label="Checked media files"
                    value={libraryIntegrity.checked_media_files}
                />
                <DiagnosticsMetric
                    label="Missing media files"
                    value={libraryIntegrity.missing_media_files}
                />
                <DiagnosticsMetric
                    label="Checked thumbnails"
                    value={libraryIntegrity.checked_thumbnail_files}
                />
                <DiagnosticsMetric
                    label="Missing thumbnails"
                    value={libraryIntegrity.missing_thumbnail_files}
                />
                <DiagnosticsMetric
                    label="Orphan media files"
                    value={libraryIntegrity.orphan_media_files}
                />
                <DiagnosticsMetric
                    label="Orphan thumbnails"
                    value={libraryIntegrity.orphan_thumbnail_files}
                />
                <DiagnosticsMetric
                    label="Invalid media paths"
                    value={libraryIntegrity.invalid_media_files}
                />
                <DiagnosticsMetric
                    label="Invalid thumbnail paths"
                    value={libraryIntegrity.invalid_thumbnail_files}
                />
                <DiagnosticsMetric
                    label="Corrupt media files"
                    value={libraryIntegrity.corrupt_media_files}
                />
                <DiagnosticsMetric
                    label="Corrupt thumbnails"
                    value={libraryIntegrity.corrupt_thumbnail_files}
                />
            </DiagnosticsMetricGrid>

            <DiagnosticsExamplesList
                label="Missing media examples"
                items={libraryIntegrity.missing_media_examples}
            />

            <DiagnosticsExamplesList
                label="Missing thumbnail examples"
                items={libraryIntegrity.missing_thumbnail_examples}
            />

            <DiagnosticsExamplesList
                label="Orphan media examples"
                items={libraryIntegrity.orphan_media_examples}
            />

            <DiagnosticsExamplesList
                label="Orphan thumbnail examples"
                items={libraryIntegrity.orphan_thumbnail_examples}
            />

            <DiagnosticsExamplesList
                label="Invalid path examples"
                items={[
                    ...libraryIntegrity.invalid_media_examples,
                    ...libraryIntegrity.invalid_thumbnail_examples,
                ]}
            />

            <DiagnosticsExamplesList
                label="Corrupt file examples"
                items={[
                    ...libraryIntegrity.corrupt_media_examples,
                    ...libraryIntegrity.corrupt_thumbnail_examples,
                ]}
            />

            {/* The deep version of this same section. Everything above it is derived from `stat`,
                which is why it is here on open. The only damage a `stat` reveals is a zero-length
                file. */}
            <DiagnosticsContentVerification libraryPath={libraryPath} />
        </Stack>
    );
}
