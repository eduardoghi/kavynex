import { Stack } from "@mantine/core";
import { MessageCircle } from "lucide-react";
import type { LiveChatStorageInfo, MediaRepositoryStats } from "../../../types/diagnostics";
import {
    DiagnosticsMetric,
    DiagnosticsMetricGrid,
    SectionHeading,
} from "./diagnostics-summary-primitives";

type DiagnosticsLiveChatSectionProps = {
    liveChatStorage: LiveChatStorageInfo;
    stats: MediaRepositoryStats;
};

export function DiagnosticsLiveChatSection({
    liveChatStorage,
    stats,
}: DiagnosticsLiveChatSectionProps): JSX.Element {
    return (
        <Stack gap="sm">
            <SectionHeading icon={<MessageCircle size={16} />} title="Live chat" />

            <DiagnosticsMetricGrid>
                <DiagnosticsMetric label="Stored files" value={liveChatStorage.live_chat_files} />
                <DiagnosticsMetric label="Live media" value={stats.total_live_media} />
                <DiagnosticsMetric label="With live chat" value={stats.total_with_live_chat} />
                <DiagnosticsMetric
                    label="Without live chat"
                    value={stats.total_without_live_chat}
                />
                <DiagnosticsMetric
                    label="Flagged without path"
                    value={stats.total_media_with_live_chat_flag_but_no_path}
                />
                <DiagnosticsMetric
                    label="Path on non-live media"
                    value={stats.total_media_with_live_chat_path_but_not_live}
                />
            </DiagnosticsMetricGrid>
        </Stack>
    );
}
