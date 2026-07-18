import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentsPanel } from "./comments-panel";
import { RemoteImagesProvider } from "./remote-images-context";
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

    it("renders a monogram and skips the remote thumbnail when remote images are off", () => {
        const { container } = renderWithMantine(
            <RemoteImagesProvider value={false}>
                <CommentsPanel
                    comments={[
                        comment({
                            id: 1,
                            comment_id: "c1",
                            author_name: "Zoe",
                            author_thumbnail: "https://yt3.ggpht.com/avatar.jpg",
                        }),
                    ]}
                    hasComments
                    commentsCount={1}
                    isLoadingComments={false}
                    shellBorder="rgba(255,255,255,0.1)"
                />
            </RemoteImagesProvider>
        );

        expect(
            container.querySelector('img[src="https://yt3.ggpht.com/avatar.jpg"]')
        ).toBeNull();
        expect(screen.getByText("ZO")).toBeInTheDocument();
    });

    it("loads the remote thumbnail when remote images are on", () => {
        const { container } = renderWithMantine(
            <RemoteImagesProvider value={true}>
                <CommentsPanel
                    comments={[
                        comment({
                            id: 1,
                            comment_id: "c1",
                            author_name: "Zoe",
                            author_thumbnail: "https://yt3.ggpht.com/avatar.jpg",
                        }),
                    ]}
                    hasComments
                    commentsCount={1}
                    isLoadingComments={false}
                    shellBorder="rgba(255,255,255,0.1)"
                />
            </RemoteImagesProvider>
        );

        expect(
            container.querySelector('img[src="https://yt3.ggpht.com/avatar.jpg"]')
        ).not.toBeNull();
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

    it("offers to fetch comments in the empty state for a YouTube-sourced media", () => {
        const onFetchComments = vi.fn();

        renderWithMantine(
            <CommentsPanel
                comments={[]}
                hasComments={false}
                isLoadingComments={false}
                shellBorder="rgba(255,255,255,0.1)"
                canFetchComments
                onFetchComments={onFetchComments}
            />
        );

        const button = screen.getByRole("button", { name: UI_TEXT.comments.fetchComments });

        act(() => {
            fireEvent.click(button);
        });

        expect(onFetchComments).toHaveBeenCalledTimes(1);
    });

    it("does not offer to fetch comments when the media has no YouTube source", () => {
        renderWithMantine(
            <CommentsPanel
                comments={[]}
                hasComments={false}
                isLoadingComments={false}
                shellBorder="rgba(255,255,255,0.1)"
                canFetchComments={false}
                onFetchComments={vi.fn()}
            />
        );

        expect(
            screen.queryByRole("button", { name: UI_TEXT.comments.fetchComments })
        ).not.toBeInTheDocument();
    });

    it("shows the load error instead of the missing-from-database text when a read fails", () => {
        renderWithMantine(
            <CommentsPanel
                comments={[]}
                hasComments
                commentsCount={3}
                isLoadingComments={false}
                error="Could not load the saved comments for this media."
                shellBorder="rgba(255,255,255,0.1)"
            />
        );

        // The read failed, so the panel must surface the error, not claim the comments are
        // "missing from the local database" (which reads as data loss to the user).
        expect(
            screen.getByText("Could not load the saved comments for this media.")
        ).toBeInTheDocument();
        expect(
            screen.queryByText(UI_TEXT.comments.missingFromDatabase)
        ).not.toBeInTheDocument();
    });

    it("notes when fewer comments were loaded than the media has saved", () => {
        renderWithMantine(
            <CommentsPanel
                comments={[comment({ id: 1, comment_id: "c1", text: "hello" })]}
                hasComments
                commentsCount={50000}
                isLoadingComments={false}
                shellBorder="rgba(255,255,255,0.1)"
            />
        );

        expect(
            screen.getByText(new RegExp(UI_TEXT.comments.truncatedNoticeSuffix))
        ).toBeInTheDocument();
    });

    it("does not note truncation when every saved comment was loaded", () => {
        renderWithMantine(
            <CommentsPanel
                comments={[comment({ id: 1, comment_id: "c1", text: "hello" })]}
                hasComments
                commentsCount={1}
                isLoadingComments={false}
                shellBorder="rgba(255,255,255,0.1)"
            />
        );

        expect(
            screen.queryByText(new RegExp(UI_TEXT.comments.truncatedNoticeSuffix))
        ).not.toBeInTheDocument();
    });

    it("does not offer to fetch comments when comments are already present", () => {
        renderWithMantine(
            <CommentsPanel
                comments={[comment({ id: 1, comment_id: "c1", text: "hello" })]}
                hasComments
                commentsCount={1}
                isLoadingComments={false}
                shellBorder="rgba(255,255,255,0.1)"
                canFetchComments
                onFetchComments={vi.fn()}
            />
        );

        expect(
            screen.queryByRole("button", { name: UI_TEXT.comments.fetchComments })
        ).not.toBeInTheDocument();
    });
});
