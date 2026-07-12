import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaComments } from "./use-media-comments";
import { listMediaComments } from "../services/media-service";
import { createMedia } from "../test/factories/media";
import type { MediaCommentRow } from "../types/media";

vi.mock("../services/media-service", () => ({
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
    });

    it("does not query and stays empty for a media without comments", async () => {
        const { result } = renderHook(() =>
            useMediaComments(createMedia({ id: 7, has_comments: 0 }), false)
        );

        await waitFor(() => expect(result.current.isLoadingComments).toBe(false));

        expect(listMock).not.toHaveBeenCalled();
        expect(result.current.comments).toEqual([]);
    });

    it("clears comments and does not throw when the load fails", async () => {
        listMock.mockRejectedValue(new Error("boom"));

        const { result } = renderHook(() =>
            useMediaComments(createMedia({ id: 7, has_comments: 1 }), false)
        );

        await waitFor(() => expect(result.current.isLoadingComments).toBe(false));

        expect(result.current.comments).toEqual([]);
    });

    it("reloads when a comment refresh completes", async () => {
        listMock.mockResolvedValue([commentRow()]);
        const target = createMedia({ id: 7, has_comments: 1 });

        const { rerender } = renderHook(
            ({ refreshing }: { refreshing: boolean }) => useMediaComments(target, refreshing),
            { initialProps: { refreshing: true } }
        );

        await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

        rerender({ refreshing: false });

        await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    });
});
