import { Alert, Group, List, Text } from "@mantine/core";
import { AlertTriangle } from "lucide-react";
import type { ExternalToolName } from "../../../hooks/use-external-tools-availability";
import { AppButton } from "../../ui/app-button";

// What each tool is for, so the warning says what will actually break rather than only naming a
// missing binary. Neither line mentions a source mode. The hook already decided which tools matter
// for the mode in view, and a line that hedged about both would read as though it were unsure.
const TOOL_PURPOSE: Record<ExternalToolName, string> = {
    "yt-dlp": "downloads the media from the URL",
    ffmpeg: "merges a download's video and audio, and generates the thumbnail preview",
};

type ExternalToolsWarningProps = {
    missingTools: readonly ExternalToolName[];
    isChecking?: boolean;
    onCheckAgain?: () => void;
};

// Shown at the top of the import form when a tool the import needs is not available, so the user
// finds out before filling anything in rather than when the download refuses to start.
export function ExternalToolsWarning({
    missingTools,
    isChecking = false,
    onCheckAgain,
}: ExternalToolsWarningProps): JSX.Element | null {
    if (missingTools.length === 0) {
        return null;
    }

    const title =
        missingTools.length === 1
            ? `${missingTools[0]} was not found`
            : `${missingTools.join(" and ")} were not found`;

    return (
        <Alert variant="light" color="yellow" icon={<AlertTriangle size={18} />} title={title}>
            <List size="sm" spacing={4}>
                {missingTools.map((tool) => (
                    <List.Item key={tool}>
                        <Text size="sm" span>
                            <Text span fw={700}>
                                {tool}
                            </Text>{" "}
                            {TOOL_PURPOSE[tool]}.
                        </Text>
                    </List.Item>
                ))}
            </List>

            <Text size="sm" mt="xs">
                {missingTools.length === 1
                    ? "Install it, or put the executable in the app's tools folder, then check again."
                    : "Install them, or put the executables in the app's tools folder, then check again."}{" "}
                Diagnostics shows where Kavynex looked.
            </Text>

            {onCheckAgain && (
                <Group mt="xs">
                    <AppButton
                        type="button"
                        appVariant="secondary"
                        size="xs"
                        loading={isChecking}
                        onClick={onCheckAgain}
                    >
                        Check again
                    </AppButton>
                </Group>
            )}
        </Alert>
    );
}
