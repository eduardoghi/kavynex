import { memo, useState, type CSSProperties } from "react";
import { Anchor, Badge, Button, Group, Stack, Text, rem } from "@mantine/core";
import { ChevronDown, ChevronUp, ThumbsUp } from "lucide-react";
import { UI_TEXT } from "../../constants/ui-text";
import { avatarInitials, resolveAvatarSrc } from "../../utils/avatar";
import { openAuthorYoutubeChannel } from "../../services/author-navigation";
import { activateOnEnterOrSpace } from "../../utils/keyboard";
import { SafeAvatar } from "./safe-avatar";
import { useRemoteImagesEnabled } from "./remote-images-context";
import { formatCommentPublishedAt, type CommentTreeNode } from "./comment-tree";

// A single comment can have hundreds of replies; cap how many are mounted at once, mirroring the
// top-level thread cap in comments-panel, so expanding one thread does not build an unbounded DOM.
// More replies are revealed on demand.
const INITIAL_VISIBLE_REPLIES = 10;
const REPLIES_LOAD_MORE_STEP = 10;

// Style objects that never depend on a comment's props or state, hoisted to module scope so they
// are allocated once instead of rebuilt on every render. CommentItem is memoized and rendered
// recursively across a whole thread, so avoiding the per-node allocation compounds. The styles
// that read runtime values (the reply border keyed on shellBorder, the indent keyed on level)
// stay inline.
const COMMENT_TEXT_STYLE: CSSProperties = {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    lineHeight: 1.5,
};

const REPLY_TOGGLE_BUTTON_STYLES = {
    root: {
        color: "var(--mantine-color-blue-4)",
        fontWeight: 700,
    },
    section: {
        marginRight: rem(4),
    },
} satisfies Record<string, CSSProperties>;

const LOAD_MORE_REPLIES_BUTTON_STYLES = {
    root: {
        color: "var(--mantine-color-blue-4)",
        fontWeight: 700,
        alignSelf: "flex-start",
    },
} satisfies Record<string, CSSProperties>;

type CommentItemProps = {
    comment: CommentTreeNode;
    shellBorder: string;
    level?: number;
    forceExpandReplies?: boolean;
};

// Memoized so toggling sort/search in CommentsPanel does not re-render every mounted comment
// subtree - without this, a state change in the parent re-diffs every CommentItem (and its
// nested replies) even though most of their props are unchanged. Named as a separate function
// (rather than a named function expression inside memo()) so the recursive self-reference below
// resolves to this memoized binding instead of shadowing it with the raw, unmemoized function.
function CommentItemComponent({
    comment,
    shellBorder,
    level = 0,
    forceExpandReplies = false,
}: CommentItemProps): JSX.Element {
    const [expandedReplies, setExpandedReplies] = useState(level === 0);
    const [visibleReplyCount, setVisibleReplyCount] = useState(INITIAL_VISIBLE_REPLIES);
    const hasReplies = comment.replies.length > 0;
    const publishedLabel = formatCommentPublishedAt(comment.published_at, comment.time_text);
    const replyCount = Math.max(comment.reply_count || comment.replies.length, comment.replies.length);
    const replyCountLabel =
        replyCount === 1
            ? `1 ${UI_TEXT.comments.reply}`
            : `${replyCount} ${UI_TEXT.comments.replies}`;
    const remoteImagesEnabled = useRemoteImagesEnabled();
    const avatarSrc = remoteImagesEnabled
        ? resolveAvatarSrc(comment.author_thumbnail)
        : undefined;
    const authorChannelId = comment.author_channel_id;
    const repliesVisible = forceExpandReplies || expandedReplies;

    return (
        <Stack gap={rem(10)} style={{ marginLeft: level > 0 ? rem(24) : 0 }}>
            <Group align="flex-start" gap="sm" wrap="nowrap">
                <SafeAvatar
                    src={avatarSrc}
                    initials={avatarInitials(comment.author_name)}
                    shellBorder={shellBorder}
                    size={level > 0 ? 30 : 36}
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

                        {hasReplies && (
                            <Button
                                variant="subtle"
                                size="compact-sm"
                                px={0}
                                leftSection={
                                    repliesVisible ? (
                                        <ChevronUp size={14} />
                                    ) : (
                                        <ChevronDown size={14} />
                                    )
                                }
                                onClick={() => setExpandedReplies((current) => !current)}
                                styles={REPLY_TOGGLE_BUTTON_STYLES}
                            >
                                {repliesVisible ? UI_TEXT.comments.hideReplies : replyCountLabel}
                            </Button>
                        )}
                    </Group>
                </Stack>
            </Group>

            {hasReplies && repliesVisible && (
                <Stack
                    gap="md"
                    style={{
                        borderLeft: `1px solid ${shellBorder}`,
                        marginLeft: rem(18),
                        paddingLeft: rem(14),
                    }}
                >
                    {(forceExpandReplies
                        ? comment.replies
                        : comment.replies.slice(0, visibleReplyCount)
                    ).map((reply) => (
                        <CommentItem
                            key={`${reply.id}-${reply.comment_id ?? "reply"}`}
                            comment={reply}
                            shellBorder={shellBorder}
                            level={level + 1}
                            forceExpandReplies={forceExpandReplies}
                        />
                    ))}

                    {!forceExpandReplies && comment.replies.length > visibleReplyCount && (
                        <Button
                            variant="subtle"
                            size="compact-sm"
                            px={0}
                            onClick={() =>
                                setVisibleReplyCount(
                                    (current) => current + REPLIES_LOAD_MORE_STEP
                                )
                            }
                            styles={LOAD_MORE_REPLIES_BUTTON_STYLES}
                        >
                            {UI_TEXT.comments.loadMore} (
                            {comment.replies.length - visibleReplyCount})
                        </Button>
                    )}
                </Stack>
            )}
        </Stack>
    );
}

export const CommentItem = memo(CommentItemComponent);
