import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services", () => ({
    setMediaUnwatched: vi.fn(),
}));

import { setMediaUnwatched } from "../services";
import { executeMarkMediaUnwatched } from "./mark-media-unwatched";

const setMediaUnwatchedMock = vi.mocked(setMediaUnwatched);

describe("executeMarkMediaUnwatched", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("clears watched_at only for the target media", async () => {
        const initialItems = [
            {
                id: 1,
                channel_id: 1,
                title: "Video A",
                file_path: "a.mp4",
                thumbnail_path: null,
                media_type: "video",
                youtube_video_id: null,
                watched_at: "2026-03-30T12:00:00Z",
                published_at: null,
                created_at: "2026-03-30T12:00:00Z",
            },
            {
                id: 2,
                channel_id: 1,
                title: "Video B",
                file_path: "b.mp4",
                thumbnail_path: null,
                media_type: "video",
                youtube_video_id: null,
                watched_at: "2026-03-30T12:00:00Z",
                published_at: null,
                created_at: "2026-03-30T12:00:00Z",
            },
        ];

        let currentItems = initialItems;

        const updateMediaItems = vi.fn((updater) => {
            currentItems = updater(currentItems);
        });

        await executeMarkMediaUnwatched({
            mediaId: 1,
            updateMediaItems,
        });

        expect(setMediaUnwatchedMock).toHaveBeenCalledWith(1);
        expect(currentItems[0].watched_at).toBeNull();
        expect(currentItems[1].watched_at).toBe("2026-03-30T12:00:00Z");
    });
});