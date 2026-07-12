import { memo } from "react";
import {
    ActionIcon,
    Badge,
    Box,
    Group,
    Menu,
    Stack,
    Text,
    rem,
} from "@mantine/core";
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
import { StretchedButtonCard } from "../common/stretched-button-card";
import { UI_TEXT } from "../../constants/ui-text";
import type { MediaRow } from "../../types/media";
import { fileSrcFromStoredPath, formatDuration, formatPublishedDate } from "../../utils/media-utils";

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

export const MEDIA_CARD_HEIGHT = 292;
const MEDIA_THUMBNAIL_HEIGHT = 158;
const MEDIA_TITLE_HEIGHT = 44;
const MEDIA_FOOTER_HEIGHT = 28;

function MediaCardComponent({
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
    const commentsCount = media.comments_count;
    const hasYoutubeSource = Boolean(media.youtube_video_id?.trim());

    const handleOpen = (): void => {
        onOpen(media);
    };

    return (
        <StretchedButtonCard
            ariaLabel={`Open ${media.title}`}
            onClick={handleOpen}
            radius="xl"
            p="sm"
            style={{
                height: rem(MEDIA_CARD_HEIGHT),
                cursor: "pointer",
                background: isActive
                    ? "linear-gradient(180deg, rgba(124,92,255,0.16), rgba(14,165,233,0.06))"
                    : isWatched
                    ? "linear-gradient(180deg, rgba(34,197,94,0.07), rgba(34,197,94,0.025))"
                    : "rgba(255,255,255,0.028)",
                borderColor: isActive
                    ? "rgba(124,92,255,0.68)"
                    : isWatched
                    ? "rgba(34,197,94,0.28)"
                    : shellBorder,
                outline: "none",
                boxShadow: isActive
                    ? "0 0 0 1px rgba(124,92,255,0.24), 0 18px 42px rgba(80,50,180,0.22)"
                    : "0 12px 32px rgba(0,0,0,0.12)",
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
                    border: `1px solid ${isActive ? "rgba(124,92,255,0.52)" : shellBorder}`,
                    flexShrink: 0,
                }}
            >
                {thumbSrc ? (
                    <img
                        src={thumbSrc}
                        alt={media.title}
                        loading="lazy"
                        decoding="async"
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
                        <Badge variant="filled" color="violet">
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
                            c={isActive ? "violet.1" : undefined}
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
                                style={{
                                    // Above the stretched open-button overlay so the menu stays
                                    // clickable while the rest of the card opens the media.
                                    position: "relative",
                                    zIndex: 2,
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

                    <Group gap={6} wrap="nowrap">
                        {hasLiveChat && (
                            <Badge
                                variant="outline"
                                style={{
                                    flexShrink: 0,
                                    background: "rgba(239,68,68,0.14)",
                                    borderColor: "rgba(239,68,68,0.34)",
                                    color: "rgb(252,165,165)",
                                    fontWeight: 800,
                                }}
                            >
                                CHAT
                            </Badge>
                        )}

                        {commentsCount > 0 && (
                            <Badge
                                variant="outline"
                                leftSection={<MessageCircle size={12} />}
                                style={{
                                    flexShrink: 0,
                                    background: "rgba(255,255,255,0.055)",
                                    borderColor: "rgba(255,255,255,0.14)",
                                    color: "rgba(255,255,255,0.74)",
                                    fontWeight: 700,
                                    paddingInline: rem(8),
                                }}
                            >
                                {commentsCount}
                            </Badge>
                        )}

                        <Badge
                            variant="outline"
                            style={{
                                flexShrink: 0,
                                background: isAudio
                                    ? "rgba(249,115,22,0.13)"
                                    : "rgba(59,130,246,0.13)",
                                borderColor: isAudio
                                    ? "rgba(249,115,22,0.34)"
                                    : "rgba(59,130,246,0.34)",
                                color: isAudio
                                    ? "rgb(253,186,116)"
                                    : "rgb(147,197,253)",
                                fontWeight: 800,
                            }}
                        >
                            {isAudio ? UI_TEXT.library.mediaTypeAudio : UI_TEXT.library.mediaTypeVideo}
                        </Badge>
                    </Group>
                </Group>
            </Stack>
        </StretchedButtonCard>
    );
}

// Memoized so that unrelated state changes higher up (player, modals, sidebar) do not
// re-render every visible card. Relies on the handlers passed by Home being stable.
export const MediaCard = memo(MediaCardComponent);