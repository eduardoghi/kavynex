import { memo, useEffect, useMemo, useRef } from "react";
import {
    Badge,
    Box,
    Divider,
    Group,
    Paper,
    Stack,
    Text,
    VisuallyHidden,
    rem,
} from "@mantine/core";
import { MessageCircle } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AsyncStatusRegion } from "../common/async-status-region";
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

// A rough first guess at a chat row's height; real heights are measured after mount
// (measureElement), so this only shapes the first paint's scrollbar estimate, never final layout.
const ESTIMATED_MESSAGE_HEIGHT = 72;

// Vertical gap between rows, applied as each row's own trailing padding (the virtualized rows are
// absolutely positioned, so a Stack `gap` cannot space them).
const MESSAGE_GAP_PX = 16;

type LiveChatPanelProps = {
    liveChatMessages: LiveChatMessageItem[];
    visibleLiveChatMessages: LiveChatMessageItem[];
    // The pinned banner in effect at the current playback time, derived by the parent from the full
    // message list (not the capped visible window, which a long-standing pin scrolls out of).
    activePin: LiveChatMessageItem | null;
    isLoadingLiveChat: boolean;
    // A user-facing message when the replay file could not be read. When set, the panel shows it
    // instead of the "no messages" empty state, so a failed read is not reported as an empty chat.
    error?: string | null;
    // Whether newly revealed messages should be announced by the screen-reader live region. True
    // during ordinary playback (each message scrolls in, one at a time); the parent sets it false
    // around a seek, where the whole visible window is replaced at once and announcing the jump
    // would flood the speech queue with activity that is not live.
    announceAdditions?: boolean;
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
// lets a message be collected with the parsed array it came from. Used both as the virtualizer's
// per-item key (so a row keeps its DOM node as the window slides it to a new index) and as the
// live-region key below.
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

// A concise text form of a message for the screen-reader live region below, which announces a newly
// revealed message without mounting its visual row. The visual list is virtualized, so most rows
// are not in the DOM and an aria-live region over them would (a) miss messages that arrive outside
// the rendered window and (b) re-announce rows as the virtualizer recycles their nodes on scroll.
// Announcing a single derived string sidesteps both. Mirrors what a sighted viewer reads: the
// author, the paid amount when present, and the message text.
export function liveChatAnnouncement(message: LiveChatMessageItem): string {
    const detail = [message.amount_text, message.message_text]
        .filter((part): part is string => Boolean(part && part.trim()))
        .join(" ");

    return detail ? `${message.author_name}: ${detail}` : message.author_name;
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

    // Dispatch on the kind the parser assigned, not on amount_text being present. A super sticker
    // whose purchase amount could not be parsed still has no message_text (stickers never carry
    // one) and its image lives in sticker_image_url, which only SuperChatMessage renders - so
    // routing it by amount alone dropped it into RegularChatMessage as a near-empty row, image and
    // all. The amount is what the badge shows; it is not what the message is.
    if (message.kind === "superchat" || message.kind === "sticker") {
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
    activePin,
    isLoadingLiveChat,
    error = null,
    announceAdditions = true,
    shellBorder,
}: LiveChatPanelProps): JSX.Element {
    const scrollViewportRef = useRef<HTMLDivElement | null>(null);
    const shouldStickToBottomRef = useRef(true);

    // Pinned banners are shown sticky at the top (YouTube-style) instead of inline. The active pin
    // (`activePin`) is derived by the parent from the full message list so a long-standing pin does
    // not disappear when it scrolls out of the capped visible window; here we only strip pinned
    // messages out of the inline list so a pin never renders twice. Memoized so it is recomputed
    // only when the visible window actually changes, not on every parent render.
    const inlineMessages = useMemo(
        () => visibleLiveChatMessages.filter((message) => message.kind !== "pinned"),
        [visibleLiveChatMessages]
    );

    // Only show the virtualized list when there is something to show; loading/error/empty states go
    // through AsyncStatusRegion instead. Keeping them mutually exclusive means the list's sizer is
    // the first (and only) child of the scroll viewport, so the virtualizer's offsets are not thrown
    // off by a status node rendered above it.
    const showMessageList = !isLoadingLiveChat && !error && inlineMessages.length > 0;

    // Virtualize the inline list so a dense replay does not mount every visible-window row (up to a
    // couple hundred, each with an avatar/badges/images) as live DOM. Same shape the comment search
    // and media grid use. A stable per-item key (liveChatItemKey) keeps a row's DOM node as the
    // sliding window moves it to a new index, preserving LiveChatItem's memoization.
    const virtualizer = useVirtualizer({
        count: inlineMessages.length,
        getScrollElement: () => scrollViewportRef.current,
        estimateSize: () => ESTIMATED_MESSAGE_HEIGHT,
        overscan: 8,
        getItemKey: (index) => {
            const message = inlineMessages[index];

            return message ? liveChatItemKey(message) : index;
        },
    });

    const virtualRows = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();

    // Force an initial measurement pass once the list is shown. The virtualizer computes its first
    // visible range from the scroll element's measured size; when that size does not change from its
    // 0x0 starting rect (a container that has not laid out yet, which is also every environment
    // without a layout engine), it would otherwise never leave the empty initial range. The media
    // grid does the same for the same reason.
    useEffect(() => {
        if (showMessageList) {
            virtualizer.measure();
        }
    }, [virtualizer, showMessageList]);

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

    // Stick to the bottom as new messages arrive (unless the user has scrolled up). Depends on
    // `totalSize` as well as the messages so the scroll is re-applied after the virtualizer measures
    // real row heights and the total grows - without that second pass, sticking to the estimated
    // bottom would drift up as rows settle. Assigning scrollTop (rather than the virtualizer's own
    // scrollTo) keeps this working under jsdom in tests.
    useEffect(() => {
        const element = scrollViewportRef.current;

        if (!element) {
            return;
        }

        if (!shouldStickToBottomRef.current) {
            return;
        }

        element.scrollTop = element.scrollHeight;
    }, [visibleLiveChatMessages, totalSize]);

    const latestInlineMessage =
        inlineMessages.length > 0 ? inlineMessages[inlineMessages.length - 1] : null;

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
            {/* The screen-reader live region. Decoupled from the virtualized visual list (which
                cannot host a reliable aria-live region - see liveChatAnnouncement) and always
                mounted so assistive tech has it before the first addition. It announces only the
                newest revealed message; keying that message by identity swaps the node when it
                changes, which is the "addition" aria-relevant reports. Silenced (aria-live off)
                during a seek, when the whole window is replaced at once. */}
            <VisuallyHidden>
                <div
                    role="log"
                    aria-live={announceAdditions ? "polite" : "off"}
                    aria-relevant="additions"
                    aria-label="Live chat messages"
                >
                    {latestInlineMessage && (
                        <span key={liveChatItemKey(latestInlineMessage)}>
                            {liveChatAnnouncement(latestInlineMessage)}
                        </span>
                    )}
                </div>
            </VisuallyHidden>

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
                    {showMessageList ? (
                        <Box
                            style={{
                                height: `${totalSize}px`,
                                width: "100%",
                                position: "relative",
                            }}
                        >
                            {virtualRows.map((virtualRow) => {
                                const message = inlineMessages[virtualRow.index];

                                // The virtualizer only yields in-range indices, so this is never
                                // null in practice; the guard satisfies the checked-index type.
                                if (!message) {
                                    return null;
                                }

                                return (
                                    <Box
                                        key={virtualRow.key}
                                        ref={virtualizer.measureElement}
                                        data-index={virtualRow.index}
                                        style={{
                                            position: "absolute",
                                            top: 0,
                                            left: 0,
                                            width: "100%",
                                            transform: `translateY(${virtualRow.start}px)`,
                                            paddingBottom: rem(MESSAGE_GAP_PX),
                                        }}
                                    >
                                        <LiveChatItem
                                            message={message}
                                            shellBorder={shellBorder}
                                        />
                                    </Box>
                                );
                            })}
                        </Box>
                    ) : (
                        <Stack gap="md">
                            <AsyncStatusRegion
                                loading={isLoadingLiveChat}
                                loadingMessage="Loading live chat replay..."
                                error={error}
                            >
                                {!isLoadingLiveChat &&
                                    !error &&
                                    liveChatMessages.length === 0 && (
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
                            </AsyncStatusRegion>
                        </Stack>
                    )}
                </Box>
            </Stack>
        </Paper>
    );
}
