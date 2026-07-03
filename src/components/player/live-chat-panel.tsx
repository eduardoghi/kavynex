import { useEffect, useRef } from "react";
import {
    Anchor,
    Badge,
    Box,
    Divider,
    Group,
    Loader,
    Paper,
    Stack,
    Text,
    rem,
} from "@mantine/core";
import { Check, MessageCircle, Wrench } from "lucide-react";
import type { LiveChatMessageItem } from "../../services/live-chat-service";
import { openAuthorYoutubeChannel } from "../../services/author-navigation";
import { avatarInitials, resolveAvatarSrc } from "../../utils/avatar";
import { SafeAvatar } from "./safe-avatar";

// YouTube colors the whole author name by role instead of using separate badge chips.
const OWNER_HIGHLIGHT_COLOR = "#ffd600";
const MODERATOR_NAME_COLOR = "#5e84f1";
const MEMBER_NAME_COLOR = "#2ba640";

type LiveChatPanelProps = {
    liveChatMessages: LiveChatMessageItem[];
    visibleLiveChatMessages: LiveChatMessageItem[];
    isLoadingLiveChat: boolean;
    shellBorder: string;
};

type LiveChatItemProps = {
    message: LiveChatMessageItem;
    shellBorder: string;
};

function LiveChatItem({ message, shellBorder }: LiveChatItemProps): JSX.Element {
    const avatarSrc = resolveAvatarSrc(message.author_thumbnail);
    const authorChannelId = message.author_channel_id;
    const isOwner = message.author_badges.some((badge) => badge.type === "owner");
    const isModerator = message.author_badges.some((badge) => badge.type === "moderator");
    const isMember = message.author_badges.some((badge) => badge.type === "member");
    const isVerified = message.author_badges.some((badge) => badge.type === "verified");

    // YouTube colors the whole name by role: owner gets a highlight box, moderator blue,
    // member green, everyone else the default text color.
    const roleColor = isModerator
        ? MODERATOR_NAME_COLOR
        : isMember
        ? MEMBER_NAME_COLOR
        : undefined;
    const ownerBoxStyle = isOwner
        ? {
              background: OWNER_HIGHLIGHT_COLOR,
              borderRadius: "4px",
              padding: "1px 6px",
          }
        : undefined;
    const nameStyle = { color: isOwner ? "#0f0f0f" : roleColor ?? "inherit", ...ownerBoxStyle };

    const nameContent = (
        <>
            {message.author_name}
            {isModerator && (
                <Wrench
                    size={12}
                    aria-label="Moderator"
                    style={{ marginLeft: 4, verticalAlign: "middle" }}
                />
            )}
            {isOwner && isVerified && (
                <Check
                    size={12}
                    aria-label="Verified"
                    style={{ marginLeft: 4, verticalAlign: "middle" }}
                />
            )}
        </>
    );

    return (
        <Group align="flex-start" gap="sm" wrap="nowrap">
            <SafeAvatar
                src={avatarSrc}
                initials={avatarInitials(message.author_name)}
                shellBorder={shellBorder}
                size={32}
            />

            <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
                <Group gap={8} wrap="wrap" align="center">
                    <Group gap={5} wrap="nowrap" align="center">
                        {authorChannelId ? (
                            <Anchor
                                fw={600}
                                size="sm"
                                title="Open channel on YouTube"
                                style={{ cursor: "pointer", ...nameStyle }}
                                onClick={() => void openAuthorYoutubeChannel(authorChannelId)}
                            >
                                {nameContent}
                            </Anchor>
                        ) : (
                            <Text component="span" fw={600} size="sm" style={nameStyle}>
                                {nameContent}
                            </Text>
                        )}

                        {isVerified && !isOwner && (
                            <Check
                                size={13}
                                aria-label="Verified"
                                style={{ opacity: 0.7, flexShrink: 0 }}
                            />
                        )}
                    </Group>

                    {message.timestamp_text && (
                        <Text size="xs" c="dimmed">
                            {message.timestamp_text}
                        </Text>
                    )}

                    {message.amount_text && (
                        <Badge size="xs" radius="sm" variant="filled" color="green">
                            {message.amount_text}
                        </Badge>
                    )}
                </Group>

                {message.header_primary_text && (
                    <Text fw={700} size="sm">
                        {message.header_primary_text}
                    </Text>
                )}

                {message.header_secondary_text && (
                    <Text size="xs" c="dimmed">
                        {message.header_secondary_text}
                    </Text>
                )}

                <Text
                    size="sm"
                    style={{
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        lineHeight: 1.45,
                    }}
                >
                    {message.message_text}
                </Text>
            </Stack>
        </Group>
    );
}

