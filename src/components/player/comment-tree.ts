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

/// Whether following `node`'s parents ends at a root rather than looping back on itself.
///
/// Attaching a node whose chain loops (a comment naming itself as its parent, or two naming each
/// other) builds an island that no root reaches, so those comments render nowhere at all - silently,
/// and while still being counted in `comments_count`. The data would have to be malformed for that
/// to happen, which is exactly why it must not depend on the data being well formed: the cost of
/// being wrong is a comment that exists in the library and cannot be seen.
function chainEndsAtARoot(
    node: CommentTreeNode,
    byCommentId: Map<string, CommentTreeNode>,
    cache: Map<CommentTreeNode, boolean>
): boolean {
    // Every node walked in a single pass shares the same outcome - the chain either reaches a root
    // or falls into a cycle, and that terminal is the same no matter which node on the path you
    // start from. So one walk resolves its whole path, and caching each visited node makes the pass
    // over all comments O(n) overall instead of O(n^2) on a long linear reply chain, while keeping
    // the cycle safety intact (a malformed self- or mutually-referencing chain still resolves to
    // false rather than looping forever).
    const path: CommentTreeNode[] = [];
    const seen = new Set<CommentTreeNode>();
    let current = node;
    let result: boolean;

    for (;;) {
        const memoized = cache.get(current);

        if (memoized !== undefined) {
            result = memoized;
            break;
        }

        if (seen.has(current)) {
            result = false;
            break;
        }

        seen.add(current);
        path.push(current);

        const parentId = current.parent_comment_id?.trim() ?? "";

        if (!parentId || parentId.toLowerCase() === "root") {
            result = true;
            break;
        }

        const parent = byCommentId.get(parentId);

        if (!parent) {
            // An unknown parent is already treated as a root by the caller (the reply arrived
            // without its thread), so the chain ends here.
            result = true;
            break;
        }

        current = parent;
    }

    for (const visited of path) {
        cache.set(visited, result);
    }

    return result;
}

// Builds the parent/child thread structure. The sort is a separate step (`sortCommentTree`)
// because linking - the id map and the per-node cycle check (`chainEndsAtARoot`, memoized to O(n)
// overall via the shared cache) - depends only on the comments, not on the sort order. Splitting
// them lets the caller memoize the structure on `comments` alone, so toggling the sort re-sorts
// without re-linking the whole tree. `sortMode` is optional and, when given, sorts in place for
// callers (and tests) that want a one-shot sorted tree; the panel passes it through `sortCommentTree`.
export function buildCommentTree(
    comments: MediaCommentRow[],
    sortMode?: CommentSortMode
): CommentTreeNode[] {
    const nodes = comments.map((comment) => ({
        ...comment,
        replies: [],
    }));

    const byCommentId = new Map<string, CommentTreeNode>();
    const roots: CommentTreeNode[] = [];
    // Shared across every chainEndsAtARoot call in this build so a parent chain is walked once.
    const chainCache = new Map<CommentTreeNode, boolean>();

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

        // Show it at the top level rather than losing it inside a cycle.
        if (!chainEndsAtARoot(node, byCommentId, chainCache)) {
            roots.push(node);
            continue;
        }

        parentNode.replies.push(node);
    }

    if (sortMode) {
        const mode = sortMode;
        const sortNodes = (items: CommentTreeNode[]): void => {
            items.sort((left, right) => compareComments(left, right, mode));

            for (const item of items) {
                sortNodes(item.replies);
            }
        };

        sortNodes(roots);
    }

    return roots;
}

// Returns a sorted copy of a built tree without mutating the input, so the structure built by
// `buildCommentTree` can stay memoized on `comments` while this runs again on every sort change.
// Node objects are shallow-cloned (new arrays, reused fields), which is what a reorder implies.
export function sortCommentTree(
    nodes: CommentTreeNode[],
    sortMode: CommentSortMode
): CommentTreeNode[] {
    return [...nodes]
        .sort((left, right) => compareComments(left, right, sortMode))
        .map((node) => ({
            ...node,
            replies: sortCommentTree(node.replies, sortMode),
        }));
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
