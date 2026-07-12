import { Anchor, Box, Group, Stack, Text, rem } from "@mantine/core";
import { openAuthorYoutubeChannel } from "../../../services/author-navigation";
import { activateOnEnterOrSpace } from "../../../utils/keyboard";
import { avatarInitials } from "../../../utils/avatar";
import { SafeAvatar } from "../safe-avatar";
import {
    renderMessageContent,
    type LiveChatVariantProps,
} from "./live-chat-message-content";

type SuperChatMessageProps = LiveChatVariantProps & {
    // The super sticker image is only loaded when remote images are allowed.
    remoteImagesEnabled: boolean;
};

// Super Chat / Super Sticker (a paid, colored message card).
export function SuperChatMessage({
    message,
    shellBorder,
    avatarSrc,
    remoteImagesEnabled,
}: SuperChatMessageProps): JSX.Element {
    const authorChannelId = message.author_channel_id;

    // Inside a super chat card the author name inherits the card's text color.
    const superChatAuthor = authorChannelId ? (
        <Anchor
            fw={700}
            size="sm"
            role="button"
            tabIndex={0}
            title="Open channel on YouTube"
            style={{ cursor: "pointer", color: "inherit", minWidth: 0 }}
            onClick={() => void openAuthorYoutubeChannel(authorChannelId)}
            onKeyDown={activateOnEnterOrSpace(() =>
                void openAuthorYoutubeChannel(authorChannelId)
            )}
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
            <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
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

                    {remoteImagesEnabled && message.sticker_image_url && (
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
            </Stack>
        </Group>
    );
}
