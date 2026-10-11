import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { MediaCommentRow } from "../types/generated/MediaCommentRow";
import {
    buildCommentTree,
    compareComments,
    countCommentsInTree,
    filterCommentTree,
    flattenCommentTree,
    matchesCommentSearch,
    sortCommentTree,
    type CommentSortMode,
    type CommentTreeNode,
} from "./comment-tree";

// The ids come from a small pool so generated comments name each other as parents often, which is
// what produces the shapes worth checking (deep chains, a comment naming itself, two naming each
// other, a reply whose parent is missing).
const ID_POOL = ["c0", "c1", "c2", "c3", "c4", "c5"];

const commentArbitrary = fc.record({
    comment_id: fc.option(fc.constantFrom(...ID_POOL), { nil: null }),
    parent_comment_id: fc.option(fc.constantFrom(...ID_POOL, "root", " c1 ", ""), { nil: null }),
    text: fc.string({ maxLength: 20 }),
    author_name: fc.string({ maxLength: 8 }),
    like_count: fc.nat(50),
    published_at: fc.option(
        fc.date({ min: new Date("2020-01-01"), max: new Date("2026-01-01"), noInvalidDate: true }),
        { nil: null }
    ),
});

const commentsArbitrary = fc
    .array(commentArbitrary, { maxLength: 30 })
    .map((items) =>
        items.map(
            (item, index): MediaCommentRow => ({
                id: index + 1,
                video_id: 1,
                comment_id: item.comment_id,
                parent_comment_id: item.parent_comment_id,
                author_name: item.author_name,
                author_handle: null,
                author_channel_id: null,
                author_thumbnail: null,
                text: item.text,
                original_text: null,
                like_count: item.like_count,
                reply_count: 0,
                is_author_uploader: 0,
                is_favorited: 0,
                is_pinned: 0,
                is_edited: 0,
                time_text: null,
                published_at: item.published_at?.toISOString() ?? null,
                created_at: "2026-01-01T00:00:00Z",
            })
        )
    );

const sortModeArbitrary = fc.constantFrom<CommentSortMode>("likes", "newest", "oldest");

function idsOf(nodes: CommentTreeNode[]): number[] {
    return flattenCommentTree(nodes)
        .map((row) => row.node.id)
        .sort((left, right) => left - right);
}

describe("comment tree properties", () => {
    it("keeps every comment exactly once, cycles and missing parents included", () => {
        fc.assert(
            fc.property(commentsArbitrary, (comments) => {
                const tree = buildCommentTree(comments);

                expect(countCommentsInTree(tree)).toBe(comments.length);
                expect(idsOf(tree)).toEqual(comments.map((comment) => comment.id));
            })
        );
    });

    it("sorts each level by the sort mode without adding or losing a comment", () => {
        fc.assert(
            fc.property(commentsArbitrary, sortModeArbitrary, (comments, sortMode) => {
                const tree = buildCommentTree(comments);
                const sorted = sortCommentTree(tree, sortMode);

                expect(idsOf(sorted)).toEqual(idsOf(tree));

                const checkLevel = (nodes: CommentTreeNode[]): void => {
                    for (let index = 1; index < nodes.length; index += 1) {
                        expect(
                            compareComments(nodes[index - 1]!, nodes[index]!, sortMode)
                        ).toBeLessThanOrEqual(0);
                    }

                    for (const node of nodes) {
                        checkLevel(node.replies);
                    }
                };

                checkLevel(sorted);
            })
        );
    });

    it("leaves the built tree as it was when sorting it", () => {
        fc.assert(
            fc.property(commentsArbitrary, sortModeArbitrary, (comments, sortMode) => {
                const tree = buildCommentTree(comments);
                const before = flattenCommentTree(tree).map((row) => [row.node.id, row.level]);

                sortCommentTree(tree, sortMode);

                expect(flattenCommentTree(tree).map((row) => [row.node.id, row.level])).toEqual(
                    before
                );
            })
        );
    });

    it("keeps a filtered node only when it or a reply below it matches", () => {
        fc.assert(
            fc.property(commentsArbitrary, fc.string({ maxLength: 3 }), (comments, query) => {
                const filtered = filterCommentTree(buildCommentTree(comments), query);

                for (const { node } of flattenCommentTree(filtered)) {
                    if (node.isContextOnly) {
                        expect(node.replies.length).toBeGreaterThan(0);
                    } else if (query) {
                        expect(matchesCommentSearch(node, query)).toBe(true);
                    }
                }
            })
        );
    });

    it("puts each reply one level below the comment before it", () => {
        fc.assert(
            fc.property(commentsArbitrary, (comments) => {
                const rows = flattenCommentTree(buildCommentTree(comments));

                rows.forEach((row, index) => {
                    if (index === 0) {
                        expect(row.level).toBe(0);
                    } else {
                        expect(row.level).toBeLessThanOrEqual(rows[index - 1]!.level + 1);
                    }
                });
            })
        );
    });
});
