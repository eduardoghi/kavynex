import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    createChannel,
    deleteChannelWithThumbnailCleanup,
    listAllChannels,
    updateChannelAvatarWithCleanup,
} from "./channel-service";

vi.mock("../repositories/channel-repository", () => ({
    countChannelsUsingAvatarPathOutsideChannel: vi.fn(),
    deleteChannelById: vi.fn(),
    findChannelByYoutubeHandle: vi.fn(),
    getChannelById: vi.fn(),
    insertChannel: vi.fn(),
    listChannels: vi.fn(),
    updateChannelAvatarPath: vi.fn(),
}));

vi.mock("./channel-artifacts-service", () => ({
    cleanupUnusedChannelArtifacts: vi.fn(),
    listChannelArtifactsSnapshot: vi.fn(),
}));

vi.mock("./channel-input-service", () => ({
    validateCreateChannelInput: vi.fn(),
    validateChannelId: vi.fn(),
    requireLibraryPath: vi.fn(),
}));

vi.mock("./thumbnail-service", () => ({
    deleteThumbnailFile: vi.fn(),
}));

import {
    countChannelsUsingAvatarPathOutsideChannel,
    deleteChannelById,
    findChannelByYoutubeHandle,
    getChannelById,
    insertChannel,
    listChannels,
    updateChannelAvatarPath,
} from "../repositories/channel-repository";
import {
    cleanupUnusedChannelArtifacts,
    listChannelArtifactsSnapshot,
} from "./channel-artifacts-service";
import {
    requireLibraryPath,
    validateChannelId,
    validateCreateChannelInput,
} from "./channel-input-service";
import { deleteThumbnailFile } from "./thumbnail-service";

