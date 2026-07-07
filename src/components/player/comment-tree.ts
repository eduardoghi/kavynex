// Pure comment-thread logic (tree building, sorting, filtering, timestamp parsing) shared by
// the comments panel. Kept free of React so it can be unit-tested in isolation.
import type { MediaCommentRow } from "../../types/media";
import { formatPublishedDate } from "../../utils/media-utils";

export type CommentTreeNode = MediaCommentRow & {
    replies: CommentTreeNode[];
};

export type CommentSortMode = "likes" | "newest" | "oldest";

export function normalizeSearchValue(value: string): string {
    return value.trim().toLocaleLowerCase();
}

export function matchesCommentSearch(comment: MediaCommentRow, query: string): boolean {
    if (!query) {
        return true;
    }

    const haystack = [comment.author_name, comment.author_handle ?? "", comment.text]
        .join(" ")
        .toLocaleLowerCase();

    return haystack.includes(query);
}

export function parseCommentTimestamp(comment: MediaCommentRow): number {
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

export function formatCommentPublishedAt(value: string | null, timeText: string | null): string {
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

export function compareComments(
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

export function buildCommentTree(
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

export function filterCommentTree(nodes: CommentTreeNode[], query: string): CommentTreeNode[] {
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

export function countCommentsInTree(nodes: CommentTreeNode[]): number {
    return nodes.reduce((total, node) => {
        return total + 1 + countCommentsInTree(node.replies);
    }, 0);
}
