import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaRow } from "../types/media";

vi.mock("../services", () => ({
    deleteMediaWithFileCleanup: vi.fn(),
}));

import { deleteMediaWithFileCleanup } from "../services";
import { executeDeleteMedia } from "./delete-media";

const deleteMediaWithFileCleanupMock = vi.mocked(deleteMediaWithFileCleanup);

function createMediaRow(overrides: Partial<MediaRow> = {}): MediaRow {
    return {
        id: 5,
        channel_id: 1,
        title: "Video A",
        file_path: "media/video-a.mp4",
        thumbnail_path: null,
        media_type: "video",
        youtube_video_id: null,
        watched_at: null,
        published_at: null,
        duration_seconds: 0,
        progress_seconds: 0,
        has_comments: 0,
        comments_count: 0,
        is_live: 0,
        has_live_chat: 0,
        live_chat_file_path: null,
        created_at: "2026-03-30T12:00:00Z",
        ...overrides,
    };
}

describe("executeDeleteMedia", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("deletes media, closes player when active, and reloads media", async () => {
        const closePlayerIfActive = vi.fn();
        const reloadMedia = vi.fn().mockResolvedValue(undefined);

        await executeDeleteMedia({
            media: createMediaRow({
                thumbnail_path: "thumbs/video-a.jpg",
                live_chat_file_path: "live_chat/video-a.json",
            }),
            reloadMedia,
            closePlayerIfActive,
        });

        expect(deleteMediaWithFileCleanupMock).toHaveBeenCalledWith(5);
        expect(closePlayerIfActive).toHaveBeenCalledWith(5);
        expect(reloadMedia).toHaveBeenCalled();
    });

    it("does not reload when delete fails", async () => {
        const closePlayerIfActive = vi.fn();
        const reloadMedia = vi.fn().mockResolvedValue(undefined);

        deleteMediaWithFileCleanupMock.mockRejectedValueOnce(new Error("delete failed"));

        await expect(
            executeDeleteMedia({
                media: createMediaRow(),
                reloadMedia,
                closePlayerIfActive,
            })
        ).rejects.toThrow("delete failed");

        expect(closePlayerIfActive).not.toHaveBeenCalled();
        expect(reloadMedia).not.toHaveBeenCalled();
    });
});