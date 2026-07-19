import { type CSSProperties, type ReactNode } from "react";
import { Anchor, Badge, Group, Stack, Text } from "@mantine/core";
import { ThumbsUp } from "lucide-react";
import { UI_TEXT } from "../../constants/ui-text";
import { avatarInitials, resolveAvatarSrc } from "../../utils/avatar";
import { openAuthorYoutubeChannel } from "../../services/author-navigation";
import { activateOnEnterOrSpace } from "../../utils/keyboard";
import { SafeAvatar } from "./safe-avatar";
import { useRemoteImagesEnabled } from "./remote-images-context";
import { formatCommentPublishedAt, type CommentTreeNode } from "./comment-tree";

const COMMENT_TEXT_STYLE: CSSProperties = {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    lineHeight: 1.5,
};

type CommentContentProps = {
    comment: CommentTreeNode;
    shellBorder: string;
    // A reply sits one level down and gets a slightly smaller avatar, matching the browse view.
    compact?: boolean;
    // Rendered in the like-count row. The browse view (`CommentItem`) passes its show/hide-replies
    // toggle here; the search view passes nothing, because there replies are their own flat rows.
    actions?: ReactNode;
};

// The presentational body of a single comment: avatar, author line, text and like count, plus an
// optional trailing action. Deliberately stateless and non-recursive so it can back both the
// recursive browse tree (`CommentItem`) and the flat, virtualized search list
// (`CommentSearchResults`) without either owning the other's layout.
export function CommentContent({
    comment,
    shellBorder,
    compact = false,
    actions,
}: CommentContentProps): JSX.Element {
    const publishedLabel = formatCommentPublishedAt(comment.published_at, comment.time_text);
    const remoteImagesEnabled = useRemoteImagesEnabled();
    const avatarSrc = remoteImagesEnabled
        ? resolveAvatarSrc(comment.author_thumbnail)
        : undefined;
    const authorChannelId = comment.author_channel_id;

    return (
        <Group align="flex-start" gap="sm" wrap="nowrap">
            <SafeAvatar
                src={avatarSrc}
                initials={avatarInitials(comment.author_name)}
                shellBorder={shellBorder}
                size={compact ? 30 : 36}
            />

            <Stack gap={6} style={{ minWidth: 0, flex: 1 }}>
                <Group gap={8} wrap="wrap">
                    {authorChannelId ? (
                        <Anchor
                            fw={800}
                            size="sm"
                            c="blue.4"
                            role="button"
                            tabIndex={0}
                            title="Open channel on YouTube"
                            style={{ cursor: "pointer" }}
                            onClick={() => void openAuthorYoutubeChannel(authorChannelId)}
                            onKeyDown={activateOnEnterOrSpace(() =>
                                void openAuthorYoutubeChannel(authorChannelId)
                            )}
                        >
                            {comment.author_handle?.trim() || comment.author_name}
                        </Anchor>
                    ) : (
                        <Text fw={800} size="sm">
                            {comment.author_handle?.trim() || comment.author_name}
                        </Text>
                    )}

                    {Boolean(comment.is_author_uploader) && (
                        <Badge size="xs" radius="sm" variant="filled" color="dark">
                            {UI_TEXT.comments.creator}
                        </Badge>
                    )}

                    {Boolean(comment.is_pinned) && (
                        <Badge size="xs" radius="sm" variant="light" color="yellow">
                            {UI_TEXT.comments.pinned}
                        </Badge>
                    )}

                    {publishedLabel && (
                        <Text size="xs" c="dimmed">
                            {publishedLabel}
                            {comment.is_edited ? ` • ${UI_TEXT.comments.edited}` : ""}
                        </Text>
                    )}
                </Group>

                <Text size="sm" style={COMMENT_TEXT_STYLE}>
                    {comment.text}
                </Text>

                <Group gap="lg">
                    {comment.like_count > 0 && (
                        <Group gap={6} wrap="nowrap">
                            <ThumbsUp size={14} />
                            <Text size="xs" c="dimmed">
                                {comment.like_count}
                            </Text>
                        </Group>
                    )}

                    {actions}
                </Group>
            </Stack>
        </Group>
    );
}
