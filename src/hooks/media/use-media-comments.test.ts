import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaComments } from "./use-media-comments";
import { listMediaComments } from "../../services/media-service";
import { createMedia } from "../../test/factories/media";
import type { MediaCommentRow } from "../../types/media";

vi.mock("../../services/media-service", () => ({
    listMediaComments: vi.fn(),
}));

const listMock = vi.mocked(listMediaComments);

function commentRow(overrides: Partial<MediaCommentRow> = {}): MediaCommentRow {
    return {
        id: 1,
        video_id: 1,
        comment_id: "c1",
        parent_comment_id: null,
        author_name: "Author",
        author_handle: null,
        author_channel_id: null,
        author_thumbnail: null,
        text: "hi",
        like_count: 0,
        reply_count: 0,
        is_author_uploader: 0,
        is_favorited: 0,
        is_pinned: 0,
        original_text: null,
        is_edited: 0,
        time_text: null,
        published_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

describe("useMediaComments", () => {
    beforeEach(() => {
        listMock.mockReset();
    });

    it("loads comments for a media that has them", async () => {
        listMock.mockResolvedValue([commentRow()]);

        const { result } = renderHook(() =>
            useMediaComments(createMedia({ id: 7, has_comments: 1 }), false)
        );

        await waitFor(() => expect(result.current.isLoadingComments).toBe(false));

        expect(listMock).toHaveBeenCalledWith(7);
        expect(result.current.comments).toHaveLength(1);
        expect(result.current.error).toBeNull();
    });

    it("does not query and stays empty for a media without comments", async () => {
        const { result } = renderHook(() =>
            useMediaComments(createMedia({ id: 7, has_comments: 0 }), false)
        );

        await waitFor(() => expect(result.current.isLoadingComments).toBe(false));

        expect(listMock).not.toHaveBeenCalled();
        expect(result.current.comments).toEqual([]);
        expect(result.current.error).toBeNull();
    });

    it("surfaces an error (not an empty list) when the load fails", async () => {
        listMock.mockRejectedValue(new Error("boom"));

        const { result } = renderHook(() =>
            useMediaComments(createMedia({ id: 7, has_comments: 1 }), false)
        );

        await waitFor(() => expect(result.current.isLoadingComments).toBe(false));

        // The comments clear, but `error` is set so the panel can distinguish a read failure from
        // a media that genuinely has no comments (rather than showing "missing from database").
        expect(result.current.comments).toEqual([]);
        expect(result.current.error).not.toBeNull();
    });

    it("does not reload on a refresh's rising edge, only once it completes", async () => {
        listMock.mockResolvedValue([commentRow()]);
        const target = createMedia({ id: 7, has_comments: 1 });

        const { rerender, result } = renderHook(
            ({ refreshing }: { refreshing: boolean }) => useMediaComments(target, refreshing),
            { initialProps: { refreshing: false } }
        );

        await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

        // The refresh starting would only re-read the rows already showing. Give any stray effect
        // a tick to run, then confirm it stayed quiet and kept them.
        rerender({ refreshing: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(listMock).toHaveBeenCalledTimes(1);
        expect(result.current.comments).toHaveLength(1);

        // The refresh completing (the falling edge) is what triggers the reload.
        rerender({ refreshing: false });

        await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    });

    it("loads the saved comments when it mounts while a refresh is running", async () => {
        // The player reopened on a media whose refresh is still going. Waiting for the refresh
        // left the panel empty, reading as if the saved comments were lost.
        listMock.mockResolvedValue([commentRow()]);
        const target = createMedia({ id: 7, has_comments: 1 });

        const { result, rerender } = renderHook(
            ({ refreshing }: { refreshing: boolean }) => useMediaComments(target, refreshing),
            { initialProps: { refreshing: true } }
        );

        await waitFor(() => expect(result.current.comments).toHaveLength(1));
        expect(listMock).toHaveBeenCalledTimes(1);

        rerender({ refreshing: false });

        await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    });

    it("loads another media's comments during a refresh rather than keeping the previous one's", async () => {
        listMock.mockImplementation((mediaId: number) =>
            Promise.resolve([commentRow({ video_id: mediaId, comment_id: `c${mediaId}` })])
        );

        const { result, rerender } = renderHook(
            ({ mediaId }: { mediaId: number }) =>
                useMediaComments(createMedia({ id: mediaId, has_comments: 1 }), true),
            { initialProps: { mediaId: 7 } }
        );

        await waitFor(() => expect(result.current.comments[0]?.video_id).toBe(7));

        rerender({ mediaId: 8 });

        await waitFor(() => expect(result.current.comments[0]?.video_id).toBe(8));
    });
});
