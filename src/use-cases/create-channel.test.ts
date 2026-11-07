import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/channel-service", () => ({
    createChannel: vi.fn(),
    ensureChannelCanBeCreated: vi.fn(),
    updateChannelImageWithCleanup: vi.fn(),
}));

// One download per image, so each test can set up and check the avatar and the banner apart.
const { downloadAvatar, downloadBanner } = vi.hoisted(() => ({
    downloadAvatar: vi.fn(),
    downloadBanner: vi.fn(),
}));

vi.mock("../services/thumbnail-service", () => ({
    persistThumbnailFile: vi.fn(),
    downloadChannelImageFromHandle: vi.fn((kind: string, handle: string) =>
        kind === "avatar" ? downloadAvatar(handle) : downloadBanner(handle)
    ),
}));

import {
    createChannel,
    ensureChannelCanBeCreated,
    updateChannelImageWithCleanup,
} from "../services/channel-service";
import { persistThumbnailFile } from "../services/thumbnail-service";
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
        expect(result).toEqual({ channelId: 42, avatarFailure: null, bannerFailure: null });
        // The banner comes with the YouTube avatar only.
        expect(downloadBanner).not.toHaveBeenCalled();
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

        expect(downloadAvatar).not.toHaveBeenCalled();
        expect(createChannel).not.toHaveBeenCalled();
    });

    it("creates the channel without an avatar when the YouTube avatar cannot be downloaded", async () => {
        const failure = new Error("network unreachable");
        vi.mocked(downloadAvatar).mockRejectedValueOnce(failure);
        vi.mocked(createChannel).mockResolvedValueOnce(9);

        const result = await executeCreateChannel("Canal", "@canal", {
            mode: "youtube",
        });

        expect(createChannel).toHaveBeenCalledWith("Canal", "@canal", null);
        expect(result).toEqual({ channelId: 9, avatarFailure: failure, bannerFailure: null });
        // The banner would fail for the same reason, after a wait of its own.
        expect(downloadBanner).not.toHaveBeenCalled();
    });

    it("sets the banner after creating a channel with its YouTube avatar", async () => {
        vi.mocked(downloadAvatar).mockResolvedValueOnce("thumbnails/a.jpg");
        vi.mocked(downloadBanner).mockResolvedValueOnce("thumbnails/b.jpg");
        vi.mocked(createChannel).mockResolvedValueOnce(5);

        const result = await executeCreateChannel("Canal", "@canal", { mode: "youtube" });

        expect(updateChannelImageWithCleanup).toHaveBeenCalledWith("banner", 5, "thumbnails/b.jpg");
        expect(result.bannerFailure).toBeNull();
    });

    it("treats a channel with no banner as nothing to report", async () => {
        vi.mocked(downloadBanner).mockRejectedValueOnce({
            code: "CHANNEL_BANNER_NOT_FOUND",
            message: "the channel page lists no banner",
        });
        vi.mocked(createChannel).mockResolvedValueOnce(6);

        const result = await executeCreateChannel("Canal", "@canal", { mode: "youtube" });

        expect(result.channelId).toBe(6);
        expect(result.bannerFailure).toBeNull();
        expect(updateChannelImageWithCleanup).not.toHaveBeenCalled();
    });

    it("keeps the channel when its banner cannot be downloaded", async () => {
        const failure = new Error("network unreachable");
        vi.mocked(downloadBanner).mockRejectedValueOnce(failure);
        vi.mocked(createChannel).mockResolvedValueOnce(8);

        const result = await executeCreateChannel("Canal", "@canal", { mode: "youtube" });

        expect(result).toMatchObject({ channelId: 8, bannerFailure: failure });
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
