import { Group, Text } from "@mantine/core";
import { avatarInitials } from "../../../utils/avatar";
import { SafeAvatar } from "../safe-avatar";
import { ChatCard } from "./chat-card";
import { renderMessageContent, type LiveChatVariantProps } from "./live-chat-message-content";

// Membership / member-milestone announcement.
export function MembershipChatMessage({
    message,
    shellBorder,
    avatarSrc,
}: LiveChatVariantProps): JSX.Element {
    return (
        <ChatCard background="rgba(15,157,88,0.14)" border="1px solid rgba(15,157,88,0.4)">
            <Group gap="xs" wrap="nowrap" align="flex-start">
                <SafeAvatar
                    src={avatarSrc}
                    initials={avatarInitials(message.author_name)}
                    shellBorder={shellBorder}
                    size={28}
                />

                <Text size="sm" style={{ minWidth: 0, wordBreak: "break-word" }}>
                    <Text component="span" fw={600} c="var(--kx-color-success-text)">
                        {message.author_name}
                    </Text>{" "}
                    {renderMessageContent(message)}
                    {message.timestamp_text ? (
                        <Text component="span" size="xs" c="dimmed">
                            {"  "}
                            {message.timestamp_text}
                        </Text>
                    ) : null}
                </Text>
            </Group>
        </ChatCard>
    );
}