describe("channel-service", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("lists all channels", async () => {
        vi.mocked(listChannels).mockResolvedValueOnce([
            {
                id: 1,
                name: "Canal A",
                youtube_handle: "@canala",
                avatar_path: null,
                created_at: "2026-03-31T10:00:00.000Z",
            },
        ]);

        const result = await listAllChannels();

        expect(listChannels).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(1);
    });

    it("creates channel when handle does not exist", async () => {
        vi.mocked(validateCreateChannelInput).mockReturnValueOnce({
            name: "Canal A",
            youtubeHandle: "@canala",
            avatarPath: null,
        });

        vi.mocked(findChannelByYoutubeHandle).mockResolvedValueOnce(null);
        vi.mocked(insertChannel).mockResolvedValueOnce(10);

        const result = await createChannel("Canal A", "@canala");

        expect(validateCreateChannelInput).toHaveBeenCalledWith({
            name: "Canal A",
            youtubeHandle: "@canala",
            avatarPath: null,
        });
        expect(findChannelByYoutubeHandle).toHaveBeenCalledWith("@canala");
        expect(insertChannel).toHaveBeenCalledWith("Canal A", "@canala", null);
        expect(result).toBe(10);
    });

    it("creates channel with avatar path when provided", async () => {
        vi.mocked(validateCreateChannelInput).mockReturnValueOnce({
            name: "Canal A",
            youtubeHandle: "@canala",
            avatarPath: "thumbnails/avatar_a.png",
        });

        vi.mocked(findChannelByYoutubeHandle).mockResolvedValueOnce(null);
        vi.mocked(insertChannel).mockResolvedValueOnce(10);

        const result = await createChannel(
            "Canal A",
            "@canala",
            "thumbnails/avatar_a.png"
        );

        expect(validateCreateChannelInput).toHaveBeenCalledWith({
            name: "Canal A",
            youtubeHandle: "@canala",
            avatarPath: "thumbnails/avatar_a.png",
        });
        expect(findChannelByYoutubeHandle).toHaveBeenCalledWith("@canala");
        expect(insertChannel).toHaveBeenCalledWith(
            "Canal A",
            "@canala",
            "thumbnails/avatar_a.png"
        );
        expect(result).toBe(10);
    });

    it("rejects duplicate channel handle", async () => {
        vi.mocked(validateCreateChannelInput).mockReturnValueOnce({
            name: "Canal A",
            youtubeHandle: "@canala",
            avatarPath: null,
        });

        vi.mocked(findChannelByYoutubeHandle).mockResolvedValueOnce({
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        });

        await expect(createChannel("Canal A", "@canala")).rejects.toThrow(
            "A channel with this YouTube handle already exists."
        );

        expect(insertChannel).not.toHaveBeenCalled();
    });

    it("returns without updating avatar when channel does not exist", async () => {
        vi.mocked(validateChannelId).mockReturnValueOnce({
            channelId: 10,
        });

        vi.mocked(getChannelById).mockResolvedValueOnce(null);

        await updateChannelAvatarWithCleanup(10, "thumbnails/new.png", "/library");

        expect(updateChannelAvatarPath).not.toHaveBeenCalled();
        expect(countChannelsUsingAvatarPathOutsideChannel).not.toHaveBeenCalled();
        expect(deleteThumbnailFile).not.toHaveBeenCalled();
        expect(requireLibraryPath).not.toHaveBeenCalled();
    });

    it("updates avatar without deleting previous file when there was no previous avatar", async () => {
        vi.mocked(validateChannelId).mockReturnValueOnce({
            channelId: 10,
        });

        vi.mocked(getChannelById).mockResolvedValueOnce({
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        });

        vi.mocked(updateChannelAvatarPath).mockResolvedValueOnce(undefined);

        await updateChannelAvatarWithCleanup(10, "thumbnails/new.png", "/library");

        expect(updateChannelAvatarPath).toHaveBeenCalledWith(
            10,
            "thumbnails/new.png"
        );
        expect(countChannelsUsingAvatarPathOutsideChannel).not.toHaveBeenCalled();
        expect(deleteThumbnailFile).not.toHaveBeenCalled();
        expect(requireLibraryPath).not.toHaveBeenCalled();
    });

    it("updates avatar and deletes previous file when no other channel uses it", async () => {
        vi.mocked(validateChannelId).mockReturnValueOnce({
            channelId: 10,
        });

        vi.mocked(getChannelById).mockResolvedValueOnce({
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: "thumbnails/old.png",
            created_at: "2026-03-31T10:00:00.000Z",
        });

        vi.mocked(requireLibraryPath).mockReturnValueOnce("/library");
        vi.mocked(updateChannelAvatarPath).mockResolvedValueOnce(undefined);
        vi.mocked(countChannelsUsingAvatarPathOutsideChannel).mockResolvedValueOnce(0);
        vi.mocked(deleteThumbnailFile).mockResolvedValueOnce(undefined);

        await updateChannelAvatarWithCleanup(10, "thumbnails/new.png", "/library");

        expect(requireLibraryPath).toHaveBeenCalledWith(
            "/library",
            "Library folder must be configured to replace or remove a saved channel avatar."
        );
        expect(updateChannelAvatarPath).toHaveBeenCalledWith(
            10,
            "thumbnails/new.png"
        );
        expect(countChannelsUsingAvatarPathOutsideChannel).toHaveBeenCalledWith(
            "thumbnails/old.png",
            10
        );
        expect(deleteThumbnailFile).toHaveBeenCalledWith(
            "thumbnails/old.png",
            "/library"
        );
    });

    it("updates avatar and keeps previous file when another channel still uses it", async () => {
        vi.mocked(validateChannelId).mockReturnValueOnce({
            channelId: 10,
        });

        vi.mocked(getChannelById).mockResolvedValueOnce({
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: "thumbnails/old.png",
            created_at: "2026-03-31T10:00:00.000Z",
        });

        vi.mocked(requireLibraryPath).mockReturnValueOnce("/library");
        vi.mocked(updateChannelAvatarPath).mockResolvedValueOnce(undefined);
        vi.mocked(countChannelsUsingAvatarPathOutsideChannel).mockResolvedValueOnce(2);

        await updateChannelAvatarWithCleanup(10, "thumbnails/new.png", "/library");

        expect(requireLibraryPath).toHaveBeenCalledWith(
            "/library",
            "Library folder must be configured to replace or remove a saved channel avatar."
        );
        expect(updateChannelAvatarPath).toHaveBeenCalledWith(
            10,
            "thumbnails/new.png"
        );
        expect(countChannelsUsingAvatarPathOutsideChannel).toHaveBeenCalledWith(
            "thumbnails/old.png",
            10
        );
        expect(deleteThumbnailFile).not.toHaveBeenCalled();
    });

    it("returns without deleting when channel does not exist", async () => {
        vi.mocked(validateChannelId).mockReturnValueOnce({
            channelId: 10,
        });

        vi.mocked(getChannelById).mockResolvedValueOnce(null);

        await deleteChannelWithThumbnailCleanup(10, "/library");

        expect(deleteChannelById).not.toHaveBeenCalled();
        expect(listChannelArtifactsSnapshot).not.toHaveBeenCalled();
        expect(cleanupUnusedChannelArtifacts).not.toHaveBeenCalled();
        expect(requireLibraryPath).not.toHaveBeenCalled();
    });

    it("deletes channel and cleans unused artifacts when physical artifacts exist", async () => {
        vi.mocked(validateChannelId).mockReturnValueOnce({
            channelId: 10,
        });

        vi.mocked(getChannelById).mockResolvedValueOnce({
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: "thumbnails/avatar_a.png",
            created_at: "2026-03-31T10:00:00.000Z",
        });

        vi.mocked(listChannelArtifactsSnapshot).mockResolvedValueOnce({
            avatarPath: "thumbnails/avatar_a.png",
            thumbnailPaths: ["thumbnails/a.jpg"],
            filePaths: ["video/a.mp4"],
        });

        vi.mocked(requireLibraryPath).mockReturnValueOnce("/library");
        vi.mocked(deleteChannelById).mockResolvedValueOnce(undefined);
        vi.mocked(cleanupUnusedChannelArtifacts).mockResolvedValueOnce(undefined);

        await deleteChannelWithThumbnailCleanup(10, "/library");

        expect(listChannelArtifactsSnapshot).toHaveBeenCalledWith(10);
        expect(requireLibraryPath).toHaveBeenCalledWith(
            "/library",
            "Library folder must be configured to delete a channel with saved media or thumbnails."
        );
        expect(deleteChannelById).toHaveBeenCalledWith(10);
        expect(cleanupUnusedChannelArtifacts).toHaveBeenCalledWith(10, "/library", {
            avatarPath: "thumbnails/avatar_a.png",
            thumbnailPaths: ["thumbnails/a.jpg"],
            filePaths: ["video/a.mp4"],
        });
    });

    it("deletes channel without requiring library path when there are no physical artifacts", async () => {
        vi.mocked(validateChannelId).mockReturnValueOnce({
            channelId: 10,
        });

        vi.mocked(getChannelById).mockResolvedValueOnce({
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        });

        vi.mocked(listChannelArtifactsSnapshot).mockResolvedValueOnce({
            avatarPath: null,
            thumbnailPaths: [],
            filePaths: [],
        });

        vi.mocked(deleteChannelById).mockResolvedValueOnce(undefined);
        vi.mocked(cleanupUnusedChannelArtifacts).mockResolvedValueOnce(undefined);

        await deleteChannelWithThumbnailCleanup(10, "   ");

        expect(requireLibraryPath).not.toHaveBeenCalled();
        expect(deleteChannelById).toHaveBeenCalledWith(10);
        expect(cleanupUnusedChannelArtifacts).toHaveBeenCalledWith(10, "", {
            avatarPath: null,
            thumbnailPaths: [],
            filePaths: [],
        });
    });
});