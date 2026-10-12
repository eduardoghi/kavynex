import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/channel-service", () => ({
    createChannel: vi.fn(),
    ensureChannelCanBeCreated: vi.fn(),
}));

vi.mock("../services/thumbnail-service", () => ({
    persistThumbnailFile: vi.fn(),
    downloadChannelAvatarFromHandle: vi.fn(),
}));

import { createChannel, ensureChannelCanBeCreated } from "../services/channel-service";
import {
    downloadChannelAvatarFromHandle,
    persistThumbnailFile,
} from "../services/thumbnail-service";
import { executeCreateChannel } from "./create-channel";

describe("executeCreateChannel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("creates a channel without an avatar", async () => {
        vi.mocked(createChannel).mockResolvedValueOnce(42);

        const result = await executeCreateChannel("Canal Teste", "@canalteste", { mode: "none" });

        expect(ensureChannelCanBeCreated).toHaveBeenCalledWith("Canal Teste", "@canalteste");
        expect(createChannel).toHaveBeenCalledWith("Canal Teste", "@canalteste", null);
        expect(result).toEqual({ channelId: 42, avatarFailure: null });
    });

    it("stores a picked avatar in the library and creates the channel with it", async () => {
        vi.mocked(persistThumbnailFile).mockResolvedValueOnce("thumbnails/avatar.jpg");
        vi.mocked(createChannel).mockResolvedValueOnce(7);

        await executeCreateChannel("Canal", "@canal", {
            mode: "manual",
            sourcePath: "C:/pictures/avatar.jpg",
        });

        expect(persistThumbnailFile).toHaveBeenCalledWith("C:/pictures/avatar.jpg");
        expect(createChannel).toHaveBeenCalledWith("Canal", "@canal", "thumbnails/avatar.jpg");
    });

    it("refuses a duplicate before writing or downloading the avatar", async () => {
        vi.mocked(ensureChannelCanBeCreated).mockRejectedValueOnce(
            new Error("channel already exists")
        );

        await expect(
            executeCreateChannel("Canal", "@canal", { mode: "youtube" })
        ).rejects.toThrow("channel already exists");

        expect(downloadChannelAvatarFromHandle).not.toHaveBeenCalled();
        expect(createChannel).not.toHaveBeenCalled();
    });

    it("creates the channel without an avatar when the YouTube avatar cannot be downloaded", async () => {
        const failure = new Error("network unreachable");
        vi.mocked(downloadChannelAvatarFromHandle).mockRejectedValueOnce(failure);
        vi.mocked(createChannel).mockResolvedValueOnce(9);

        const result = await executeCreateChannel("Canal", "@canal", {
            mode: "youtube",
        });

        expect(createChannel).toHaveBeenCalledWith("Canal", "@canal", null);
        expect(result).toEqual({ channelId: 9, avatarFailure: failure });
    });

    it("does not create the channel when a picked avatar cannot be stored", async () => {
        // The user chose that file, so creating the channel without it would drop what they asked
        // for without saying so.
        vi.mocked(persistThumbnailFile).mockRejectedValueOnce(new Error("disk full"));

        await expect(
            executeCreateChannel("Canal", "@canal", {
                mode: "manual",
                sourcePath: "C:/pictures/avatar.jpg",
            })
        ).rejects.toThrow("disk full");

        expect(createChannel).not.toHaveBeenCalled();
    });
});
