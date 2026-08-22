import { Stack } from "@mantine/core";
import { MessagesSquare } from "lucide-react";
import type { LiveChatIntegrityReport } from "../../../types/diagnostics";
import {
    DiagnosticsExamplesList,
    DiagnosticsMetric,
    DiagnosticsMetricGrid,
    SectionHeading,
} from "./diagnostics-summary-primitives";

export function DiagnosticsLiveChatIntegritySection({
    liveChatIntegrity,
}: {
    liveChatIntegrity: LiveChatIntegrityReport;
}): JSX.Element {
    return (
        <Stack gap="sm">
            <SectionHeading icon={<MessagesSquare size={16} />} title="Live chat integrity" />

            <DiagnosticsMetricGrid>
                <DiagnosticsMetric
                    label="Checked live chat files"
                    value={liveChatIntegrity.checked_live_chat_files}
                />
                <DiagnosticsMetric
                    label="Missing live chat files"
                    value={liveChatIntegrity.missing_live_chat_files}
                />
                <DiagnosticsMetric
                    label="Corrupt live chat files"
                    value={liveChatIntegrity.corrupt_live_chat_files}
                />
                <DiagnosticsMetric
                    label="Orphan live chat files"
                    value={liveChatIntegrity.orphan_live_chat_files}
                />
            </DiagnosticsMetricGrid>

            <DiagnosticsExamplesList
                label="Missing live chat examples"
                items={liveChatIntegrity.missing_live_chat_examples}
            />

            <DiagnosticsExamplesList
                label="Corrupt live chat examples"
                items={liveChatIntegrity.corrupt_live_chat_examples}
            />

            <DiagnosticsExamplesList
                label="Orphan live chat examples"
                items={liveChatIntegrity.orphan_live_chat_examples}
            />
        </Stack>
    );
}
