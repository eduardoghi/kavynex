import { Group, Stack } from "@mantine/core";
import { Wrench } from "lucide-react";
import { DiagnosticsMetric, SectionHeading } from "./diagnostics-summary-primitives";

type DiagnosticsApplicationSectionProps = {
    appVersion: string | null;
    platform: string;
    arch: string;
    importMode: string;
};

export function DiagnosticsApplicationSection({
    appVersion,
    platform,
    arch,
    importMode,
}: DiagnosticsApplicationSectionProps): JSX.Element {
    return (
        <Stack gap="xs">
            <SectionHeading icon={<Wrench size={16} />} title="Application" />

            <Group gap={48} wrap="wrap">
                <DiagnosticsMetric label="Version" value={appVersion ?? "Unknown"} />
                <DiagnosticsMetric label="Runtime" value={`${platform} · ${arch}`} />
                <DiagnosticsMetric
                    label="Import mode"
                    value={importMode === "copy" ? "Copy" : "Move"}
                />
            </Group>
        </Stack>
    );
}
