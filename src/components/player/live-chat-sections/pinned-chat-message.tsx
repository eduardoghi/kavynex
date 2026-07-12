import { Box, Group, Stack, Text, rem } from "@mantine/core";
import { Pin } from "lucide-react";
import { avatarInitials } from "../../../utils/avatar";
import { SafeAvatar } from "../safe-avatar";
import {
    renderMessageContent,
    type LiveChatVariantProps,
} from "./live-chat-message-content";

// Pinned banner (shown sticky at the top of the panel, YouTube-style).
export function PinnedChatMessage({
    message,
    shellBorder,
    avatarSrc,
}: LiveChatVariantProps): JSX.Element {
    return (
        <Group align="flex-start" gap="sm" wrap="nowrap">
            <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
                <Box
                    style={{
                        background: "rgba(255,255,255,0.04)",
                        border: `1px solid ${shellBorder}`,
                        borderRadius: rem(8),
                        padding: rem(8),
                    }}
                >
                    <Group gap={6} wrap="nowrap" align="center" mb={4}>
                        <Pin size={13} style={{ opacity: 0.7, flexShrink: 0 }} />
                        <Text size="xs" c="dimmed">
                            {message.pinned_header}
                        </Text>
                    </Group>

                    <Group gap="xs" wrap="nowrap" align="flex-start">
                        <SafeAvatar
                            src={avatarSrc}
                            initials={avatarInitials(message.author_name)}
                            shellBorder={shellBorder}
                            size={28}
                        />

                        <Text size="sm" style={{ minWidth: 0, wordBreak: "break-word" }}>
                            <Text component="span" fw={700}>
                                {message.author_name}
                            </Text>{" "}
                            {renderMessageContent(message)}
                        </Text>
                    </Group>
                </Box>
            </Stack>
        </Group>
    );
}
