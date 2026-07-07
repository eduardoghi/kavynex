import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    createChannel,
    deleteChannelWithThumbnailCleanup,
    listAllChannels,
    updateChannelAvatarWithCleanup,
} from "./channel-service";

vi.mock("../repositories/channel-repository", () => ({
    deleteChannelWithArtifacts: vi.fn(),
    findChannelByYoutubeHandle: vi.fn(),
    getChannelById: vi.fn(),
    insertChannel: vi.fn(),
    listChannels: vi.fn(),
    replaceChannelAvatar: vi.fn(),
}));

vi.mock("./channel-input-service", () => ({
    validateCreateChannelInput: vi.fn(),
    validateChannelId: vi.fn(),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import {
    deleteChannelWithArtifacts,
    findChannelByYoutubeHandle,
    insertChannel,
    listChannels,
    replaceChannelAvatar,
} from "../repositories/channel-repository";
import {
    validateChannelId,
    validateCreateChannelInput,
} from "./channel-input-service";
import { logError } from "../utils/app-logger";

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

    it("updates the avatar through the atomic backend command and trims the path", async () => {
        vi.mocked(validateChannelId).mockReturnValueOnce({ channelId: 10 });
        vi.mocked(replaceChannelAvatar).mockResolvedValueOnce({
            deleted_paths: ["thumbnails/old.png"],
            skipped_shared_paths: [],
            failed_paths: [],
        });

        await updateChannelAvatarWithCleanup(10, "  thumbnails/new.png  ");

        expect(replaceChannelAvatar).toHaveBeenCalledWith(10, "thumbnails/new.png");
        expect(logError).not.toHaveBeenCalled();
    });

    it("normalizes an empty avatar path to null when clearing the avatar", async () => {
        vi.mocked(validateChannelId).mockReturnValueOnce({ channelId: 10 });
        vi.mocked(replaceChannelAvatar).mockResolvedValueOnce({
            deleted_paths: [],
            skipped_shared_paths: [],
            failed_paths: [],
        });

        await updateChannelAvatarWithCleanup(10, "   ");

        expect(replaceChannelAvatar).toHaveBeenCalledWith(10, null);
    });

    it("logs an orphan warning when the backend could not delete the previous avatar", async () => {
        vi.mocked(validateChannelId).mockReturnValueOnce({ channelId: 10 });
        vi.mocked(replaceChannelAvatar).mockResolvedValueOnce({
            deleted_paths: [],
            skipped_shared_paths: [],
            failed_paths: ["thumbnails/old.png"],
        });

        await expect(
            updateChannelAvatarWithCleanup(10, "thumbnails/new.png")
        ).resolves.toBeUndefined();

        expect(logError).toHaveBeenCalledWith(
            "channel-service",
            expect.stringContaining("orphaned"),
            null,
            { channelId: 10, failedPaths: ["thumbnails/old.png"] }
        );
    });

    it("rejects an invalid channel id without calling the backend", async () => {
        vi.mocked(validateChannelId).mockImplementationOnce(() => {
            throw new Error("Channel id is invalid.");
        });

        await expect(
            updateChannelAvatarWithCleanup(0, "thumbnails/new.png")
        ).rejects.toThrow("Channel id is invalid.");

        expect(replaceChannelAvatar).not.toHaveBeenCalled();
    });

    it("deletes channel through the atomic backend command without logging when nothing failed", async () => {
        vi.mocked(validateChannelId).mockReturnValueOnce({
            channelId: 10,
        });

        vi.mocked(deleteChannelWithArtifacts).mockResolvedValueOnce({
            deleted_paths: ["thumbnails/avatar_a.png", "video/a.mp4"],
            skipped_shared_paths: [],
            failed_paths: [],
        });

        await expect(deleteChannelWithThumbnailCleanup(10)).resolves.toBeUndefined();

        expect(deleteChannelWithArtifacts).toHaveBeenCalledWith(10);
        expect(logError).not.toHaveBeenCalled();
    });

    it("logs an orphan warning when the backend reports files it could not delete", async () => {
        vi.mocked(validateChannelId).mockReturnValueOnce({
            channelId: 10,
        });

        vi.mocked(deleteChannelWithArtifacts).mockResolvedValueOnce({
            deleted_paths: [],
            skipped_shared_paths: [],
            failed_paths: ["thumbnails/avatar_a.png"],
        });

        await expect(deleteChannelWithThumbnailCleanup(10)).resolves.toBeUndefined();

        expect(logError).toHaveBeenCalledWith(
            "channel-service",
            expect.stringContaining("orphaned"),
            null,
            { channelId: 10, failedPaths: ["thumbnails/avatar_a.png"] }
        );
    });

    it("rejects an invalid channel id without calling the repository", async () => {
        vi.mocked(validateChannelId).mockImplementationOnce(() => {
            throw new Error("Channel id is invalid.");
        });

        await expect(deleteChannelWithThumbnailCleanup(0)).rejects.toThrow(
            "Channel id is invalid."
        );

        expect(deleteChannelWithArtifacts).not.toHaveBeenCalled();
    });
});