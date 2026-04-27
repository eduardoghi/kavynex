import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services", () => ({
    createChannel: vi.fn(),
}));

import { createChannel } from "../services";
import { executeCreateChannel } from "./create-channel";

const createChannelMock = vi.mocked(createChannel);

describe("executeCreateChannel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("creates channel, reloads list, selects created channel and resets form", async () => {
        const reloadChannels = vi.fn().mockResolvedValue(undefined);
        const selectChannel = vi.fn();
        const resetForm = vi.fn();

        createChannelMock.mockResolvedValueOnce(42);

        await executeCreateChannel({
            input: {
                name: "Canal Teste",
                youtubeHandle: "@canalteste",
            },
            reloadChannels,
            selectChannel,
            resetForm,
        });

        expect(createChannelMock).toHaveBeenCalledWith(
            "Canal Teste",
            "@canalteste",
            null
        );
        expect(reloadChannels).toHaveBeenCalled();
        expect(selectChannel).toHaveBeenCalledWith(42);
        expect(resetForm).toHaveBeenCalled();
    });

    it("still selects null when service does not return created id", async () => {
        const reloadChannels = vi.fn().mockResolvedValue(undefined);
        const selectChannel = vi.fn();
        const resetForm = vi.fn();

        createChannelMock.mockResolvedValueOnce(null);

        await executeCreateChannel({
            input: {
                name: "Canal Teste",
                youtubeHandle: "@canalteste",
            },
            reloadChannels,
            selectChannel,
            resetForm,
        });

        expect(selectChannel).toHaveBeenCalledWith(null);
    });
});