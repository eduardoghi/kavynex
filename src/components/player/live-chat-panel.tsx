import { memo, useEffect, useMemo, useRef } from "react";
import { Badge, Box, Divider, Group, Loader, Paper, Stack, Text, rem } from "@mantine/core";
import { MessageCircle } from "lucide-react";
import type { LiveChatMessageItem } from "../../services/live-chat-service";
import { resolveAvatarSrc } from "../../utils/avatar";
import { useRemoteImagesEnabled } from "./remote-images-context";
import { MembershipChatMessage } from "./live-chat-sections/membership-chat-message";
import { PinnedChatMessage } from "./live-chat-sections/pinned-chat-message";
import { RegularChatMessage } from "./live-chat-sections/regular-chat-message";
import { SuperChatMessage } from "./live-chat-sections/super-chat-message";

// Distance (px) from the bottom within which the replay is considered "stuck to bottom" and
// keeps auto-scrolling as new messages arrive; past it, the user has scrolled up to read.
const STICK_TO_BOTTOM_THRESHOLD_PX = 24;

type LiveChatPanelProps = {
    liveChatMessages: LiveChatMessageItem[];
    visibleLiveChatMessages: LiveChatMessageItem[];
    isLoadingLiveChat: boolean;
    // A user-facing message when the replay file could not be read. When set, the panel shows it
    // instead of the "no messages" empty state, so a failed read is not reported as an empty chat.
    error?: string | null;
    shellBorder: string;
};

type LiveChatItemProps = {
    message: LiveChatMessageItem;
    shellBorder: string;
};

// Stable React keys for messages that carry no id of their own (some stickers and gifts).
//
// The visible window is a slice of the parsed array, so a message keeps its object identity as it
// slides through - but its *index* shifts on every advance, and an index-based key makes React tear
// down and rebuild a row that merely moved, throwing away exactly the memoization LiveChatItem
// exists for. Content is not a usable key either: two identical messages from the same author at
// the same offset are indistinguishable, and duplicate keys are their own bug. Identity is the one
// thing here that is both stable and unique, so hang the key off the object itself. The WeakMap
// lets a message be collected with the parsed array it came from.
const fallbackItemKeys = new WeakMap<LiveChatMessageItem, string>();
let nextFallbackItemKey = 0;

export function liveChatItemKey(message: LiveChatMessageItem): string {
    if (message.message_id) {
        return message.message_id;
    }

    const existing = fallbackItemKeys.get(message);

    if (existing !== undefined) {
        return existing;
    }

    const key = `unidentified-${nextFallbackItemKey++}`;
    fallbackItemKeys.set(message, key);

    return key;
}

// Dispatches a live chat message to the component for its kind. Memoized so a sliding visible
// window only renders the newly added rows: existing rows keep the same `message` reference and
// are skipped by the shallow prop comparison.
const LiveChatItem = memo(function LiveChatItem({
    message,
    shellBorder,
}: LiveChatItemProps): JSX.Element {
    const remoteImagesEnabled = useRemoteImagesEnabled();
    const avatarSrc = remoteImagesEnabled
        ? resolveAvatarSrc(message.author_thumbnail)
        : undefined;

    if (message.kind === "pinned") {
        return (
            <PinnedChatMessage message={message} shellBorder={shellBorder} avatarSrc={avatarSrc} />
        );
    }

    if (message.kind === "membership") {
        return (
            <MembershipChatMessage
                message={message}
                shellBorder={shellBorder}
                avatarSrc={avatarSrc}
            />
        );
    }

    if (message.amount_text) {
        return (
            <SuperChatMessage
                message={message}
                shellBorder={shellBorder}
                avatarSrc={avatarSrc}
                remoteImagesEnabled={remoteImagesEnabled}
            />
        );
    }

    return (
        <RegularChatMessage message={message} shellBorder={shellBorder} avatarSrc={avatarSrc} />
    );
});

export function LiveChatPanel({
    liveChatMessages,
    visibleLiveChatMessages,
    isLoadingLiveChat,
    error = null,
    shellBorder,
}: LiveChatPanelProps): JSX.Element {
    const scrollViewportRef = useRef<HTMLDivElement | null>(null);
    const shouldStickToBottomRef = useRef(true);

    useEffect(() => {
        const element = scrollViewportRef.current;

        if (!element) {
            return;
        }

        const threshold = STICK_TO_BOTTOM_THRESHOLD_PX;

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

    // Pinned banners are shown sticky at the top (YouTube-style) instead of inline. The
    // active pin is the most recent one up to the current playback time; it stays until a
    // newer pin replaces it. Both are memoized so they are only recomputed when the visible
    // window actually changes, not on every parent render.
    const inlineMessages = useMemo(
        () => visibleLiveChatMessages.filter((message) => message.kind !== "pinned"),
        [visibleLiveChatMessages]
    );

    const activePin = useMemo(() => {
        let pin: LiveChatMessageItem | null = null;

        for (const message of visibleLiveChatMessages) {
            if (message.kind === "pinned") {
                pin = message;
            }
        }

        return pin;
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

                {activePin && (
                    <Box style={{ flex: "0 0 auto" }}>
                        <LiveChatItem message={activePin} shellBorder={shellBorder} />
                    </Box>
                )}

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
                        <Box role="status" aria-live="polite">
                            {isLoadingLiveChat && (
                                <Group gap="sm">
                                    <Loader size="sm" />
                                    <Text size="sm" c="dimmed">
                                        Loading live chat replay...
                                    </Text>
                                </Group>
                            )}

                            {!isLoadingLiveChat && error && (
                                <Text size="sm" c="red.4">
                                    {error}
                                </Text>
                            )}

                            {!isLoadingLiveChat && !error && liveChatMessages.length === 0 && (
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
                        </Box>

                        {!isLoadingLiveChat &&
                            inlineMessages.length > 0 &&
                            inlineMessages.map((message) => (
                                <LiveChatItem
                                    key={liveChatItemKey(message)}
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
