import { Badge, Box, Group, Paper, Text, rem } from "@mantine/core";
import { Image as ImageIcon } from "lucide-react";
import type { MediaType } from "../../../types/media";
import { fileSrcFromPath } from "../../../utils/media-utils";

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
    let badgeBackground = "rgba(255,255,255,0.055)";
    let badgeBorder = "rgba(255,255,255,0.14)";
    let badgeColor = "rgba(255,255,255,0.62)";
    let shouldShowBadge = !hasThumbnail;

    if (!canSelectThumb) {
        badgeLabel = "blocked";
        badgeBackground = "rgba(255,255,255,0.045)";
        badgeBorder = "rgba(255,255,255,0.10)";
        badgeColor = "rgba(255,255,255,0.7)";
        shouldShowBadge = true;
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
            radius="xl"
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
                borderStyle: "dashed",
                borderWidth: 1,
                borderColor: hasThumbnail
                    ? "rgba(139,92,246,0.24)"
                    : "rgba(255,255,255,0.16)",
                background: "rgba(255,255,255,0.02)",
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
                <Box
                    style={{
                        width: rem(46),
                        height: rem(46),
                        display: "grid",
                        placeItems: "center",
                        borderRadius: rem(14),
                        border: hasThumbnail
                            ? "1px solid rgba(139,92,246,0.18)"
                            : "1px solid rgba(255,255,255,0.12)",
                        background: hasThumbnail
                            ? "rgba(124,92,255,0.06)"
                            : "rgba(255,255,255,0.03)",
                        flex: "0 0 auto",
                        overflow: "hidden",
                    }}
                >
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
                    <Text fw={900} lineClamp={1}>
                        {!canSelectThumb
                            ? "Select a media file first"
                            : hasThumbnail
                              ? "Thumbnail selected"
                              : "Click to choose an image for thumbnail (optional)"}
                    </Text>

                    <Text size="sm" c="dimmed" lineClamp={3}>
                        {!canSelectThumb
                            ? "Choose a video or audio file before selecting a thumbnail"
                            : hasThumbnail
                              ? "Click to change thumbnail"
                              : isGeneratingThumb
                                ? "Generating automatic thumbnail..."
                                : isUrlMode
                                  ? "Optional. If you don’t choose one, the app will try to download the original thumbnail with yt-dlp, even for audio-only formats"
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