export function LiveChatPanel({
    liveChatMessages,
    visibleLiveChatMessages,
    isLoadingLiveChat,
    shellBorder,
}: LiveChatPanelProps): JSX.Element {
    const scrollViewportRef = useRef<HTMLDivElement | null>(null);
    const shouldStickToBottomRef = useRef(true);

    useEffect(() => {
        const element = scrollViewportRef.current;

        if (!element) {
            return;
        }

        const threshold = 24;

        const updateStickiness = (): void => {
            const distanceFromBottom =
                element.scrollHeight - element.scrollTop - element.clientHeight;

            shouldStickToBottomRef.current = distanceFromBottom <= threshold;
        };

        updateStickiness();

        element.addEventListener("scroll", updateStickiness);

        return () => {
            element.removeEventListener("scroll", updateStickiness);
        };
    }, []);

    useEffect(() => {
        const element = scrollViewportRef.current;

        if (!element) {
            return;
        }

        if (!shouldStickToBottomRef.current) {
            return;
        }

        element.scrollTop = element.scrollHeight;
    }, [visibleLiveChatMessages]);

    return (
        <Paper
            withBorder
            radius="xl"
            p="lg"
            style={{
                borderColor: shellBorder,
                background:
                    "linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015))",
                minHeight: rem(520),
                maxHeight: rem(760),
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
            }}
        >
            <Stack gap="lg" style={{ minHeight: 0, flex: 1 }}>
                <Group justify="space-between" align="center" wrap="wrap">
                    <Group gap="sm" wrap="nowrap">
                        <Box
                            style={{
                                width: rem(40),
                                height: rem(40),
                                borderRadius: rem(14),
                                display: "grid",
                                placeItems: "center",
                                background: "rgba(239,68,68,0.12)",
                                border: `1px solid ${shellBorder}`,
                                flex: "0 0 auto",
                            }}
                        >
                            <MessageCircle size={18} />
                        </Box>

                        <Box style={{ minWidth: 0, flex: 1 }}>
                            <Text fw={900}>Live chat replay</Text>
                            <Text size="sm" c="dimmed">
                                Synced with playback time
                            </Text>
                        </Box>
                    </Group>

                    <Badge
                        variant="light"
                        color={visibleLiveChatMessages.length > 0 ? "red" : "gray"}
                    >
                        {visibleLiveChatMessages.length} visible
                    </Badge>
                </Group>

                <Divider color={shellBorder} />

                <Box
                    ref={scrollViewportRef}
                    style={{
                        flex: 1,
                        minHeight: 0,
                        overflowY: "auto",
                        paddingRight: rem(4),
                    }}
                >
                    <Stack gap="md">
                        {isLoadingLiveChat && (
                            <Group gap="sm">
                                <Loader size="sm" />
                                <Text size="sm" c="dimmed">
                                    Loading live chat replay...
                                </Text>
                            </Group>
                        )}

                        {!isLoadingLiveChat && liveChatMessages.length === 0 && (
                            <Text size="sm" c="dimmed">
                                No live chat messages were loaded.
                            </Text>
                        )}

                        {!isLoadingLiveChat &&
                            liveChatMessages.length > 0 &&
                            visibleLiveChatMessages.length === 0 && (
                                <Text size="sm" c="dimmed">
                                    No messages visible for the current playback time.
                                </Text>
                            )}

                        {!isLoadingLiveChat &&
                            visibleLiveChatMessages.length > 0 &&
                            visibleLiveChatMessages.map((message, index) => (
                                <LiveChatItem
                                    key={`${message.message_id ?? "chat"}-${message.message_offset_ms}-${index}`}
                                    message={message}
                                    shellBorder={shellBorder}
                                />
                            ))}
                    </Stack>
                </Box>
            </Stack>
        </Paper>
    );
}