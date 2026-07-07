import { useCallback } from "react";
import { Box, rem } from "@mantine/core";

type PlayerVideoSurfaceProps = {
    title: string;
    mediaSrc: string;
    thumbnailSrc: string;
    shellBorder: string;
    progressSeconds: number;
    onPlayerElementChange: (element: HTMLVideoElement | null) => void;
};

export function PlayerVideoSurface({
    title,
    mediaSrc,
    thumbnailSrc,
    shellBorder,
    progressSeconds,
    onPlayerElementChange,
}: PlayerVideoSurfaceProps): JSX.Element {
    const handleLoadedMetadata = useCallback(
        (event: React.SyntheticEvent<HTMLVideoElement>): void => {
            const element = event.currentTarget;

            if (progressSeconds > 0 && Number.isFinite(element.duration)) {
                const safeProgress = Math.min(progressSeconds, Math.max(0, element.duration - 1));
                element.currentTime = Math.max(0, safeProgress);
            }
        },
        [progressSeconds]
    );

    return (
        <Box
            style={{
                borderRadius: rem(26),
                overflow: "hidden",
                background:
                    "linear-gradient(180deg, rgba(255,255,255,0.025), rgba(255,255,255,0.015))",
                border: `1px solid ${shellBorder}`,
                padding: rem(10),
            }}
        >
            <Box
                style={{
                    width: "100%",
                    aspectRatio: "16 / 9",
                    background: "#000",
                    borderRadius: rem(20),
                    overflow: "hidden",
                }}
            >
                <video
                    aria-label={title ? `Video player: ${title}` : "Video player"}
                    controls
                    autoPlay
                    playsInline
                    src={mediaSrc}
                    poster={thumbnailSrc || undefined}
                    ref={onPlayerElementChange}
                    onLoadedMetadata={handleLoadedMetadata}
                    style={{
                        width: "100%",
                        height: "100%",
                        display: "block",
                        objectFit: "contain",
                        background: "#000",
                    }}
                />
            </Box>
        </Box>
    );
}