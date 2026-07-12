import { Anchor, Group, Stack, Text } from "@mantine/core";
import { Check, Wrench } from "lucide-react";
import { openAuthorYoutubeChannel } from "../../../services/author-navigation";
import { activateOnEnterOrSpace } from "../../../utils/keyboard";
import { avatarInitials } from "../../../utils/avatar";
import { SafeAvatar } from "../safe-avatar";
import {
    renderMessageContent,
    type LiveChatVariantProps,
} from "./live-chat-message-content";

// YouTube colors the whole author name by role instead of using separate badge chips.
const OWNER_HIGHLIGHT_COLOR = "#ffd600";
const MODERATOR_NAME_COLOR = "#5e84f1";
const MEMBER_NAME_COLOR = "#2ba640";

export function RegularChatMessage({
    message,
    shellBorder,
    avatarSrc,
}: LiveChatVariantProps): JSX.Element {
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
                                role="button"
                                tabIndex={0}
                                title="Open channel on YouTube"
                                style={{ cursor: "pointer", ...nameStyle }}
                                onClick={() => void openAuthorYoutubeChannel(authorChannelId)}
                                onKeyDown={activateOnEnterOrSpace(() =>
                                    void openAuthorYoutubeChannel(authorChannelId)
                                )}
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
            </Stack>
        </Group>
    );
}
