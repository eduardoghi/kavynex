import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Group, Paper, Stack, Text, rem } from "@mantine/core";
import { AlertTriangle, ArrowLeft, FolderOpen, PlayCircle } from "lucide-react";
import type { MediaRow } from "../../types/media";
import { logError } from "../../utils/app-logger";
import { formatCreatedAt, formatPublishedDate, shortPath } from "../../utils/media-utils";
import { useMediaProgressPersistence } from "../../hooks/use-media-progress-persistence";
import { useMediaComments } from "../../hooks/use-media-comments";
import { useMediaLiveChat } from "../../hooks/use-media-live-chat";
import { usePlayerKeyboardShortcuts } from "../../hooks/use-player-keyboard-shortcuts";
import { CommentsPanel } from "./comments-panel";
import { LiveChatReplay } from "./live-chat-replay";
import { PlayerAudioSurface } from "./player-audio-surface";
import { PlayerMediaHeader } from "./player-media-header";
import { PlayerVideoSurface } from "./player-video-surface";
import { RemoteImagesProvider } from "./remote-images-context";
import styles from "./media-player-view.module.css";

type MediaPlayerViewProps = {
    media: MediaRow | null;
    mediaSrc: string;
    thumbnailSrc: string;
    isAudio: boolean;
    shellBorder: string;
    canOpenInYoutube: boolean;
    isWatched: boolean;
    libraryPath: string;
    isRefreshingComments?: boolean;
    loadRemoteImages?: boolean;
    onOpenInYoutube: () => void | Promise<void>;
    onOpenFileLocation?: () => void | Promise<void>;
    onRefreshComments?: () => void | Promise<void>;
    onMarkWatched: () => void | Promise<void>;
    onMarkUnwatched: () => void | Promise<void>;
    onSaveProgress: (mediaId: number, progressSeconds: number) => void | Promise<void>;
    onBack: (progressSeconds?: number) => void | Promise<void>;
};

