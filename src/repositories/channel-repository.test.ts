import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";
import { TAURI_COMMANDS } from "../constants/tauri-commands";
import {
    countChannelsUsingAvatarPathOutsideChannel,
    countMediaUsingFilePathOutsideChannel,
    countMediaUsingThumbnailOutsideChannel,
    deleteChannelById,
    findChannelByYoutubeHandle,
    getChannelAvatarPathByChannelId,
    getChannelById,
    insertChannel,
    listChannels,
    listDistinctFilePathsByChannelId,
    listDistinctThumbnailPathsByChannelId,
    updateChannelAvatarPath,
    updateChannelNameAndHandle,
} from "./channel-repository";

vi.mock("../lib/tauri-client", () => ({
    invokeCommand: vi.fn(),
    invokeVoid: vi.fn(),
}));

vi.mock("../lib/schema-bridge", () => ({
    ensureSchemaReady: vi.fn().mockResolvedValue(undefined),
}));

const invokeCommandMock = vi.mocked(invokeCommand);
const invokeVoidMock = vi.mocked(invokeVoid);

beforeEach(() => {
    vi.clearAllMocks();
    invokeCommandMock.mockResolvedValue(undefined as never);
    invokeVoidMock.mockResolvedValue(undefined);
});

describe("channel-repository command wiring", () => {
    it("listChannels invokes the list command and returns rows", async () => {
        const rows = [{ id: 1, name: "A", youtube_handle: "@a", avatar_path: null, created_at: "t" }];
        invokeCommandMock.mockResolvedValueOnce(rows as never);

        await expect(listChannels()).resolves.toBe(rows);
        expect(invokeCommandMock).toHaveBeenCalledWith(TAURI_COMMANDS.LIST_CHANNELS);
    });

    it("findChannelByYoutubeHandle passes the handle", async () => {
        await findChannelByYoutubeHandle("@alice");
        expect(invokeCommandMock).toHaveBeenCalledWith(
            TAURI_COMMANDS.FIND_CHANNEL_BY_YOUTUBE_HANDLE,
            { youtubeHandle: "@alice" }
        );
    });

    it("getChannelById passes the id", async () => {
        await getChannelById(7);
        expect(invokeCommandMock).toHaveBeenCalledWith(TAURI_COMMANDS.GET_CHANNEL_BY_ID, {
            channelId: 7,
        });
    });

    it("insertChannel passes name, handle and avatar and returns the id", async () => {
        invokeCommandMock.mockResolvedValueOnce(42 as never);

        await expect(insertChannel("Alice", "@alice", "thumbnails/a.jpg")).resolves.toBe(42);
        expect(invokeCommandMock).toHaveBeenCalledWith(TAURI_COMMANDS.INSERT_CHANNEL, {
            name: "Alice",
            youtubeHandle: "@alice",
            avatarPath: "thumbnails/a.jpg",
        });
    });

    it("updateChannelNameAndHandle passes all fields", async () => {
        await updateChannelNameAndHandle(3, "New", "@new");
        expect(invokeVoidMock).toHaveBeenCalledWith(
            TAURI_COMMANDS.UPDATE_CHANNEL_NAME_AND_HANDLE,
            { channelId: 3, name: "New", youtubeHandle: "@new" }
        );
    });

    it("updateChannelAvatarPath passes null to clear the avatar", async () => {
        await updateChannelAvatarPath(3, null);
        expect(invokeVoidMock).toHaveBeenCalledWith(TAURI_COMMANDS.UPDATE_CHANNEL_AVATAR_PATH, {
            channelId: 3,
            avatarPath: null,
        });
    });

    it("deleteChannelById passes the id", async () => {
        await deleteChannelById(9);
        expect(invokeVoidMock).toHaveBeenCalledWith(TAURI_COMMANDS.DELETE_CHANNEL_BY_ID, {
            channelId: 9,
        });
    });

    it("listDistinctThumbnailPathsByChannelId returns the command result", async () => {
        invokeCommandMock.mockResolvedValueOnce(["a.jpg"] as never);

        await expect(listDistinctThumbnailPathsByChannelId(1)).resolves.toEqual(["a.jpg"]);
        expect(invokeCommandMock).toHaveBeenCalledWith(
            TAURI_COMMANDS.LIST_DISTINCT_THUMBNAIL_PATHS_BY_CHANNEL_ID,
            { channelId: 1 }
        );
    });

    it("listDistinctFilePathsByChannelId returns the command result", async () => {
        invokeCommandMock.mockResolvedValueOnce(["video/a.mp4"] as never);

        await expect(listDistinctFilePathsByChannelId(1)).resolves.toEqual(["video/a.mp4"]);
        expect(invokeCommandMock).toHaveBeenCalledWith(
            TAURI_COMMANDS.LIST_DISTINCT_FILE_PATHS_BY_CHANNEL_ID,
            { channelId: 1 }
        );
    });

    it("getChannelAvatarPathByChannelId returns the command result", async () => {
        invokeCommandMock.mockResolvedValueOnce("thumbnails/a.jpg" as never);

        await expect(getChannelAvatarPathByChannelId(1)).resolves.toBe("thumbnails/a.jpg");
        expect(invokeCommandMock).toHaveBeenCalledWith(
            TAURI_COMMANDS.GET_CHANNEL_AVATAR_PATH_BY_CHANNEL_ID,
            { channelId: 1 }
        );
    });

    it("countChannelsUsingAvatarPathOutsideChannel passes path and id", async () => {
        invokeCommandMock.mockResolvedValueOnce(1 as never);

        await expect(
            countChannelsUsingAvatarPathOutsideChannel("shared.jpg", 5)
        ).resolves.toBe(1);
        expect(invokeCommandMock).toHaveBeenCalledWith(
            TAURI_COMMANDS.COUNT_CHANNELS_USING_AVATAR_PATH_OUTSIDE_CHANNEL,
            { avatarPath: "shared.jpg", channelId: 5 }
        );
    });

    it("countMediaUsingThumbnailOutsideChannel passes path and id", async () => {
        invokeCommandMock.mockResolvedValueOnce(2 as never);

        await expect(
            countMediaUsingThumbnailOutsideChannel("thumb/shared.jpg", 5)
        ).resolves.toBe(2);
        expect(invokeCommandMock).toHaveBeenCalledWith(
            TAURI_COMMANDS.COUNT_MEDIA_USING_THUMBNAIL_OUTSIDE_CHANNEL,
            { thumbnailPath: "thumb/shared.jpg", channelId: 5 }
        );
    });

    it("countMediaUsingFilePathOutsideChannel passes path and id", async () => {
        invokeCommandMock.mockResolvedValueOnce(3 as never);

        await expect(
            countMediaUsingFilePathOutsideChannel("video/shared.mp4", 5)
        ).resolves.toBe(3);
        expect(invokeCommandMock).toHaveBeenCalledWith(
            TAURI_COMMANDS.COUNT_MEDIA_USING_FILE_PATH_OUTSIDE_CHANNEL,
            { filePath: "video/shared.mp4", channelId: 5 }
        );
    });
});
