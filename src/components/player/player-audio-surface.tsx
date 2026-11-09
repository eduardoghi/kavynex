import { Box, Group, rem } from "@mantine/core";
import { Music } from "lucide-react";
import { useMediaPlaybackHandlers } from "../../hooks/media/use-media-playback-handlers";

type PlayerAudioSurfaceProps = {
    // Not rendered. It names the cover image and the audio element for assistive tech, which is
    // the only place the title still belongs here now that the header owns it on screen.
    title: string;
    thumbnailSrc: string;
    mediaSrc: string;
    shellBorder: string;
    progressSeconds: number;
    onPlayerElementChange: (element: HTMLAudioElement | null) => void;
    onPlaybackError?: (error: MediaError | null) => void;
    onPlaybackRecovered?: () => void;
};

export function PlayerAudioSurface({
    title,
    thumbnailSrc,
    mediaSrc,
    shellBorder,
    progressSeconds,
    onPlayerElementChange,
    onPlaybackError,
    onPlaybackRecovered,
}: PlayerAudioSurfaceProps): JSX.Element {
    const { handleLoadedMetadata, handleError, handleCanPlay } =
        useMediaPlaybackHandlers<HTMLAudioElement>({
            progressSeconds,
            onPlaybackError,
            onPlaybackRecovered,
        });

    return (
        // The minHeight is a floor, not the old fixed 560 that made audio pretend to be a video.
        // A 320px cover plus the padding already reaches that floor on its own, so nothing
        // binds on it today. It stays as the guard for the height this block was sized to hold,
        // which is what would keep it from collapsing back to a strip if the cover shrinks.
        <Box
            style={{
                borderRadius: rem(8),
                border: `1px solid ${shellBorder}`,
                background: "light-dark(#ffffff, #17181B)",
                minHeight: rem(232),
                padding: rem(26),
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
            }}
        >
            <Group
                gap={rem(28)}
                wrap="nowrap"
                align="center"
                style={{
                    width: "100%",
                    maxWidth: rem(980),
                }}
            >
                <Box
                    style={{
                        width: rem(320),
                        aspectRatio: "16 / 9",
                        borderRadius: rem(6),
                        overflow: "hidden",
                        background: thumbnailSrc
                            ? "light-dark(#E8E9EB, #111214)"
                            : "#26282D",
                        border: `1px solid ${shellBorder}`,
                        flex: "0 0 auto",
                        display: "grid",
                        placeItems: "center",
                    }}
                >
                    {thumbnailSrc ? (
                        <img
                            src={thumbnailSrc}
                            alt={title || "Audio cover"}
                            style={{
                                width: "100%",
                                height: "100%",
                                objectFit: "cover",
                                display: "block",
                            }}
                        />
                    ) : (
                        <Music size={44} />
                    )}
                </Box>

                <Box
                    style={{
                        flex: 1,
                        minWidth: 0,
                        borderRadius: rem(16),
                        border: `1px solid ${shellBorder}`,
                        background: "light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.03))",
                        padding: rem(14),
                    }}
                >
                    <audio
                        aria-label={title ? `Audio player: ${title}` : "Audio player"}
                        controls
                        autoPlay
                        src={mediaSrc}
                        ref={onPlayerElementChange}
                        onLoadedMetadata={handleLoadedMetadata}
                        onError={handleError}
                        onCanPlay={handleCanPlay}
                        style={{
                            width: "100%",
                            display: "block",
                        }}
                    />
                </Box>
            </Group>
        </Box>
    );
}
