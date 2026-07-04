import { useEffect, useRef, useState } from "react";
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

// Inline custom-emoji image, falling back to the emoji shortcut text if it fails to load
// (the image URLs can expire).
function EmojiImage({ url, label }: { url: string; label: string }): JSX.Element {
    const [failed, setFailed] = useState(false);

    if (failed) {
        return <>{label}</>;
    }

    return (
        <img
            src={url}
            alt={label}
            title={label}
            loading="lazy"
            onError={() => setFailed(true)}
            style={{ height: "1.25em", verticalAlign: "-0.25em", margin: "0 1px" }}
        />
    );
}

function renderMessageContent(message: LiveChatMessageItem): JSX.Element | string {
    if (message.message_parts.length === 0) {
        return message.message_text;
    }

    return (
        <>
            {message.message_parts.map((part, index) =>
                part.type === "emoji" ? (
                    <EmojiImage key={index} url={part.url} label={part.label} />
                ) : (
                    <span key={index}>{part.text}</span>
                )
            )}
        </>
    );
}

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

    const isSuperChat = Boolean(message.amount_text);
    const isMembership = message.kind === "membership";

    // Inside a super chat card the author name inherits the card's text color.
    const superChatAuthor = authorChannelId ? (
        <Anchor
            fw={700}
            size="sm"
            title="Open channel on YouTube"
            style={{ cursor: "pointer", color: "inherit", minWidth: 0 }}
            onClick={() => void openAuthorYoutubeChannel(authorChannelId)}
        >
            {message.author_name}
        </Anchor>
    ) : (
        <Text component="span" fw={700} size="sm" style={{ color: "inherit", minWidth: 0 }}>
            {message.author_name}
        </Text>
    );

    return (
        <Group align="flex-start" gap="sm" wrap="nowrap">
            {!isSuperChat && !isMembership && (
                <SafeAvatar
                    src={avatarSrc}
                    initials={avatarInitials(message.author_name)}
                    shellBorder={shellBorder}
                    size={32}
                />
            )}

            <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
                {isMembership ? (
                    <Box
                        style={{
                            background: "rgba(15,157,88,0.14)",
                            border: "1px solid rgba(15,157,88,0.4)",
                            borderRadius: rem(8),
                            padding: rem(8),
                        }}
                    >
                        <Group gap="xs" wrap="nowrap" align="flex-start">
                            <SafeAvatar
                                src={avatarSrc}
                                initials={avatarInitials(message.author_name)}
                                shellBorder={shellBorder}
                                size={28}
                            />

                            <Text size="sm" style={{ minWidth: 0, wordBreak: "break-word" }}>
                                <Text component="span" fw={800} c="teal.4">
                                    {message.author_name}
                                </Text>{" "}
                                {message.message_text}
                                {message.timestamp_text ? (
                                    <Text component="span" size="xs" c="dimmed">
                                        {"  "}
                                        {message.timestamp_text}
                                    </Text>
                                ) : null}
                            </Text>
                        </Group>
                    </Box>
                ) : isSuperChat ? (
                    <Box
                        style={{
                            background: message.superchat_body_color ?? "#1565c0",
                            color: message.superchat_text_color ?? "#ffffff",
                            borderRadius: rem(8),
                            padding: rem(8),
                        }}
                    >
                        <Group justify="space-between" gap="xs" wrap="nowrap" align="center">
                            <Group gap="xs" wrap="nowrap" align="center" style={{ minWidth: 0 }}>
                                <SafeAvatar
                                    src={avatarSrc}
                                    initials={avatarInitials(message.author_name)}
                                    shellBorder={shellBorder}
                                    size={38}
                                />
                                {superChatAuthor}
                                <Text fw={800} size="sm" style={{ color: "inherit", flexShrink: 0 }}>
                                    {message.amount_text}
                                </Text>
                            </Group>

                            {message.timestamp_text && (
                                <Text
                                    size="xs"
                                    style={{ color: "inherit", opacity: 0.7, flexShrink: 0 }}
                                >
                                    {message.timestamp_text}
                                </Text>
                            )}
                        </Group>

                        {message.message_text && (
                            <Text
                                size="sm"
                                mt={6}
                                style={{
                                    color: "inherit",
                                    whiteSpace: "pre-wrap",
                                    wordBreak: "break-word",
                                    lineHeight: 1.45,
                                }}
                            >
                                {renderMessageContent(message)}
                            </Text>
                        )}

                        {message.sticker_image_url && (
                            <img
                                src={message.sticker_image_url}
                                alt="Super Sticker"
                                loading="lazy"
                                style={{
                                    width: rem(72),
                                    height: rem(72),
                                    marginTop: rem(6),
                                    display: "block",
                                }}
                            />
                        )}
                    </Box>
                ) : (
                    <>
                        <Group gap={8} wrap="wrap" align="center">
                            <Group gap={5} wrap="nowrap" align="center">
                                {authorChannelId ? (
                                    <Anchor
                                        fw={600}
                                        size="sm"
                                        title="Open channel on YouTube"
                                        style={{ cursor: "pointer", ...nameStyle }}
                                        onClick={() =>
                                            void openAuthorYoutubeChannel(authorChannelId)
                                        }
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
                        </Group>

                        <Text
                            size="sm"
                            style={{
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                lineHeight: 1.45,
                            }}
                        >
                            {renderMessageContent(message)}
                        </Text>
                    </>
                )}
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