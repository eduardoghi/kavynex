import { Box, rem } from "@mantine/core";
import { useMediaPlaybackHandlers } from "../../hooks/use-media-playback-handlers";

type PlayerVideoSurfaceProps = {
    title: string;
    mediaSrc: string;
    thumbnailSrc: string;
    shellBorder: string;
    progressSeconds: number;
    onPlayerElementChange: (element: HTMLVideoElement | null) => void;
    onPlaybackError?: (error: MediaError | null) => void;
    onPlaybackRecovered?: () => void;
};

export function PlayerVideoSurface({
    title,
    mediaSrc,
    thumbnailSrc,
    shellBorder,
    progressSeconds,
    onPlayerElementChange,
    onPlaybackError,
    onPlaybackRecovered,
}: PlayerVideoSurfaceProps): JSX.Element {
    const { handleLoadedMetadata, handleError, handleCanPlay } =
        useMediaPlaybackHandlers<HTMLVideoElement>({
            progressSeconds,
            onPlaybackError,
            onPlaybackRecovered,
        });

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
                    onError={handleError}
                    onCanPlay={handleCanPlay}
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