import { Badge, Box, Group, Text, rem } from "@mantine/core";
import { Upload } from "lucide-react";
import type { MediaType } from "../../../types/media";
import { fileNameFromPath } from "../../../utils/media-utils";

type LocalMediaSectionProps = {
    mediaPath: string;
    mediaType: MediaType;
    isLocked: boolean;
    onPickMedia: () => void;
};

export function LocalMediaSection({
    mediaPath,
    mediaType,
    isLocked,
    onPickMedia,
}: LocalMediaSectionProps): JSX.Element {
    return (
        <Box
            role="button"
            tabIndex={isLocked ? -1 : 0}
            onClick={isLocked ? undefined : onPickMedia}
            onKeyDown={(event) => {
                if (isLocked) {
                    return;
                }

                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onPickMedia();
                }
            }}
            style={{
                borderRadius: rem(14),
                border: "1px solid rgba(255,255,255,0.18)",
                background: "rgba(255,255,255,0.02)",
                padding: rem(16),
                cursor: isLocked ? "progress" : "pointer",
                userSelect: "none",
                opacity: isLocked ? 0.7 : 1,
                outline: "none",
                transition: "opacity 140ms ease",
            }}
        >
            <Group wrap="nowrap" gap="sm" align="center">
                <Box
                    style={{
                        width: rem(42),
                        height: rem(42),
                        display: "grid",
                        placeItems: "center",
                        borderRadius: rem(12),
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(0,0,0,0.25)",
                        flex: "0 0 auto",
                    }}
                >
                    <Upload size={20} />
                </Box>

                <Box style={{ flex: 1, minWidth: 0 }}>
                    <Text fw={900} lineClamp={1}>
                        {mediaPath
                            ? fileNameFromPath(mediaPath)
                            : "Choose a video/audio file to import"}
                    </Text>

                    <Text size="sm" c="dimmed" lineClamp={2}>
                        {mediaPath ? "Click to change file" : "Click to choose a file"}
                    </Text>
                </Box>

                <Badge variant="light" color={mediaPath ? "violet" : "gray"}>
                    {mediaPath ? (mediaType === "audio" ? "audio" : "video") : "empty"}
                </Badge>
            </Group>
        </Box>
    );
}