export function MediaPlayerView({
    media,
    mediaSrc,
    thumbnailSrc,
    isAudio,
    shellBorder,
    canOpenInYoutube,
    isWatched,
    libraryPath,
    isRefreshingComments = false,
    loadRemoteImages = false,
    onOpenInYoutube,
    onOpenFileLocation,
    onRefreshComments,
    onMarkWatched,
    onMarkUnwatched,
    onSaveProgress,
    onBack,
}: MediaPlayerViewProps): JSX.Element {
    const playerElementRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
    const backButtonRef = useRef<HTMLButtonElement>(null);
    const [playerElement, setPlayerElement] = useState<HTMLMediaElement | null>(null);
    const [hasPlaybackError, setHasPlaybackError] = useState(false);

    // Move focus into the player when it opens - the library grid stays mounted but hidden behind
    // it, so focus would otherwise be dropped on <body> - and restore it to whatever opened the
    // player (the originating card) when it closes, if that element is still around. Runs once for
    // the player's lifetime; the back control is the natural landing spot.
    useEffect(() => {
        const previouslyFocused = document.activeElement as HTMLElement | null;
        backButtonRef.current?.focus();

        return () => {
            if (previouslyFocused?.isConnected) {
                previouslyFocused.focus();
            }
        };
    }, []);

    // Each concern the player owns lives in its own hook: watch-position persistence, loading the
    // saved comments and live chat replay, and the global keyboard shortcuts. This component is
    // left to compose them and render.
    useMediaProgressPersistence(media, playerElement, onSaveProgress);
    const { comments, isLoadingComments } = useMediaComments(media, isRefreshingComments);
    const { liveChatMessages, isLoadingLiveChat } = useMediaLiveChat(media, libraryPath);
    usePlayerKeyboardShortcuts(playerElementRef);

    // Clear the "can't play" banner whenever the media (or its resolved source) changes, so a
    // playable file never inherits the previous file's error.
    useEffect(() => {
        setHasPlaybackError(false);
    }, [media?.id, mediaSrc]);

    const handlePlaybackError = useCallback(
        (error: MediaError | null): void => {
            setHasPlaybackError(true);
            logError(
                "media-player",
                "The built-in player could not play the media file.",
                error ?? undefined,
                {
                    mediaId: media?.id ?? null,
                    filePath: media?.file_path ?? null,
                    errorCode: error?.code ?? null,
                }
            );
        },
        [media?.id, media?.file_path]
    );

    const handlePlaybackRecovered = useCallback((): void => {
        setHasPlaybackError(false);
    }, []);

    const canPlay = Boolean(media && mediaSrc);
    const publishedLabel = formatPublishedDate(media?.published_at);
    const kavynexCreatedLabel = formatCreatedAt(media?.created_at);
    const filePathLabel = shortPath(media?.file_path ?? "");
    const hasComments = Boolean(media?.has_comments);
    const hasLiveChat = Boolean(media?.has_live_chat && media?.live_chat_file_path?.trim());

    const setVideoElement = useCallback((element: HTMLVideoElement | null): void => {
        playerElementRef.current = element;
        setPlayerElement(element);
    }, []);

    const setAudioElement = useCallback((element: HTMLAudioElement | null): void => {
        playerElementRef.current = element;
        setPlayerElement(element);
    }, []);

    const handleBack = useCallback(async (): Promise<void> => {
        const currentTime = playerElementRef.current?.currentTime ?? 0;
        await onBack(currentTime);
    }, [onBack]);

    if (!canPlay) {
        return (
            <Stack gap="md">
                <Group gap="sm" wrap="nowrap">
                    <Box
                        component="button"
                        type="button"
                        aria-label="Back to library"
                        onClick={() => {
                            void handleBack();
                        }}
                        style={{
                            width: rem(38),
                            height: rem(38),
                            borderRadius: rem(12),
                            background: "rgba(255,255,255,0.04)",
                            border: `1px solid ${shellBorder}`,
                            display: "grid",
                            placeItems: "center",
                            cursor: "pointer",
                        }}
                    >
                        <ArrowLeft size={18} />
                    </Box>

                    <Text fw={900} size="lg">
                        Player
                    </Text>
                </Group>

                <Paper
                    withBorder
                    radius="xl"
                    p="xl"
                    style={{
                        borderColor: shellBorder,
                        background:
                            "linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015))",
                        minHeight: rem(540),
                        display: "grid",
                        placeItems: "center",
                    }}
                >
                    <Stack gap="sm" align="center">
                        <Box
                            style={{
                                width: rem(64),
                                height: rem(64),
                                borderRadius: rem(20),
                                display: "grid",
                                placeItems: "center",
                                background: "rgba(255,255,255,0.04)",
                                border: `1px solid ${shellBorder}`,
                            }}
                        >
                            <PlayCircle size={30} />
                        </Box>

                        <Text fw={900} size="lg">
                            Unable to open media
                        </Text>

                        <Text c="dimmed" size="sm" ta="center" maw={520}>
                            Re-import the file so the app can store a valid local path.
                        </Text>
                    </Stack>
                </Paper>
            </Stack>
        );
    }

    const mediaSurface = isAudio ? (
        <PlayerAudioSurface
            title={media?.title ?? ""}
            thumbnailSrc={thumbnailSrc}
            mediaSrc={mediaSrc}
            shellBorder={shellBorder}
            publishedLabel={publishedLabel}
            createdLabel={kavynexCreatedLabel}
            filePathLabel={filePathLabel}
            progressSeconds={media?.watched_at ? 0 : (media?.progress_seconds ?? 0)}
            onPlayerElementChange={setAudioElement}
            onPlaybackError={handlePlaybackError}
            onPlaybackRecovered={handlePlaybackRecovered}
        />
    ) : (
        <PlayerVideoSurface
            title={media?.title ?? ""}
            mediaSrc={mediaSrc}
            thumbnailSrc={thumbnailSrc}
            shellBorder={shellBorder}
            progressSeconds={media?.watched_at ? 0 : (media?.progress_seconds ?? 0)}
            onPlayerElementChange={setVideoElement}
            onPlaybackError={handlePlaybackError}
            onPlaybackRecovered={handlePlaybackRecovered}
        />
    );

    return (
        <RemoteImagesProvider value={loadRemoteImages}>
            <Stack gap="md">
                <PlayerMediaHeader
                    backButtonRef={backButtonRef}
                    title={media?.title ?? ""}
                    publishedLabel={publishedLabel}
                    createdLabel={kavynexCreatedLabel}
                    shellBorder={shellBorder}
                    canOpenInYoutube={canOpenInYoutube}
                    isWatched={isWatched}
                    isAudio={isAudio}
                    onOpenInYoutube={onOpenInYoutube}
                    onOpenFileLocation={onOpenFileLocation}
                    onRefreshComments={onRefreshComments}
                    isRefreshingComments={isRefreshingComments}
                    onMarkWatched={onMarkWatched}
                    onMarkUnwatched={onMarkUnwatched}
                    onBack={() => {
                        void handleBack();
                    }}
                />

                {hasPlaybackError && (
                    <Alert
                        variant="light"
                        color="yellow"
                        icon={<AlertTriangle size={18} />}
                        title="This file can't be played here"
                    >
                        <Stack gap="sm">
                            <Text size="sm">
                                Kavynex's built-in player couldn't play this file - it may use a
                                format the player doesn't support. The file is still saved on
                                disk; open its location to play it in another app.
                            </Text>

                            {onOpenFileLocation && (
                                <Group>
                                    <Button
                                        size="xs"
                                        variant="light"
                                        color="yellow"
                                        leftSection={<FolderOpen size={14} />}
                                        onClick={() => void onOpenFileLocation()}
                                    >
                                        Open file location
                                    </Button>
                                </Group>
                            )}
                        </Stack>
                    </Alert>
                )}

                {hasLiveChat ? (
                    <Box className={styles.liveLayout}>
                        <Box style={{ minWidth: 0 }}>
                            {mediaSurface}
                        </Box>

                        <Box style={{ minWidth: 0 }}>
                            <LiveChatReplay
                                liveChatMessages={liveChatMessages}
                                playerElement={playerElement}
                                isLoadingLiveChat={isLoadingLiveChat}
                                shellBorder={shellBorder}
                            />
                        </Box>
                    </Box>
                ) : (
                    mediaSurface
                )}

                <CommentsPanel
                    comments={comments}
                    hasComments={hasComments}
                    commentsCount={media?.comments_count ?? comments.length}
                    isLoadingComments={isLoadingComments}
                    shellBorder={shellBorder}
                    canFetchComments={Boolean(media?.youtube_video_id?.trim())}
                    isFetchingComments={isRefreshingComments}
                    onFetchComments={onRefreshComments}
                />
            </Stack>
        </RemoteImagesProvider>
    );
}
