import { describe, expect, it } from "vitest";
import type { MediaCommentRow } from "../../types/media";
import {
    buildCommentTree,
    countCommentsInTree,
    filterCommentTree,
    formatCommentPublishedAt,
    matchesCommentSearch,
    normalizeSearchValue,
    parseCommentTimestamp,
    sortCommentTree,
} from "./comment-tree";

function comment(overrides: Partial<MediaCommentRow> = {}): MediaCommentRow {
    return {
        id: 1,
        video_id: 1,
        comment_id: null,
        parent_comment_id: null,
        author_name: "Author",
        author_handle: null,
        author_channel_id: null,
        author_thumbnail: null,
        text: "text",
        like_count: 0,
        reply_count: 0,
        is_author_uploader: 0,
        is_favorited: 0,
        is_pinned: 0,
        is_edited: 0,
        time_text: null,
        published_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

describe("buildCommentTree", () => {
    it("keeps comments visible when their parent chain loops", () => {
        // Two comments naming each other as parent: neither is a root, so a single attach pass
        // builds an island nothing reaches and both vanish from the UI - silently, while
        // comments_count still counts them. Malformed data is the only way in, which is why this
        // cannot rely on the data being well formed.
        const tree = buildCommentTree(
            [
                comment({ id: 1, comment_id: "a", parent_comment_id: "b", text: "first" }),
                comment({ id: 2, comment_id: "b", parent_comment_id: "a", text: "second" }),
            ],
            "newest"
        );

        expect(countCommentsInTree(tree)).toBe(2);
        expect(tree.map((node) => node.text).sort()).toEqual(["first", "second"]);
    });

    it("keeps a comment that names itself as its parent", () => {
        const tree = buildCommentTree(
            [comment({ id: 1, comment_id: "a", parent_comment_id: "a", text: "self" })],
            "newest"
        );

        expect(countCommentsInTree(tree)).toBe(1);
        expect(tree[0]?.text).toBe("self");
        expect(tree[0]?.replies).toEqual([]);
    });

    it("nests replies under their parent by comment_id", () => {
        const tree = buildCommentTree(
            [
                comment({ id: 1, comment_id: "c1", text: "root" }),
                comment({ id: 2, comment_id: "c2", parent_comment_id: "c1", text: "reply" }),
            ],
            "likes"
        );

        expect(tree).toHaveLength(1);
        expect(tree[0]!.comment_id).toBe("c1");
        expect(tree[0]!.replies).toHaveLength(1);
        expect(tree[0]!.replies[0]!.comment_id).toBe("c2");
    });

    it("treats a reply with an unknown parent as a root instead of dropping it", () => {
        const tree = buildCommentTree(
            [comment({ id: 2, comment_id: "c2", parent_comment_id: "missing" })],
            "likes"
        );

        expect(tree.map((node) => node.comment_id)).toEqual(["c2"]);
    });

    it("treats a 'root' parent marker as a top-level comment", () => {
        const tree = buildCommentTree(
            [comment({ id: 1, comment_id: "c1", parent_comment_id: "ROOT" })],
            "likes"
        );

        expect(tree).toHaveLength(1);
        expect(tree[0]!.replies).toHaveLength(0);
    });

    it("sorts by likes desc then id, and preserves order in replies", () => {
        const tree = buildCommentTree(
            [
                comment({ id: 1, comment_id: "a", like_count: 5 }),
                comment({ id: 2, comment_id: "b", like_count: 10 }),
                comment({ id: 3, comment_id: "c", like_count: 10 }),
            ],
            "likes"
        );

        // 10 likes before 5; the two 10s tie-break by ascending id (2 before 3).
        expect(tree.map((node) => node.id)).toEqual([2, 3, 1]);
    });

    it("sorts newest and oldest by published timestamp", () => {
        const older = comment({ id: 1, comment_id: "a", published_at: "1000" });
        const newer = comment({ id: 2, comment_id: "b", published_at: "2000" });

        expect(buildCommentTree([older, newer], "newest").map((n) => n.id)).toEqual([2, 1]);
        expect(buildCommentTree([older, newer], "oldest").map((n) => n.id)).toEqual([1, 2]);
    });
});

describe("sortCommentTree", () => {
    it("matches the order of a one-shot sorted build", () => {
        const comments = [
            comment({ id: 1, comment_id: "a", like_count: 5 }),
            comment({ id: 2, comment_id: "b", like_count: 10 }),
            comment({ id: 3, comment_id: "c", parent_comment_id: "b", like_count: 1 }),
            comment({ id: 4, comment_id: "d", parent_comment_id: "b", like_count: 9 }),
        ];

        const structure = buildCommentTree(comments);
        const sorted = sortCommentTree(structure, "likes");

        const oneShot = buildCommentTree(comments, "likes");

        const flatten = (nodes: ReturnType<typeof buildCommentTree>): number[] =>
            nodes.flatMap((node) => [node.id, ...flatten(node.replies)]);

        expect(flatten(sorted)).toEqual(flatten(oneShot));
    });

    it("does not mutate the built structure it is given", () => {
        const structure = buildCommentTree([
            comment({ id: 1, comment_id: "a", like_count: 1 }),
            comment({ id: 2, comment_id: "b", like_count: 9 }),
        ]);

        const beforeOrder = structure.map((node) => node.id);
        sortCommentTree(structure, "likes");

        // The input keeps its original (insertion) order; the sort returned a new tree.
        expect(structure.map((node) => node.id)).toEqual(beforeOrder);
    });
});

describe("filterCommentTree", () => {
    const tree = buildCommentTree(
        [
            comment({ id: 1, comment_id: "c1", text: "hello world" }),
            comment({ id: 2, comment_id: "c2", parent_comment_id: "c1", text: "a reply" }),
            comment({ id: 3, comment_id: "c3", text: "unrelated" }),
        ],
        "likes"
    );

    it("returns the tree unchanged for an empty query", () => {
        expect(filterCommentTree(tree, "")).toBe(tree);
    });

    it("keeps a parent whose reply matches, and drops unrelated threads", () => {
        const filtered = filterCommentTree(tree, "reply");

        expect(filtered.map((node) => node.comment_id)).toEqual(["c1"]);
        expect(filtered[0]!.replies.map((node) => node.comment_id)).toEqual(["c2"]);
    });

    it("keeps a matching root and prunes its non-matching replies", () => {
        const filtered = filterCommentTree(tree, "hello");

        expect(filtered.map((node) => node.comment_id)).toEqual(["c1"]);
        expect(filtered[0]!.replies).toHaveLength(0);
    });
});

describe("matchesCommentSearch", () => {
    it("matches across author name, handle and text case-insensitively", () => {
        const c = comment({ author_name: "Alice", author_handle: "@wonder", text: "Rabbit hole" });
        expect(matchesCommentSearch(c, "wonder")).toBe(true);
        expect(matchesCommentSearch(c, "rabbit")).toBe(true);
        expect(matchesCommentSearch(c, "missing")).toBe(false);
    });
});

describe("countCommentsInTree", () => {
    it("counts every comment including nested replies", () => {
        const tree = buildCommentTree(
            [
                comment({ id: 1, comment_id: "c1" }),
                comment({ id: 2, comment_id: "c2", parent_comment_id: "c1" }),
                comment({ id: 3, comment_id: "c3", parent_comment_id: "c2" }),
                comment({ id: 4, comment_id: "c4" }),
            ],
            "likes"
        );

        expect(countCommentsInTree(tree)).toBe(4);
    });
});

describe("parseCommentTimestamp", () => {
    it("reads a unix-seconds string as milliseconds", () => {
        expect(parseCommentTimestamp(comment({ published_at: "1500" }))).toBe(1_500_000);
    });

    it("parses an ISO date string", () => {
        expect(parseCommentTimestamp(comment({ published_at: "2026-01-01T00:00:00.000Z" }))).toBe(
            Date.parse("2026-01-01T00:00:00.000Z")
        );
    });

    it("returns 0 for missing or unparseable values", () => {
        expect(parseCommentTimestamp(comment({ published_at: null }))).toBe(0);
        expect(parseCommentTimestamp(comment({ published_at: "not a date" }))).toBe(0);
    });
});

describe("formatCommentPublishedAt", () => {
    it("prefers the human time_text when present", () => {
        expect(formatCommentPublishedAt("2026-01-01T00:00:00.000Z", "2 days ago")).toBe(
            "2 days ago"
        );
    });

    it("returns an empty string when nothing is available", () => {
        expect(formatCommentPublishedAt(null, null)).toBe("");
    });

    it("falls back to the raw value when it cannot be formatted as a date", () => {
        expect(formatCommentPublishedAt("sometime", null)).toBe("sometime");
    });
});

describe("normalizeSearchValue", () => {
    it("trims and lowercases", () => {
        expect(normalizeSearchValue("  HeLLo  ")).toBe("hello");
    });
});
