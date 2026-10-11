import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    createChannel,
    ensureChannelCanBeCreated,
    deleteChannelWithThumbnailCleanup,
    listAllChannels,
    updateChannelAvatarWithCleanup,
    updateChannelNameHandle,
} from "./channel-service";

vi.mock("../repositories/channel-repository", () => ({
    deleteChannelWithArtifacts: vi.fn(),
    findChannelByYoutubeHandle: vi.fn(),
    getChannelById: vi.fn(),
    insertChannel: vi.fn(),
    listChannels: vi.fn(),
    replaceChannelAvatar: vi.fn(),
    updateChannelNameAndHandle: vi.fn(),
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
    getChannelById,
    insertChannel,
    updateChannelNameAndHandle,
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

    it("tells a caller a channel would be refused before anything is created", async () => {
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

        await expect(ensureChannelCanBeCreated("Canal A", "@canala")).rejects.toThrow(
            "A channel with this YouTube handle already exists."
        );
        expect(insertChannel).not.toHaveBeenCalled();

        vi.mocked(validateCreateChannelInput).mockReturnValueOnce({
            name: "Canal B",
            youtubeHandle: "@canalb",
            avatarPath: null,
        });
        vi.mocked(findChannelByYoutubeHandle).mockResolvedValueOnce(null);

        await expect(ensureChannelCanBeCreated("Canal B", "@canalb")).resolves.toBeUndefined();
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
        vi.mocked(replaceChannelAvatar).mockResolvedValueOnce({
            deleted_paths: [],
            skipped_shared_paths: [],
            failed_paths: [],
        });

        await updateChannelAvatarWithCleanup(10, "   ");

        expect(replaceChannelAvatar).toHaveBeenCalledWith(10, null);
    });

    it("logs an orphan warning when the backend could not delete the previous avatar", async () => {
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
        vi.mocked(deleteChannelWithArtifacts).mockResolvedValueOnce({
            deleted_paths: ["thumbnails/avatar_a.png", "video/a.mp4"],
            skipped_shared_paths: [],
            failed_paths: [],
        });

        await expect(deleteChannelWithThumbnailCleanup(10)).resolves.toBe(0);

        expect(deleteChannelWithArtifacts).toHaveBeenCalledWith(10);
        expect(logError).not.toHaveBeenCalled();
    });

    it("logs an orphan warning when the backend reports files it could not delete", async () => {
        vi.mocked(deleteChannelWithArtifacts).mockResolvedValueOnce({
            deleted_paths: [],
            skipped_shared_paths: [],
            failed_paths: ["thumbnails/avatar_a.png"],
        });

        await expect(deleteChannelWithThumbnailCleanup(10)).resolves.toBe(1);

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

describe("updateChannelNameHandle", () => {
    beforeEach(() => {
        vi.mocked(validateCreateChannelInput).mockImplementation((input) => ({
            name: input.name.trim(),
            youtubeHandle: input.youtubeHandle.trim(),
            avatarPath: null,
        }));
        vi.mocked(getChannelById).mockResolvedValue({
            id: 2,
            name: "foo",
            youtube_handle: "@foo",
            avatar_path: null,
            created_at: "2026-01-01 00:00:00",
        });
    });

    it("renames a channel that keeps its handle without asking who else holds it", async () => {
        // A database from before the case-insensitive rule can hold @Foo beside @foo, and the
        // lookup would answer with the other one.
        vi.mocked(findChannelByYoutubeHandle).mockResolvedValue({
            id: 1,
            name: "Foo",
            youtube_handle: "@Foo",
            avatar_path: null,
            created_at: "2026-01-01 00:00:00",
        });

        await updateChannelNameHandle(2, "Foo (second)", "@foo");

        expect(findChannelByYoutubeHandle).not.toHaveBeenCalled();
        expect(updateChannelNameAndHandle).toHaveBeenCalledWith(2, "Foo (second)", "@foo");
    });

    it("reports a channel deleted meanwhile instead of returning as if it were saved", async () => {
        vi.mocked(getChannelById).mockResolvedValueOnce(null);

        await expect(updateChannelNameHandle(2, "foo", "@foo")).rejects.toMatchObject({
            code: "CHANNEL_NOT_FOUND",
        });
        expect(updateChannelNameAndHandle).not.toHaveBeenCalled();
    });

    it("refuses a new handle another channel holds", async () => {
        vi.mocked(findChannelByYoutubeHandle).mockResolvedValue({
            id: 1,
            name: "Bar",
            youtube_handle: "@bar",
            avatar_path: null,
            created_at: "2026-01-01 00:00:00",
        });

        await expect(updateChannelNameHandle(2, "foo", "@bar")).rejects.toMatchObject({
            code: "CHANNEL_ALREADY_EXISTS",
        });
        expect(updateChannelNameAndHandle).not.toHaveBeenCalled();
    });
});
