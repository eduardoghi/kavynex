import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Group, Paper, Stack, Text, rem } from "@mantine/core";
import { ArrowLeft, PlayCircle } from "lucide-react";
import type { MediaCommentRow, MediaRow } from "../../types/media";
import { listMediaComments } from "../../services/media-service";
import {
    getVisibleLiveChatMessages,
    readLiveChatMessagesFromFile,
    type LiveChatMessageItem,
} from "../../services/live-chat-service";
import { logError } from "../../utils/app-logger";
import { formatCreatedAt, formatPublishedDate, shortPath } from "../../utils/media-utils";
import { CommentsPanel } from "./comments-panel";
import { LiveChatPanel } from "./live-chat-panel";
import { PlayerAudioSurface } from "./player-audio-surface";
import { PlayerMediaHeader } from "./player-media-header";
import { PlayerVideoSurface } from "./player-video-surface";

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
    onOpenInYoutube: () => void | Promise<void>;
    onOpenFileLocation?: () => void | Promise<void>;
    onRefreshComments?: () => void | Promise<void>;
    onMarkWatched: () => void | Promise<void>;
    onMarkUnwatched: () => void | Promise<void>;
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
    onOpenInYoutube,
    onOpenFileLocation,
    onRefreshComments,
    onMarkWatched,
    onMarkUnwatched,
    onBack,
}: MediaPlayerViewProps): JSX.Element {
    const playerElementRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);

    const [comments, setComments] = useState<MediaCommentRow[]>([]);
    const [isLoadingComments, setIsLoadingComments] = useState(false);

    const [liveChatMessages, setLiveChatMessages] = useState<LiveChatMessageItem[]>([]);
    const [visibleLiveChatMessages, setVisibleLiveChatMessages] = useState<LiveChatMessageItem[]>([]);
    const [isLoadingLiveChat, setIsLoadingLiveChat] = useState(false);
    const [currentPlaybackTime, setCurrentPlaybackTime] = useState(0);

    const canPlay = Boolean(media && mediaSrc);
    const publishedLabel = formatPublishedDate(media?.published_at);
    const kavynexCreatedLabel = formatCreatedAt(media?.created_at);
    const filePathLabel = shortPath(media?.file_path ?? "");
    const hasComments = Boolean(media?.has_comments);
    const hasLiveChat = Boolean(media?.has_live_chat && media?.live_chat_file_path?.trim());

    useEffect(() => {
        let cancelled = false;

        async function loadComments(): Promise<void> {
            if (!media?.id || !media.has_comments) {
                setComments([]);
                setIsLoadingComments(false);
                return;
            }

            setIsLoadingComments(true);

            try {
                const rows = await listMediaComments(media.id);

                if (!cancelled) {
                    setComments(rows);
                }
            } catch (error) {
                if (!cancelled) {
                    setComments([]);
                }

                logError("media-player", "Failed to load saved comments.", error, {
                    mediaId: media.id,
                });
            } finally {
                if (!cancelled) {
                    setIsLoadingComments(false);
                }
            }
        }

        void loadComments();

        return () => {
            cancelled = true;
        };
    }, [media?.has_comments, media?.id, isRefreshingComments]);

    useEffect(() => {
        let cancelled = false;

        async function loadLiveChat(): Promise<void> {
            if (!media?.id || !media.live_chat_file_path?.trim() || !media.has_live_chat) {
                setLiveChatMessages([]);
                setVisibleLiveChatMessages([]);
                setIsLoadingLiveChat(false);
                return;
            }

            setIsLoadingLiveChat(true);

            try {
                const rows = await readLiveChatMessagesFromFile(media.live_chat_file_path);

                if (!cancelled) {
                    setLiveChatMessages(rows);
                }
            } catch (error) {
                if (!cancelled) {
                    setLiveChatMessages([]);
                    setVisibleLiveChatMessages([]);
                }

                logError("media-player", "Failed to load live chat replay from file.", error, {
                    mediaId: media.id,
                    liveChatFilePath: media.live_chat_file_path,
                    libraryPath,
                });
            } finally {
                if (!cancelled) {
                    setIsLoadingLiveChat(false);
                }
            }
        }

        void loadLiveChat();

        return () => {
            cancelled = true;
        };
    }, [libraryPath, media?.has_live_chat, media?.id, media?.live_chat_file_path]);

    useEffect(() => {
        if (!hasLiveChat || liveChatMessages.length === 0) {
            setVisibleLiveChatMessages([]);
            return;
        }

        setVisibleLiveChatMessages(
            getVisibleLiveChatMessages(liveChatMessages, currentPlaybackTime)
        );
    }, [currentPlaybackTime, hasLiveChat, liveChatMessages]);

    useEffect(() => {
        const element = playerElementRef.current;

        if (!element) {
            return;
        }

        const syncCurrentTime = (): void => {
            setCurrentPlaybackTime(element.currentTime || 0);
        };

        syncCurrentTime();

        element.addEventListener("timeupdate", syncCurrentTime);
        element.addEventListener("seeking", syncCurrentTime);
        element.addEventListener("seeked", syncCurrentTime);
        element.addEventListener("loadedmetadata", syncCurrentTime);
        element.addEventListener("play", syncCurrentTime);
        element.addEventListener("pause", syncCurrentTime);

        return () => {
            element.removeEventListener("timeupdate", syncCurrentTime);
            element.removeEventListener("seeking", syncCurrentTime);
            element.removeEventListener("seeked", syncCurrentTime);
            element.removeEventListener("loadedmetadata", syncCurrentTime);
            element.removeEventListener("play", syncCurrentTime);
            element.removeEventListener("pause", syncCurrentTime);
        };
    }, [media?.id, mediaSrc]);

    const setVideoElement = useCallback((element: HTMLVideoElement | null): void => {
        playerElementRef.current = element;
    }, []);

    const setAudioElement = useCallback((element: HTMLAudioElement | null): void => {
        playerElementRef.current = element;
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
        />
    ) : (
        <PlayerVideoSurface
            mediaSrc={mediaSrc}
            thumbnailSrc={thumbnailSrc}
            shellBorder={shellBorder}
            progressSeconds={media?.watched_at ? 0 : (media?.progress_seconds ?? 0)}
            onPlayerElementChange={setVideoElement}
        />
    );

    return (
        <Stack gap="md">
            <PlayerMediaHeader
                title={media?.title ?? ""}
                publishedLabel={publishedLabel}
                createdLabel={kavynexCreatedLabel}
                shellBorder={shellBorder}
                canOpenInYoutube={canOpenInYoutube}
                isWatched={isWatched}
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

            {hasLiveChat ? (
                <>
                    <style>
                        {`
                            .kavynex-player-live-layout {
                                display: grid;
                                gap: 16px;
                                align-items: start;
                                grid-template-columns: minmax(0, 1fr);
                            }

                            @media (min-width: 1200px) {
                                .kavynex-player-live-layout {
                                    grid-template-columns: minmax(0, 1.75fr) minmax(360px, 0.82fr);
                                }
                            }
                        `}
                    </style>

                    <Box className="kavynex-player-live-layout">
                        <Box style={{ minWidth: 0 }}>
                            {mediaSurface}
                        </Box>

                        <Box style={{ minWidth: 0 }}>
                            <LiveChatPanel
                                liveChatMessages={liveChatMessages}
                                visibleLiveChatMessages={visibleLiveChatMessages}
                                isLoadingLiveChat={isLoadingLiveChat}
                                shellBorder={shellBorder}
                            />
                        </Box>
                    </Box>
                </>
            ) : (
                mediaSurface
            )}

            {hasLiveChat && (
                <Box
                    className="kavynex-player-live-layout"
                    style={{
                        display: "grid",
                        gap: rem(16),
                        alignItems: "start",
                        gridTemplateColumns: "minmax(0, 1fr)",
                    }}
                >
                    <Box
                        style={{
                            display: "none",
                        }}
                    />
                </Box>
            )}

            <CommentsPanel
                comments={comments}
                hasComments={hasComments}
                commentsCount={media?.comments_count ?? comments.length}
                isLoadingComments={isLoadingComments}
                shellBorder={shellBorder}
            />
        </Stack>
    );
}