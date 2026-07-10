import { useCallback } from "react";
import { Box, Group, Stack, Text, rem } from "@mantine/core";
import { Music } from "lucide-react";

type PlayerAudioSurfaceProps = {
    title: string;
    thumbnailSrc: string;
    mediaSrc: string;
    shellBorder: string;
    publishedLabel: string;
    createdLabel: string;
    filePathLabel: string;
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
    publishedLabel,
    createdLabel,
    filePathLabel,
    progressSeconds,
    onPlayerElementChange,
    onPlaybackError,
    onPlaybackRecovered,
}: PlayerAudioSurfaceProps): JSX.Element {
    const handleLoadedMetadata = useCallback(
        (event: React.SyntheticEvent<HTMLAudioElement>): void => {
            const element = event.currentTarget;

            if (progressSeconds > 0 && Number.isFinite(element.duration)) {
                const safeProgress = Math.min(progressSeconds, Math.max(0, element.duration - 1));
                element.currentTime = Math.max(0, safeProgress);
            }
        },
        [progressSeconds]
    );

    const handleError = useCallback(
        (event: React.SyntheticEvent<HTMLAudioElement>): void => {
            onPlaybackError?.(event.currentTarget.error);
        },
        [onPlaybackError]
    );

    const handleCanPlay = useCallback((): void => {
        onPlaybackRecovered?.();
    }, [onPlaybackRecovered]);

    return (
        <Box
            style={{
                borderRadius: rem(24),
                border: `1px solid ${shellBorder}`,
                background: "linear-gradient(180deg, #101114 0%, #0b0c0f 100%)",
                minHeight: rem(560),
                padding: rem(40),
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
            }}
        >
            <Group
                gap={rem(32)}
                wrap="nowrap"
                align="center"
                style={{
                    width: "100%",
                    maxWidth: rem(980),
                }}
            >
                <Box
                    style={{
                        width: rem(260),
                        height: rem(260),
                        borderRadius: rem(28),
                        overflow: "hidden",
                        background: thumbnailSrc
                            ? "#111"
                            : "linear-gradient(135deg, rgba(139,92,246,0.18), rgba(59,130,246,0.14))",
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
                        <Music size={56} />
                    )}
                </Box>

                <Stack gap="lg" style={{ flex: 1, minWidth: 0 }}>
                    <Stack gap="xs">
                        <Text fw={900} size="2rem" lh={1.1} lineClamp={2}>
                            {title}
                        </Text>

                        <Text c="dimmed" size="sm" lineClamp={1}>
                            Published: {publishedLabel || "No publication date"}
                        </Text>

                        <Text c="dimmed" size="sm" lineClamp={1}>
                            Added to Kavynex: {createdLabel || "Unknown date"}
                        </Text>

                        <Text c="dimmed" size="sm" lineClamp={1}>
                            {filePathLabel}
                        </Text>
                    </Stack>

                    <Box
                        style={{
                            borderRadius: rem(16),
                            border: `1px solid ${shellBorder}`,
                            background: "rgba(255,255,255,0.03)",
                            padding: rem(16),
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
                </Stack>
            </Group>
        </Box>
    );
}