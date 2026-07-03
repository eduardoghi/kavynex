import { useEffect, useMemo, useState } from "react";
import {
    ActionIcon,
    Anchor,
    Badge,
    Box,
    Button,
    Divider,
    Group,
    Loader,
    Paper,
    Select,
    Stack,
    Text,
    TextInput,
    rem,
} from "@mantine/core";
import { ChevronDown, ChevronUp, MessageCircle, Search, ThumbsUp, X } from "lucide-react";
import { UI_TEXT } from "../../constants/ui-text";
import type { MediaCommentRow } from "../../types/media";
import { formatPublishedDate } from "../../utils/media-utils";
import { avatarInitials, resolveAvatarSrc } from "../../utils/avatar";
import { openAuthorYoutubeChannel } from "../../services/author-navigation";
import { SafeAvatar } from "./safe-avatar";

type CommentTreeNode = MediaCommentRow & {
    replies: CommentTreeNode[];
};

type CommentSortMode = "likes" | "newest" | "oldest";

// Cap how many top-level comment threads are mounted at once so media with thousands of
// comments does not build an unbounded DOM. More threads are revealed on demand.
const INITIAL_VISIBLE_THREADS = 30;
const LOAD_MORE_STEP = 30;

type CommentsPanelProps = {
    comments: MediaCommentRow[];
    hasComments: boolean;
    commentsCount?: number | null;
    isLoadingComments: boolean;
    shellBorder: string;
};

function normalizeSearchValue(value: string): string {
    return value.trim().toLocaleLowerCase();
}

function matchesCommentSearch(comment: MediaCommentRow, query: string): boolean {
    if (!query) {
        return true;
    }

    const haystack = [comment.author_name, comment.author_handle ?? "", comment.text]
        .join(" ")
        .toLocaleLowerCase();

    return haystack.includes(query);
}

