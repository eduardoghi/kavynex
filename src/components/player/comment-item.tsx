import { memo, useState, type CSSProperties } from "react";
import { Button, Stack, rem } from "@mantine/core";
import { ChevronDown, ChevronUp } from "lucide-react";
import { UI_TEXT } from "../../constants/ui-text";
import { CommentContent } from "./comment-content";
import { type CommentTreeNode } from "./comment-tree";

// A single comment can have hundreds of replies; cap how many are mounted at once, mirroring the
// top-level thread cap in comments-panel, so expanding one thread does not build an unbounded DOM.
// More replies are revealed on demand. This is the browse view; the search view renders a flat,
// virtualized list instead (see CommentSearchResults), so it has no equivalent cap.
const INITIAL_VISIBLE_REPLIES = 10;
const REPLIES_LOAD_MORE_STEP = 10;

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
};

// Memoized so toggling sort in CommentsPanel does not re-render every mounted comment subtree -
// without this, a state change in the parent re-diffs every CommentItem (and its nested replies)
// even though most of their props are unchanged. Named as a separate function (rather than a named
// function expression inside memo()) so the recursive self-reference below resolves to this
// memoized binding instead of shadowing it with the raw, unmemoized function.
function CommentItemComponent({
    comment,
    shellBorder,
    level = 0,
}: CommentItemProps): JSX.Element {
    const [expandedReplies, setExpandedReplies] = useState(level === 0);
    const [visibleReplyCount, setVisibleReplyCount] = useState(INITIAL_VISIBLE_REPLIES);
    const hasReplies = comment.replies.length > 0;
    const replyCount = Math.max(comment.reply_count || comment.replies.length, comment.replies.length);
    const replyCountLabel =
        replyCount === 1
            ? `1 ${UI_TEXT.comments.reply}`
            : `${replyCount} ${UI_TEXT.comments.replies}`;

    const replyToggle = hasReplies ? (
        <Button
            variant="subtle"
            size="compact-sm"
            px={0}
            leftSection={
                expandedReplies ? <ChevronUp size={14} /> : <ChevronDown size={14} />
            }
            onClick={() => setExpandedReplies((current) => !current)}
            styles={REPLY_TOGGLE_BUTTON_STYLES}
        >
            {expandedReplies ? UI_TEXT.comments.hideReplies : replyCountLabel}
        </Button>
    ) : null;

    return (
        <Stack gap={rem(10)} style={{ marginLeft: level > 0 ? rem(24) : 0 }}>
            <CommentContent
                comment={comment}
                shellBorder={shellBorder}
                compact={level > 0}
                actions={replyToggle}
            />

            {hasReplies && expandedReplies && (
                <Stack
                    gap="md"
                    style={{
                        borderLeft: `1px solid ${shellBorder}`,
                        marginLeft: rem(18),
                        paddingLeft: rem(14),
                    }}
                >
                    {comment.replies.slice(0, visibleReplyCount).map((reply) => (
                        <CommentItem
                            key={`${reply.id}-${reply.comment_id ?? "reply"}`}
                            comment={reply}
                            shellBorder={shellBorder}
                            level={level + 1}
                        />
                    ))}

                    {comment.replies.length > visibleReplyCount && (
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
