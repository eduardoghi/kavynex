import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentsPanel } from "./comments-panel";
import { RemoteImagesProvider } from "./remote-images-context";
import { describeViolations, findAccessibilityViolations } from "../../test/axe";
import { renderWithMantine } from "../../test/test-utils";
import { UI_TEXT } from "../../constants/ui-text";
import type { MediaCommentRow } from "../../types/media";

// The search view (CommentSearchResults) virtualizes its rows. jsdom gives the scroll container no
// height, so the real virtualizer would render nothing; mock it to yield every row (as the media
// grid test does) so search assertions can see the matches.
vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: vi.fn(({ count }: { count: number }) => ({
        getTotalSize: () => count * 140,
        getVirtualItems: () =>
            Array.from({ length: count }, (_, index) => ({
                index,
                key: index,
                start: index * 140,
            })),
        measureElement: vi.fn(),
        measure: vi.fn(),
    })),
}));

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

// The props every render needs, so the tests below can name only what they are about. Kept minimal
// on purpose. A fixture carrying `commentsState` would make the tests that assert on it pass for the
// fixture's reason rather than the component's.
const baseProps = {
    comments: [],
    hasComments: false,
    isLoadingComments: false,
    shellBorder: "rgba(255,255,255,0.1)",
} as const;

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

    it("shows every match when searching, past the browse thread cap and with no load-more", () => {
        // 35 matching top-level threads. More than the browse view's 30-thread cap. Search must
        // surface all of them (the point of searching the whole comment set), so the 35th is present
        // and there is no "load more" gate; the virtualized results list is what makes rendering all
        // of them safe.
        const comments = Array.from({ length: 35 }, (_, index) =>
            comment({
                id: index + 1,
                comment_id: `c${index}`,
                text: `needle comment ${index}`,
            })
        );

        renderWithMantine(
            <CommentsPanel
                comments={comments}
                hasComments
                commentsCount={comments.length}
                isLoadingComments={false}
                shellBorder="rgba(255,255,255,0.1)"
            />
        );

        act(() => {
            fireEvent.change(screen.getByLabelText(UI_TEXT.comments.searchLabel), {
                target: { value: "needle" },
            });
        });

        act(() => {
            vi.advanceTimersByTime(200);
        });

        // The 35th match is rendered even though it is past the 30-thread browse cap...
        expect(screen.getByText("needle comment 34")).toBeInTheDocument();
        // ...and search does not gate results behind a "load more" button.
        expect(
            screen.queryByText(new RegExp(UI_TEXT.comments.loadMore))
        ).not.toBeInTheDocument();
    });

    it("excludes context-only thread parents from the results count and marks them in the list", () => {
        // "needle" only matches the reply; the root is retained purely as thread context and must
        // not inflate "Showing N results" or read as an unmarked match in the list.
        renderWithMantine(
            <CommentsPanel
                comments={[
                    comment({ id: 1, comment_id: "c1", text: "hello world" }),
                    comment({
                        id: 2,
                        comment_id: "c2",
                        parent_comment_id: "c1",
                        text: "needle reply",
                    }),
                ]}
                hasComments
                commentsCount={2}
                isLoadingComments={false}
                shellBorder="rgba(255,255,255,0.1)"
            />
        );

        act(() => {
            fireEvent.change(screen.getByLabelText(UI_TEXT.comments.searchLabel), {
                target: { value: "needle" },
            });
        });

        act(() => {
            vi.advanceTimersByTime(200);
        });

        expect(
            screen.getByText(
                `${UI_TEXT.comments.resultsShowing} 1 result ${UI_TEXT.comments.resultsFor}`,
                {
                    exact: false,
                }
            )
        ).toBeInTheDocument();
        expect(screen.getByText("needle reply")).toBeInTheDocument();
        // The context-only parent is still shown (for thread context) but labeled as such.
        expect(screen.getByText("hello world")).toBeInTheDocument();
        expect(screen.getByText(UI_TEXT.comments.contextLabel)).toBeInTheDocument();
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

    it("offers the fetch button while nothing has been fetched yet", () => {
        // `unknown` is what an interrupted backup looks like (a crash between registering the media
        // and saving its comments), so the recovery button belongs here.
        renderWithMantine(
            <CommentsPanel
                {...baseProps}
                comments={[]}
                hasComments={false}
                commentsState="unknown"
                canFetchComments
                onFetchComments={vi.fn()}
            />
        );

        expect(
            screen.getByRole("button", { name: UI_TEXT.comments.fetchComments })
        ).toBeInTheDocument();
    });

    it("stops offering a fetch once one has come back with nothing", () => {
        // The defect this state was added for. `hasComments` is 0 in both cases, so the button was
        // shown either way and clicking it changed nothing on screen. A user with a video whose
        // comments are off could click it forever.
        renderWithMantine(
            <CommentsPanel
                {...baseProps}
                comments={[]}
                hasComments={false}
                commentsState="none"
                canFetchComments
                onFetchComments={vi.fn()}
            />
        );

        expect(
            screen.queryByRole("button", { name: UI_TEXT.comments.fetchComments })
        ).not.toBeInTheDocument();
        expect(screen.getByText(UI_TEXT.comments.noneToSave)).toBeInTheDocument();
    });

    it("says nothing about why a fetch found nothing", () => {
        // Worded as what was observed rather than as a claim about the video. yt-dlp reports a
        // comment count and no separate "comments are disabled" flag, so distinguishing a video with
        // comments switched off from one that simply has none would be a guess shown as fact.
        renderWithMantine(
            <CommentsPanel
                {...baseProps}
                comments={[]}
                hasComments={false}
                commentsState="none"
                canFetchComments
                onFetchComments={vi.fn()}
            />
        );

        expect(screen.queryByText(/disabled/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/turned off/i)).not.toBeInTheDocument();
    });

    it("keeps the read failure in front of the settled-empty notice", () => {
        // A transient read failure is not an answer about the video, and reporting "there is nothing
        // to save" over it would turn a retryable error into a verdict.
        renderWithMantine(
            <CommentsPanel
                {...baseProps}
                comments={[]}
                hasComments={false}
                commentsState="none"
                error="The saved comments could not be read."
                canFetchComments
                onFetchComments={vi.fn()}
            />
        );

        expect(screen.getByText("The saved comments could not be read.")).toBeInTheDocument();
        expect(screen.queryByText(UI_TEXT.comments.noneToSave)).not.toBeInTheDocument();
    });

    it("says so under a comment the backend cut at its ceiling, and nowhere else", () => {
        // A body at the ceiling is the only signal there is. The backend truncates and records
        // nothing, and YouTube's own cap is well below, so the length is the evidence. The note
        // carries the number so the reader knows what "truncated" meant.
        renderWithMantine(
            <RemoteImagesProvider value={false}>
                <CommentsPanel
                    {...baseProps}
                    comments={[
                        comment({ id: 1, comment_id: "cut", text: "a".repeat(16_000) }),
                        comment({ id: 2, comment_id: "whole", text: "short" }),
                    ]}
                    hasComments
                    commentsCount={2}
                />
            </RemoteImagesProvider>
        );

        expect(
            screen.getAllByText("Truncated when it was saved (16,000 characters)")
        ).toHaveLength(1);
    });

    it("has no detectable accessibility violations, populated and in the empty state", async () => {
        // axe schedules its own work on timers, so it hangs under the fake clock the rest of this
        // file runs on. Real timers for this test only.
        vi.useRealTimers();

        // Populated one past the browse cap, with a reply thread on the first comment, so the sort
        // select, the search field, the per-comment controls and the load-more button are all in
        // the tree. Then the empty state that offers the fetch, which is the other set of controls
        // this panel has. Kept small on purpose: axe over a hundred comment rows in jsdom ran past
        // the test timeout, and the rows are all the same shape.
        const threads = Array.from({ length: 31 }, (_, index) =>
            comment({
                id: index + 1,
                comment_id: `c${index}`,
                author_name: `Author ${index}`,
                text: `Thread ${index}`,
                like_count: index,
                is_pinned: index === 0 ? 1 : 0,
                reply_count: index === 0 ? 2 : 0,
            })
        ).concat(
            [1, 2].map((n) =>
                comment({
                    id: 100 + n,
                    comment_id: `c0-r${n}`,
                    parent_comment_id: "c0",
                    author_name: `Replier ${n}`,
                    text: `Reply ${n}`,
                })
            )
        );

        const populated = renderWithMantine(
            <RemoteImagesProvider value={false}>
                <CommentsPanel
                    {...baseProps}
                    comments={threads}
                    hasComments
                    commentsCount={threads.length}
                    commentsState="available"
                    canFetchComments
                    onFetchComments={vi.fn()}
                />
            </RemoteImagesProvider>
        );

        expect(
            describeViolations(await findAccessibilityViolations(populated.container)),
            "populated"
        ).toBe("");

        populated.unmount();

        const empty = renderWithMantine(
            <RemoteImagesProvider value={false}>
                <CommentsPanel
                    {...baseProps}
                    comments={[]}
                    hasComments={false}
                    commentsState="unknown"
                    canFetchComments
                    onFetchComments={vi.fn()}
                />
            </RemoteImagesProvider>
        );

        expect(
            describeViolations(await findAccessibilityViolations(empty.container)),
            "empty"
        ).toBe("");
    }, 15_000);
});