function parseCommentTimestamp(comment: MediaCommentRow): number {
    const publishedAt = comment.published_at?.trim() ?? "";

    if (/^\d+$/.test(publishedAt)) {
        const unixSeconds = Number(publishedAt);

        if (Number.isFinite(unixSeconds) && unixSeconds > 0) {
            return unixSeconds * 1000;
        }
    }

    if (publishedAt) {
        const parsed = Date.parse(publishedAt);

        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return 0;
}

function formatCommentPublishedAt(value: string | null, timeText: string | null): string {
    const normalizedTimeText = timeText?.trim() ?? "";

    if (normalizedTimeText) {
        return normalizedTimeText;
    }

    const normalized = value?.trim() ?? "";

    if (!normalized) {
        return "";
    }

    if (/^\d+$/.test(normalized)) {
        const unixSeconds = Number(normalized);

        if (Number.isFinite(unixSeconds) && unixSeconds > 0) {
            const formatted = formatPublishedDate(new Date(unixSeconds * 1000).toISOString());
            return formatted || new Date(unixSeconds * 1000).toLocaleDateString();
        }
    }

    const formatted = formatPublishedDate(normalized);
    return formatted || normalized;
}

function compareComments(
    left: MediaCommentRow,
    right: MediaCommentRow,
    sortMode: CommentSortMode
): number {
    if (sortMode === "likes") {
        if (right.like_count !== left.like_count) {
            return right.like_count - left.like_count;
        }

        return left.id - right.id;
    }

    const leftTime = parseCommentTimestamp(left);
    const rightTime = parseCommentTimestamp(right);

    if (sortMode === "newest") {
        if (rightTime !== leftTime) {
            return rightTime - leftTime;
        }

        return left.id - right.id;
    }

    if (leftTime !== rightTime) {
        return leftTime - rightTime;
    }

    return left.id - right.id;
}

function buildCommentTree(
    comments: MediaCommentRow[],
    sortMode: CommentSortMode
): CommentTreeNode[] {
    const nodes = comments.map((comment) => ({
        ...comment,
        replies: [],
    }));

    const byCommentId = new Map<string, CommentTreeNode>();
    const roots: CommentTreeNode[] = [];

    for (const node of nodes) {
        const commentId = node.comment_id?.trim() ?? "";

        if (commentId) {
            byCommentId.set(commentId, node);
        }
    }

    for (const node of nodes) {
        const parentId = node.parent_comment_id?.trim() ?? "";

        if (!parentId || parentId.toLowerCase() === "root") {
            roots.push(node);
            continue;
        }

        const parentNode = byCommentId.get(parentId);

        if (!parentNode) {
            roots.push(node);
            continue;
        }

        parentNode.replies.push(node);
    }

    const sortNodes = (items: CommentTreeNode[]): void => {
        items.sort((left, right) => compareComments(left, right, sortMode));

        for (const item of items) {
            sortNodes(item.replies);
        }
    };

    sortNodes(roots);

    return roots;
}

function filterCommentTree(nodes: CommentTreeNode[], query: string): CommentTreeNode[] {
    if (!query) {
        return nodes;
    }

    const nextNodes: CommentTreeNode[] = [];

    for (const node of nodes) {
        const filteredReplies = filterCommentTree(node.replies, query);
        const matchesSelf = matchesCommentSearch(node, query);

        if (matchesSelf || filteredReplies.length > 0) {
            nextNodes.push({
                ...node,
                replies: filteredReplies,
            });
        }
    }

    return nextNodes;
}

function countCommentsInTree(nodes: CommentTreeNode[]): number {
    return nodes.reduce((total, node) => {
        return total + 1 + countCommentsInTree(node.replies);
    }, 0);
}

type CommentItemProps = {
    comment: CommentTreeNode;
    shellBorder: string;
    level?: number;
    forceExpandReplies?: boolean;
};

function CommentItem({
    comment,
    shellBorder,
    level = 0,
    forceExpandReplies = false,
}: CommentItemProps): JSX.Element {
    const [expandedReplies, setExpandedReplies] = useState(level === 0);
    const hasReplies = comment.replies.length > 0;
    const publishedLabel = formatCommentPublishedAt(comment.published_at, comment.time_text);
    const replyCount = Math.max(comment.reply_count || comment.replies.length, comment.replies.length);
    const replyCountLabel =
        replyCount === 1
            ? `1 ${UI_TEXT.comments.reply}`
            : `${replyCount} ${UI_TEXT.comments.replies}`;
    const avatarSrc = resolveAvatarSrc(comment.author_thumbnail);
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
                                title="Open channel on YouTube"
                                style={{ cursor: "pointer" }}
                                onClick={() => void openAuthorYoutubeChannel(authorChannelId)}
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

                    <Text
                        size="sm"
                        style={{
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            lineHeight: 1.5,
                        }}
                    >
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
                                styles={{
                                    root: {
                                        color: "var(--mantine-color-blue-4)",
                                        fontWeight: 700,
                                    },
                                    section: {
                                        marginRight: rem(4),
                                    },
                                }}
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
                    {comment.replies.map((reply) => (
                        <CommentItem
                            key={`${reply.id}-${reply.comment_id ?? "reply"}`}
                            comment={reply}
                            shellBorder={shellBorder}
                            level={level + 1}
                            forceExpandReplies={forceExpandReplies}
                        />
                    ))}
                </Stack>
            )}
        </Stack>
    );
}

