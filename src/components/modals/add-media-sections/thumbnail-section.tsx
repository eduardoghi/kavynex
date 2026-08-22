import { Badge, Box, Group, Paper, Text, Tooltip, rem } from "@mantine/core";
import { Image as ImageIcon } from "lucide-react";
import type { MediaType } from "../../../types/media";
import { fileNameFromPath, fileSrcFromPath } from "../../../utils/media-utils";
import {
    FILE_PICKER_BACKGROUND,
    FILE_PICKER_BORDER_COLOR,
    FILE_PICKER_PREVIEW_STYLE,
    FILE_PICKER_RADIUS,
} from "./file-picker-styles";

type ThumbnailSectionProps = {
    thumbPath: string;
    mediaType: MediaType;
    isGeneratingThumb: boolean;
    isBusy: boolean;
    canSelectThumb: boolean;
    isUrlMode: boolean;
    onPickThumb: () => void;
};

export function ThumbnailSection({
    thumbPath,
    mediaType,
    isGeneratingThumb,
    isBusy,
    canSelectThumb,
    isUrlMode,
    onPickThumb,
}: ThumbnailSectionProps): JSX.Element {
    const newThumbSrc = fileSrcFromPath(thumbPath || null);
    const hasThumbnail = thumbPath.trim() !== "";
    const isAudio = mediaType === "audio";

    let badgeLabel = "optional";
    let badgeBackground = "light-dark(rgba(0,0,0,0.05), rgba(255,255,255,0.055))";
    let badgeBorder = "light-dark(rgba(0,0,0,0.14), rgba(255,255,255,0.14))";
    let badgeColor = "light-dark(rgba(0,0,0,0.58), rgba(255,255,255,0.62))";
    let shouldShowBadge = !hasThumbnail;

    // No badge while the area is unavailable. The heading already says to pick a media
    // file first and the body says why, so "blocked" was a third way of saying it.
    if (!canSelectThumb) {
        shouldShowBadge = false;
    } else if (isGeneratingThumb) {
        badgeLabel = "loading";
        badgeBackground = "rgba(234,179,8,0.13)";
        badgeBorder = "rgba(234,179,8,0.34)";
        badgeColor = "rgb(253,224,71)";
        shouldShowBadge = true;
    }

    return (
        <Paper
            withBorder
            radius={FILE_PICKER_RADIUS}
            p="md"
            role="button"
            tabIndex={!isBusy && canSelectThumb ? 0 : -1}
            onClick={!isBusy && canSelectThumb ? onPickThumb : undefined}
            onKeyDown={(event) => {
                if (isBusy || !canSelectThumb) {
                    return;
                }

                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onPickThumb();
                }
            }}
            style={{
                // Dashed only while it is still an area to drop a file into. With one
                // chosen it is a field showing what was chosen, like the media picker
                // above it.
                borderStyle: hasThumbnail ? "solid" : "dashed",
                borderWidth: 1,
                borderColor: FILE_PICKER_BORDER_COLOR,
                background: FILE_PICKER_BACKGROUND,
                cursor: !canSelectThumb ? "not-allowed" : isBusy ? "progress" : "pointer",
                userSelect: "none",
                opacity: !canSelectThumb ? 0.55 : isAudio ? 0.92 : 1,
                pointerEvents: !canSelectThumb ? "none" : "auto",
                outline: "none",
                transition:
                    "opacity 160ms ease, border-color 160ms ease, background 160ms ease",
            }}
        >
            <Group wrap="nowrap" gap="sm" align="center">
                <Box style={FILE_PICKER_PREVIEW_STYLE}>
                    {newThumbSrc ? (
                        <img
                            src={newThumbSrc}
                            alt="Thumbnail preview"
                            style={{
                                width: "100%",
                                height: "100%",
                                objectFit: "cover",
                            }}
                        />
                    ) : (
                        <ImageIcon size={20} />
                    )}
                </Box>

                <Box style={{ flex: 1, minWidth: 0 }}>
                    {/* One line with an ellipsis, and the whole path on hover, the same
                        treatment the media picker above uses. The badge beside this already
                        says optional, so the heading does not need to. */}
                    <Tooltip
                        label={thumbPath}
                        disabled={!hasThumbnail}
                        withArrow
                        multiline
                        w={420}
                    >
                        <Text fw={900} truncate>
                            {!canSelectThumb
                                ? "Select a media file first"
                                : hasThumbnail
                                  ? fileNameFromPath(thumbPath)
                                  : "Choose thumbnail"}
                        </Text>
                    </Tooltip>

                    <Text size="sm" c="dimmed" lineClamp={3}>
                        {!canSelectThumb
                            ? "Choose a video or audio file before selecting a thumbnail"
                            : hasThumbnail
                              ? "Click to change thumbnail"
                              : isGeneratingThumb
                                ? "Generating automatic thumbnail..."
                                : isUrlMode
                                  ? "If you don’t choose one, the app will try to download the original thumbnail with yt-dlp, including for audio-only formats."
                                  : mediaType === "video"
                                    ? "Automatic thumbnail is generated for videos, but you can replace it"
                                    : "For audio, if you don’t choose an image, it will show an audio icon"}
                    </Text>
                </Box>

                {shouldShowBadge && (
                    <Badge
                        variant="outline"
                        style={{
                            flexShrink: 0,
                            paddingInline: rem(8),
                            background: badgeBackground,
                            borderColor: badgeBorder,
                            color: badgeColor,
                            fontWeight: 800,
                        }}
                    >
                        {badgeLabel}
                    </Badge>
                )}
            </Group>
        </Paper>
    );
}