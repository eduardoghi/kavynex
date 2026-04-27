import { ActionIcon, Badge, Box, Card, Group, Menu, Stack, Text, rem } from "@mantine/core";
import {
    CheckCircle2,
    ExternalLink,
    FolderOpen,
    MessageCircle,
    MoreVertical,
    Music,
    Play,
    RotateCcw,
    Trash2,
    Eye,
    Pencil,
    Radio,
} from "lucide-react";
import { UI_TEXT } from "../../constants/ui-text";
import type { MediaRow } from "../../types/media";
import { fileSrcFromStoredPath, formatPublishedDate } from "../../utils/media-utils";

type MediaCardProps = {
    media: MediaRow;
    libraryPath: string;
    shellBorder: string;
    isActive?: boolean;
    onOpen: (media: MediaRow) => void;
    onRequestDelete: (media: MediaRow) => void;
    onOpenFileLocation?: (media: MediaRow) => void;
    onOpenSourceInYoutube?: (media: MediaRow) => void;
    onMarkWatched?: (media: MediaRow) => void;
    onMarkUnwatched?: (media: MediaRow) => void;
    onEditTitle?: (media: MediaRow) => void;
};

const MEDIA_CARD_HEIGHT = 292;
const MEDIA_THUMBNAIL_HEIGHT = 158;
const MEDIA_TITLE_HEIGHT = 44;
const MEDIA_FOOTER_HEIGHT = 28;