export function CommentsPanel({
    comments,
    hasComments,
    commentsCount,
    isLoadingComments,
    shellBorder,
}: CommentsPanelProps): JSX.Element {
    const [commentSortMode, setCommentSortMode] = useState<CommentSortMode>("likes");
    const [commentSearchValue, setCommentSearchValue] = useState("");

    const commentTree = useMemo(
        () => buildCommentTree(comments, commentSortMode),
        [commentSortMode, comments]
    );

    const normalizedCommentSearch = useMemo(
        () => normalizeSearchValue(commentSearchValue),
        [commentSearchValue]
    );

    const filteredCommentTree = useMemo(
        () => filterCommentTree(commentTree, normalizedCommentSearch),
        [commentTree, normalizedCommentSearch]
    );

    const filteredCommentsCount = useMemo(
        () => countCommentsInTree(filteredCommentTree),
        [filteredCommentTree]
    );

    const [visibleThreadCount, setVisibleThreadCount] = useState(INITIAL_VISIBLE_THREADS);

    // Reset the visible window whenever the result set changes (new media, sort, search).
    useEffect(() => {
        setVisibleThreadCount(INITIAL_VISIBLE_THREADS);
    }, [comments, commentSortMode, normalizedCommentSearch]);

    const visibleCommentTree = useMemo(
        () => filteredCommentTree.slice(0, visibleThreadCount),
        [filteredCommentTree, visibleThreadCount]
    );

    const remainingThreadCount = filteredCommentTree.length - visibleCommentTree.length;

    return (
        <Paper
            withBorder
            radius="xl"
            p="lg"
            style={{
                borderColor: shellBorder,
                background:
                    "linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015))",
            }}
        >
            <Stack gap="lg">
                <Group justify="space-between" align="center" wrap="wrap">
                    <Group gap="sm" wrap="nowrap">
                        <Box
                            style={{
                                width: rem(40),
                                height: rem(40),
                                borderRadius: rem(14),
                                display: "grid",
                                placeItems: "center",
                                background: "rgba(139,92,246,0.12)",
                                border: `1px solid ${shellBorder}`,
                                flex: "0 0 auto",
                            }}
                        >
                            <MessageCircle size={18} />
                        </Box>

                        <Box style={{ minWidth: 0, flex: 1 }}>
                            <Text fw={900}>{UI_TEXT.comments.title}</Text>
                            <Text size="sm" c="dimmed">
                                {hasComments
                                    ? `${commentsCount ?? comments.length} ${UI_TEXT.comments.savedWithMedia}`
                                    : UI_TEXT.comments.none}
                            </Text>
                        </Box>
                    </Group>

                    {hasComments && comments.length > 0 && (
                        <Select
                            label={UI_TEXT.comments.sortLabel}
                            value={commentSortMode}
                            onChange={(value) =>
                                setCommentSortMode((value as CommentSortMode) || "likes")
                            }
                            data={[
                                { value: "likes", label: UI_TEXT.comments.sortOptions.likes },
                                { value: "newest", label: UI_TEXT.comments.sortOptions.newest },
                                { value: "oldest", label: UI_TEXT.comments.sortOptions.oldest },
                            ]}
                            w={220}
                        />
                    )}
                </Group>

                {hasComments && comments.length > 0 && (
                    <Stack gap="xs">
                        <TextInput
                            label={UI_TEXT.comments.searchLabel}
                            placeholder={UI_TEXT.comments.searchPlaceholder}
                            value={commentSearchValue}
                            onChange={(event) => setCommentSearchValue(event.currentTarget.value)}
                            leftSection={<Search size={16} />}
                            rightSection={
                                commentSearchValue.trim() ? (
                                    <ActionIcon
                                        variant="subtle"
                                        aria-label="Clear comment search"
                                        onClick={() => setCommentSearchValue("")}
                                    >
                                        <X size={16} />
                                    </ActionIcon>
                                ) : undefined
                            }
                        />

                        {normalizedCommentSearch && (
                            <Text size="sm" c="dimmed">
                                {UI_TEXT.comments.resultsShowing} {filteredCommentsCount}{" "}
                                {UI_TEXT.comments.resultsFor} “{commentSearchValue.trim()}”
                            </Text>
                        )}
                    </Stack>
                )}

                <Divider color={shellBorder} />

                {isLoadingComments && (
                    <Group gap="sm">
                        <Loader size="sm" />
                        <Text size="sm" c="dimmed">
                            {UI_TEXT.comments.loading}
                        </Text>
                    </Group>
                )}

                {!isLoadingComments && !hasComments && (
                    <Text size="sm" c="dimmed">
                        {UI_TEXT.comments.noCommentsAvailable}
                    </Text>
                )}

                {!isLoadingComments && hasComments && comments.length === 0 && (
                    <Text size="sm" c="dimmed">
                        {UI_TEXT.comments.missingFromDatabase}
                    </Text>
                )}

                {!isLoadingComments && comments.length > 0 && filteredCommentTree.length === 0 && (
                    <Text size="sm" c="dimmed">
                        {UI_TEXT.comments.noSearchResults}
                    </Text>
                )}

                {!isLoadingComments && filteredCommentTree.length > 0 && (
                    <Stack gap="lg">
                        {visibleCommentTree.map((comment) => (
                            <CommentItem
                                key={`${comment.id}-${comment.comment_id ?? "comment"}`}
                                comment={comment}
                                shellBorder={shellBorder}
                                forceExpandReplies={Boolean(normalizedCommentSearch)}
                            />
                        ))}

                        {remainingThreadCount > 0 && (
                            <Button
                                variant="light"
                                color="gray"
                                onClick={() =>
                                    setVisibleThreadCount((current) => current + LOAD_MORE_STEP)
                                }
                            >
                                {UI_TEXT.comments.loadMore} ({remainingThreadCount})
                            </Button>
                        )}
                    </Stack>
                )}
            </Stack>
        </Paper>
    );
}