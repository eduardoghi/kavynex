import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    cleanupUnusedChannelArtifacts,
    listChannelArtifactsSnapshot,
} from "./channel-artifacts-service";

vi.mock("../repositories/channel-repository", () => ({
    countChannelsUsingAvatarPathOutsideChannel: vi.fn(),
    countMediaUsingFilePathOutsideChannel: vi.fn(),
    countMediaUsingThumbnailOutsideChannel: vi.fn(),
    getChannelAvatarPathByChannelId: vi.fn(),
    listDistinctFilePathsByChannelId: vi.fn(),
    listDistinctThumbnailPathsByChannelId: vi.fn(),
}));

vi.mock("./media-file-service", () => ({
    deleteMediaFile: vi.fn(),
}));

vi.mock("./thumbnail-service", () => ({
    deleteThumbnailFile: vi.fn(),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import {
    countChannelsUsingAvatarPathOutsideChannel,
    countMediaUsingFilePathOutsideChannel,
    countMediaUsingThumbnailOutsideChannel,
    getChannelAvatarPathByChannelId,
    listDistinctFilePathsByChannelId,
    listDistinctThumbnailPathsByChannelId,
} from "../repositories/channel-repository";
import { deleteMediaFile } from "./media-file-service";
import { deleteThumbnailFile } from "./thumbnail-service";
import { logError } from "../utils/app-logger";

describe("channel-artifacts-service", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("lists channel artifact snapshot", async () => {
        vi.mocked(getChannelAvatarPathByChannelId).mockResolvedValueOnce("thumbnails/avatar.jpg");
        vi.mocked(listDistinctThumbnailPathsByChannelId).mockResolvedValue([
            "thumbnails/a.jpg",
            "thumbnails/b.jpg",
        ]);
        vi.mocked(listDistinctFilePathsByChannelId).mockResolvedValue([
            "video/a.mp4",
            "audio/b.mp3",
        ]);

        const result = await listChannelArtifactsSnapshot(10);

        expect(getChannelAvatarPathByChannelId).toHaveBeenCalledWith(10);
        expect(listDistinctThumbnailPathsByChannelId).toHaveBeenCalledWith(10);
        expect(listDistinctFilePathsByChannelId).toHaveBeenCalledWith(10);
        expect(result).toEqual({
            avatarPath: "thumbnails/avatar.jpg",
            thumbnailPaths: ["thumbnails/a.jpg", "thumbnails/b.jpg"],
            filePaths: ["video/a.mp4", "audio/b.mp3"],
        });
    });

    it("removes only unused channel artifacts", async () => {
        vi.mocked(countChannelsUsingAvatarPathOutsideChannel).mockResolvedValueOnce(0);

        vi.mocked(countMediaUsingThumbnailOutsideChannel)
            .mockResolvedValueOnce(0)
            .mockResolvedValueOnce(2);

        vi.mocked(countMediaUsingFilePathOutsideChannel)
            .mockResolvedValueOnce(0)
            .mockResolvedValueOnce(1);

        await cleanupUnusedChannelArtifacts(10, "/library", {
            avatarPath: "thumbnails/avatar.jpg",
            thumbnailPaths: ["thumbnails/a.jpg", "thumbnails/b.jpg"],
            filePaths: ["video/a.mp4", "audio/b.mp3"],
        });

        expect(countChannelsUsingAvatarPathOutsideChannel).toHaveBeenCalledWith(
            "thumbnails/avatar.jpg",
            10
        );

        expect(countMediaUsingThumbnailOutsideChannel).toHaveBeenNthCalledWith(
            1,
            "thumbnails/a.jpg",
            10
        );
        expect(countMediaUsingThumbnailOutsideChannel).toHaveBeenNthCalledWith(
            2,
            "thumbnails/b.jpg",
            10
        );

        expect(countMediaUsingFilePathOutsideChannel).toHaveBeenNthCalledWith(
            1,
            "video/a.mp4",
            10
        );
        expect(countMediaUsingFilePathOutsideChannel).toHaveBeenNthCalledWith(
            2,
            "audio/b.mp3",
            10
        );

        expect(deleteThumbnailFile).toHaveBeenCalledTimes(2);
        expect(deleteThumbnailFile).toHaveBeenCalledWith("thumbnails/avatar.jpg", "/library");
        expect(deleteThumbnailFile).toHaveBeenCalledWith("thumbnails/a.jpg", "/library");

        expect(deleteMediaFile).toHaveBeenCalledTimes(1);
        expect(deleteMediaFile).toHaveBeenCalledWith("video/a.mp4", "/library");
    });

    it("does nothing when library path is empty", async () => {
        await cleanupUnusedChannelArtifacts(10, "   ", {
            avatarPath: "thumbnails/avatar.jpg",
            thumbnailPaths: ["thumbnails/a.jpg"],
            filePaths: ["video/a.mp4"],
        });

        expect(countChannelsUsingAvatarPathOutsideChannel).not.toHaveBeenCalled();
        expect(countMediaUsingThumbnailOutsideChannel).not.toHaveBeenCalled();
        expect(countMediaUsingFilePathOutsideChannel).not.toHaveBeenCalled();
        expect(deleteThumbnailFile).not.toHaveBeenCalled();
        expect(deleteMediaFile).not.toHaveBeenCalled();
    });

    it("continues cleanup even when one delete fails", async () => {
        vi.mocked(countChannelsUsingAvatarPathOutsideChannel).mockResolvedValueOnce(0);
        vi.mocked(countMediaUsingThumbnailOutsideChannel).mockResolvedValue(0);
        vi.mocked(countMediaUsingFilePathOutsideChannel).mockResolvedValue(0);

        vi.mocked(deleteThumbnailFile)
            .mockRejectedValueOnce(new Error("avatar error"))
            .mockRejectedValueOnce(new Error("thumb error"));

        vi.mocked(deleteMediaFile).mockResolvedValue(undefined);

        await cleanupUnusedChannelArtifacts(10, "/library", {
            avatarPath: "thumbnails/avatar.jpg",
            thumbnailPaths: ["thumbnails/a.jpg"],
            filePaths: ["video/a.mp4"],
        });

        expect(deleteThumbnailFile).toHaveBeenCalledWith("thumbnails/avatar.jpg", "/library");
        expect(deleteThumbnailFile).toHaveBeenCalledWith("thumbnails/a.jpg", "/library");
        expect(deleteMediaFile).toHaveBeenCalledWith("video/a.mp4", "/library");
        expect(logError).toHaveBeenCalled();
    });
});