import { Group, Text, rem } from "@mantine/core";
import { AuthorName } from "../author-name";
import { ChatCard } from "./chat-card";
import { avatarInitials } from "../../../utils/avatar";
import { SafeAvatar } from "../safe-avatar";
import { RemoteImage } from "../remote-image";
import {
    renderMessageContent,
    type LiveChatVariantProps,
} from "./live-chat-message-content";

// Super Chat / Super Sticker (a paid, colored message card). The sticker image is a remote load,
// so it goes through RemoteImage, which owns the privacy gate. This component takes no
// `remoteImagesEnabled` prop, so it cannot be rendered with the wrong one.
export function SuperChatMessage({
    message,
    shellBorder,
    avatarSrc,
}: LiveChatVariantProps): JSX.Element {
    return (
        <ChatCard
            background={message.superchat_body_color ?? "#1565c0"}
            color={message.superchat_text_color ?? "#ffffff"}
        >
            <Group justify="space-between" gap="xs" wrap="nowrap" align="center">
                <Group gap="xs" wrap="nowrap" align="center" style={{ minWidth: 0 }}>
                    <SafeAvatar
                        src={avatarSrc}
                        initials={avatarInitials(message.author_name)}
                        shellBorder={shellBorder}
                        size={38}
                    />
                    {/* Inside a super chat card the name inherits the card's text color. */}
                    <AuthorName
                        channelId={message.author_channel_id}
                        fw={700}
                        style={{ color: "inherit", minWidth: 0 }}
                    >
                        {message.author_name}
                    </AuthorName>
                    <Text fw={600} size="sm" style={{ color: "inherit", flexShrink: 0 }}>
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

            <RemoteImage
                src={message.sticker_image_url}
                alt="Super Sticker"
                style={{
                    width: rem(72),
                    height: rem(72),
                    marginTop: rem(6),
                    display: "block",
                }}
            />
        </ChatCard>
    );
}
