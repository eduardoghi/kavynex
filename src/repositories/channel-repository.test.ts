import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";
import { TAURI_COMMANDS } from "../constants/tauri-commands";
import {
    countChannelsUsingAvatarPathOutsideChannel,
    deleteChannelWithArtifacts,
    findChannelByYoutubeHandle,
    getChannelById,
    insertChannel,
    listChannels,
    updateChannelAvatarPath,
    updateChannelNameAndHandle,
} from "./channel-repository";

vi.mock("../lib/tauri-client", () => ({
    invokeCommand: vi.fn(),
    invokeVoid: vi.fn(),
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

    it("deleteChannelWithArtifacts passes the id and returns the cleanup report", async () => {
        const report = {
            deleted_paths: ["thumbnails/a.jpg"],
            skipped_shared_paths: [],
            failed_paths: [],
        };
        invokeCommandMock.mockResolvedValueOnce(report as never);

        await expect(deleteChannelWithArtifacts(9)).resolves.toBe(report);
        expect(invokeCommandMock).toHaveBeenCalledWith(
            TAURI_COMMANDS.DELETE_CHANNEL_WITH_ARTIFACTS,
            { channelId: 9 }
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

});
