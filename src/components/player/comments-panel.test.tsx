import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentsPanel } from "./comments-panel";
import { renderWithMantine } from "../../test/test-utils";
import { UI_TEXT } from "../../constants/ui-text";
import type { MediaCommentRow } from "../../types/media";

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

describe("CommentsPanel", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("debounces the search before filtering the comment tree", () => {
        renderWithMantine(
            <CommentsPanel
                comments={[
                    comment({ id: 1, comment_id: "c1", text: "apple pie" }),
                    comment({ id: 2, comment_id: "c2", text: "banana bread" }),
                ]}
                hasComments
                commentsCount={2}
                isLoadingComments={false}
                shellBorder="rgba(255,255,255,0.1)"
            />
        );

        expect(screen.getByText("apple pie")).toBeInTheDocument();
        expect(screen.getByText("banana bread")).toBeInTheDocument();

        act(() => {
            fireEvent.change(screen.getByLabelText(UI_TEXT.comments.searchLabel), {
                target: { value: "apple" },
            });
        });

        // Before the debounce elapses the whole-tree filter must not have run yet, so the
        // non-matching thread is still shown.
        expect(screen.getByText("banana bread")).toBeInTheDocument();

        act(() => {
            vi.advanceTimersByTime(200);
        });

        // After the debounce, only the matching thread remains.
        expect(screen.queryByText("banana bread")).not.toBeInTheDocument();
        expect(screen.getByText("apple pie")).toBeInTheDocument();
    });
});