function formatDuration(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
        return "";
    }

    const totalSeconds = Math.floor(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
    }

    return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function MediaCard({
    media,
    libraryPath,
    shellBorder,
    isActive = false,
    onOpen,
    onRequestDelete,
    onOpenFileLocation,
    onOpenSourceInYoutube,
    onMarkWatched,
    onMarkUnwatched,
    onEditTitle,
}: MediaCardProps): JSX.Element {
    const isAudio = media.media_type === "audio";
    const isWatched = Boolean(media.watched_at?.trim());
    const isLive = Boolean(media.is_live);
    const hasLiveChat = Boolean(media.has_live_chat);
    const thumbSrc = fileSrcFromStoredPath(media.thumbnail_path, libraryPath);
    const publishedLabel = formatPublishedDate(media.published_at);
    const durationLabel = formatDuration(media.duration_seconds);
    const commentsCount =
        "comments_count" in media && typeof media.comments_count === "number"
            ? media.comments_count
            : 0;
    const hasYoutubeSource = Boolean(media.youtube_video_id?.trim());

    const handleOpen = (): void => {
        onOpen(media);
    };

    return (
        <Card
            withBorder
            radius="xl"
            p="sm"
            role="button"
            tabIndex={0}
            aria-label={`Open ${media.title}`}
            onClick={handleOpen}
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    handleOpen();
                }
            }}
            style={{
                height: rem(MEDIA_CARD_HEIGHT),
                cursor: "pointer",
                background: isActive
                    ? "linear-gradient(180deg, rgba(96,165,250,0.10), rgba(59,130,246,0.04))"
                    : isWatched
                      ? "rgba(34,197,94,0.05)"
                      : "rgba(255,255,255,0.02)",
                borderColor: isActive
                    ? "rgba(96,165,250,0.55)"
                    : isWatched
                      ? "rgba(34,197,94,0.22)"
                      : shellBorder,
                outline: "none",
                boxShadow: isActive
                    ? "0 0 0 1px rgba(96,165,250,0.22), 0 18px 40px rgba(37,99,235,0.16)"
                    : "none",
                transform: isActive ? "translateY(-2px)" : "none",
                transition:
                    "transform 140ms ease, border-color 140ms ease, background 140ms ease, box-shadow 140ms ease",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
            }}
        >
            <Box
                style={{
                    height: rem(MEDIA_THUMBNAIL_HEIGHT),
                    minHeight: rem(MEDIA_THUMBNAIL_HEIGHT),
                    maxHeight: rem(MEDIA_THUMBNAIL_HEIGHT),
                    borderRadius: rem(14),
                    overflow: "hidden",
                    position: "relative",
                    background:
                        "radial-gradient(220px 130px at 55% 35%, rgba(168,85,247,0.28), transparent 60%)," +
                        "radial-gradient(260px 160px at 35% 65%, rgba(59,130,246,0.22), transparent 65%)," +
                        "linear-gradient(180deg, rgba(0,0,0,0.38), rgba(0,0,0,0.52))",
                    border: `1px solid ${isActive ? "rgba(96,165,250,0.45)" : shellBorder}`,
                    flexShrink: 0,
                }}
            >
                {thumbSrc ? (
                    <img
                        src={thumbSrc}
                        alt={media.title}
                        style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "cover",
                            display: "block",
                        }}
                    />
                ) : (
                    <Box
                        style={{
                            height: "100%",
                            display: "grid",
                            placeItems: "center",
                            opacity: 0.95,
                        }}
                    >
                        {isAudio ? <Music size={34} /> : <Play size={34} />}
                    </Box>
                )}

                <Group
                    gap="xs"
                    style={{
                        position: "absolute",
                        top: rem(10),
                        left: rem(10),
                    }}
                >
                    {isActive && (
                        <Badge variant="filled" color="blue">
                            {UI_TEXT.library.selected}
                        </Badge>
                    )}

                    {isWatched && (
                        <Badge
                            variant="filled"
                            color="green"
                            leftSection={<CheckCircle2 size={12} />}
                        >
                            {UI_TEXT.library.watchedBadge}
                        </Badge>
                    )}

                    {isLive && (
                        <Badge
                            variant="filled"
                            color="red"
                            leftSection={<Radio size={12} />}
                        >
                            LIVE
                        </Badge>
                    )}
                </Group>

                {durationLabel && (
                    <Badge
                        variant="filled"
                        color="dark"
                        style={{
                            position: "absolute",
                            right: rem(6),
                            bottom: rem(6),
                            background: "rgba(0, 0, 0, 0.78)",
                            color: "#ffffff",
                            fontWeight: 800,
                            letterSpacing: rem(0.2),
                            pointerEvents: "none",
                        }}
                    >
                        {durationLabel}
                    </Badge>
                )}
            </Box>

            <Stack
                gap={6}
                mt="sm"
                style={{
                    flex: 1,
                    minHeight: 0,
                    overflow: "hidden",
                }}
            >
                <Group
                    justify="space-between"
                    wrap="nowrap"
                    gap="xs"
                    align="start"
                    style={{
                        height: rem(MEDIA_TITLE_HEIGHT),
                        minHeight: rem(MEDIA_TITLE_HEIGHT),
                        maxHeight: rem(MEDIA_TITLE_HEIGHT),
                    }}
                >
                    <Box style={{ minWidth: 0, flex: 1 }}>
                        <Text
                            fw={900}
                            lineClamp={2}
                            title={media.title}
                            c={isActive ? "blue.1" : undefined}
                            style={{
                                lineHeight: 1.25,
                            }}
                        >
                            {media.title}
                        </Text>
                    </Box>

                    <Menu withinPortal position="bottom-end" shadow="md">
                        <Menu.Target>
                            <ActionIcon
                                variant="subtle"
                                aria-label={`Actions for ${media.title}`}
                                onClick={(event) => event.stopPropagation()}
                                onKeyDown={(event) => event.stopPropagation()}
                                style={{
                                    flexShrink: 0,
                                }}
                            >
                                <MoreVertical size={18} />
                            </ActionIcon>
                        </Menu.Target>

                        <Menu.Dropdown onClick={(event) => event.stopPropagation()}>
                            {onOpenFileLocation && (
                                <Menu.Item
                                    leftSection={<FolderOpen size={16} />}
                                    onClick={() => onOpenFileLocation(media)}
                                >
                                    Open file location
                                </Menu.Item>
                            )}

                            {hasYoutubeSource && onOpenSourceInYoutube && (
                                <Menu.Item
                                    leftSection={<ExternalLink size={16} />}
                                    onClick={() => onOpenSourceInYoutube(media)}
                                >
                                    Open source on YouTube
                                </Menu.Item>
                            )}

                            {onEditTitle && (
                                <Menu.Item
                                    leftSection={<Pencil size={16} />}
                                    onClick={() => onEditTitle(media)}
                                >
                                    Edit title
                                </Menu.Item>
                            )}

                            {!isWatched && onMarkWatched && (
                                <Menu.Item
                                    leftSection={<Eye size={16} />}
                                    onClick={() => onMarkWatched(media)}
                                >
                                    Mark as watched
                                </Menu.Item>
                            )}

                            {isWatched && onMarkUnwatched && (
                                <Menu.Item
                                    leftSection={<RotateCcw size={16} />}
                                    onClick={() => onMarkUnwatched(media)}
                                >
                                    Mark as unwatched
                                </Menu.Item>
                            )}

                            <Menu.Item
                                color="red"
                                leftSection={<Trash2 size={16} />}
                                onClick={() => onRequestDelete(media)}
                            >
                                {UI_TEXT.library.delete}
                            </Menu.Item>
                        </Menu.Dropdown>
                    </Menu>
                </Group>

                <Group
                    justify="space-between"
                    align="center"
                    gap="xs"
                    wrap="nowrap"
                    style={{
                        height: rem(MEDIA_FOOTER_HEIGHT),
                        minHeight: rem(MEDIA_FOOTER_HEIGHT),
                        maxHeight: rem(MEDIA_FOOTER_HEIGHT),
                        marginTop: "auto",
                    }}
                >
                    <Text
                        size="xs"
                        c="dimmed"
                        truncate
                        style={{
                            minWidth: 0,
                            flex: 1,
                        }}
                    >
                        {publishedLabel || UI_TEXT.library.noPublicationDate}
                    </Text>

                    <Group gap="xs" wrap="nowrap">
                        {hasLiveChat && (
                            <Badge
                                variant="light"
                                color="red"
                                style={{
                                    flexShrink: 0,
                                }}
                            >
                                CHAT
                            </Badge>
                        )}

                        {commentsCount > 0 && (
                            <Badge
                                variant="light"
                                color="gray"
                                leftSection={<MessageCircle size={12} />}
                                style={{
                                    flexShrink: 0,
                                }}
                            >
                                {commentsCount}
                            </Badge>
                        )}

                        <Badge
                            variant="light"
                            color={isAudio ? "orange" : "blue"}
                            style={{
                                flexShrink: 0,
                            }}
                        >
                            {isAudio ? UI_TEXT.library.mediaTypeAudio : UI_TEXT.library.mediaTypeVideo}
                        </Badge>
                    </Group>
                </Group>
            </Stack>
        </Card>
    );
}