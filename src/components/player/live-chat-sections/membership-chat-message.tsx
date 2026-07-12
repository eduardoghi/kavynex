import { Box, Group, Stack, Text, rem } from "@mantine/core";
import { avatarInitials } from "../../../utils/avatar";
import { SafeAvatar } from "../safe-avatar";
import type { LiveChatVariantProps } from "./live-chat-message-content";

// Membership / member-milestone announcement.
export function MembershipChatMessage({
    message,
    shellBorder,
    avatarSrc,
}: LiveChatVariantProps): JSX.Element {
    return (
        <Group align="flex-start" gap="sm" wrap="nowrap">
            <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
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
            </Stack>
        </Group>
    );
}
