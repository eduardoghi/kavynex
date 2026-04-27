import { describe, expect, it, vi } from "vitest";
import { executeDeleteSelectedChannel } from "./delete-selected-channel";

describe("executeDeleteSelectedChannel", () => {
    it("cleans selected channel UI before deleting when the selected channel is being deleted", async () => {
        const closeSelectedChannelUiBeforeDelete = vi.fn().mockResolvedValue(undefined);
        const confirmDeleteChannel = vi.fn().mockResolvedValue(undefined);

        await executeDeleteSelectedChannel({
            selectedChannelId: 10,
            channelToDeleteId: 10,
            closeSelectedChannelUiBeforeDelete,
            confirmDeleteChannel,
        });

        expect(closeSelectedChannelUiBeforeDelete).toHaveBeenCalled();
        expect(confirmDeleteChannel).toHaveBeenCalled();
    });

    it("deletes directly when another channel is selected", async () => {
        const closeSelectedChannelUiBeforeDelete = vi.fn().mockResolvedValue(undefined);
        const confirmDeleteChannel = vi.fn().mockResolvedValue(undefined);

        await executeDeleteSelectedChannel({
            selectedChannelId: 10,
            channelToDeleteId: 20,
            closeSelectedChannelUiBeforeDelete,
            confirmDeleteChannel,
        });

        expect(closeSelectedChannelUiBeforeDelete).not.toHaveBeenCalled();
        expect(confirmDeleteChannel).toHaveBeenCalled();
    });

    it("deletes directly when there is no selected channel", async () => {
        const closeSelectedChannelUiBeforeDelete = vi.fn().mockResolvedValue(undefined);
        const confirmDeleteChannel = vi.fn().mockResolvedValue(undefined);

        await executeDeleteSelectedChannel({
            selectedChannelId: null,
            channelToDeleteId: 20,
            closeSelectedChannelUiBeforeDelete,
            confirmDeleteChannel,
        });

        expect(closeSelectedChannelUiBeforeDelete).not.toHaveBeenCalled();
        expect(confirmDeleteChannel).toHaveBeenCalled();
    });
});