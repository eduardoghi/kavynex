import { Box, Group, Text, Tooltip } from "@mantine/core";
import { Headphones, Upload, Video } from "lucide-react";
import type { MediaType } from "../../../types/media";
import { MEDIA_TYPE_ACCENT_COLOR } from "../../../constants/media-type-accent";
import { fileNameFromPath } from "../../../utils/media-utils";
import {
    FILE_PICKER_BACKGROUND,
    FILE_PICKER_BORDER_COLOR,
    FILE_PICKER_PADDING,
    FILE_PICKER_PREVIEW_STYLE,
    FILE_PICKER_RADIUS,
} from "./file-picker-styles";

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
    const hasMedia = mediaPath.trim() !== "";
    const isAudio = mediaType === "audio";
    const typeLabel = isAudio ? "Audio" : "Video";

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
                borderRadius: FILE_PICKER_RADIUS,
                border: `1px solid ${FILE_PICKER_BORDER_COLOR}`,
                background: FILE_PICKER_BACKGROUND,
                padding: FILE_PICKER_PADDING,
                cursor: isLocked ? "progress" : "pointer",
                userSelect: "none",
                opacity: isLocked ? 0.7 : 1,
                outline: "none",
                transition:
                    "opacity 140ms ease, border-color 140ms ease, background 140ms ease",
            }}
        >
            <Group wrap="nowrap" gap="sm" align="center">
                {/* The leading square says which kind of file is loaded, using the glyph
                    and colour the library cards use. It held an upload arrow while a second
                    icon reported the type from the far end of the row, which is two marks
                    for one fact. Empty, it is still the upload arrow and still decorative,
                    since the line beside it says what to do. */}
                <Tooltip label={typeLabel} disabled={!hasMedia} withArrow>
                    <Box
                        role={hasMedia ? "img" : undefined}
                        aria-label={hasMedia ? typeLabel : undefined}
                        style={{
                            ...FILE_PICKER_PREVIEW_STYLE,
                            ...(hasMedia
                                ? {
                                      color: isAudio
                                          ? MEDIA_TYPE_ACCENT_COLOR.audio
                                          : MEDIA_TYPE_ACCENT_COLOR.video,
                                  }
                                : null),
                        }}
                    >
                        {hasMedia ? (
                            isAudio ? (
                                <Headphones size={20} />
                            ) : (
                                <Video size={20} />
                            )
                        ) : (
                            <Upload size={20} />
                        )}
                    </Box>
                </Tooltip>

                <Box style={{ flex: 1, minWidth: 0 }}>
                    {/* One line with an ellipsis, and the whole path on hover. A long file
                        name used to run the row wide enough to drag the rest of it out of
                        alignment. */}
                    <Tooltip label={mediaPath} disabled={!hasMedia} withArrow multiline w={420}>
                        <Text fw={900} truncate>
                            {hasMedia
                                ? fileNameFromPath(mediaPath)
                                : "Choose a video/audio file to import"}
                        </Text>
                    </Tooltip>

                    <Text size="sm" c="dimmed" lineClamp={2}>
                        {hasMedia ? "Click to change file" : "Click to choose a file"}
                    </Text>
                </Box>

            </Group>
        </Box>
    );
}