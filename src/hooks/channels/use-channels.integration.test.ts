import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "../../types/media";
import { useChannels } from "./use-channels";

// useChannels and useChannelActions together, with only the services below them faked. The unit
// tests of either hook mock the other, so the ordering between a selection and the list reload
// that holds it was invisible to both of them.

vi.mock("../../services/channel-service", () => ({
    listAllChannels: vi.fn(),
    deleteChannelWithThumbnailCleanup: vi.fn(),
    updateChannelAvatarWithCleanup: vi.fn(),
    updateChannelNameHandle: vi.fn(),
}));

vi.mock("../../use-cases/create-channel", () => ({
    executeCreateChannel: vi.fn(),
}));

vi.mock("../../services/media-service", () => ({
    listChannelMediaPage: vi.fn(),
}));

vi.mock("../../services/file-dialog-service", () => ({
    pickFile: vi.fn(),
}));

vi.mock("../../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { listAllChannels } from "../../services/channel-service";
import { listChannelMediaPage } from "../../services/media-service";
import { executeCreateChannel } from "../../use-cases/create-channel";

function channel(id: number, name: string): Channel {
    return {
        id,
        name,
        youtube_handle: `@${name.toLowerCase()}`,
        avatar_path: null,
        created_at: "2026-10-10T10:00:00.000Z",
    };
}

describe("useChannels with its real actions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(listChannelMediaPage).mockResolvedValue({ items: [], total: 0 });
    });

    it("opens the channel it just created", async () => {
        const existing = channel(1, "Existing");
        const created = channel(2, "Created");
        vi.mocked(listAllChannels).mockResolvedValueOnce([existing]);

        const { result } = renderHook(() =>
            useChannels({ libraryPath: "/library", onError: vi.fn(), onNotice: vi.fn() })
        );

        await waitFor(() => expect(result.current.channels).toHaveLength(1));

        act(() => {
            result.current.setNewChannelName("Created");
            result.current.setNewYoutubeHandle("@created");
        });

        let reload: (channels: Channel[]) => void = () => {};
        vi.mocked(listAllChannels).mockReturnValueOnce(
            new Promise((resolve) => {
                reload = resolve;
            })
        );
        vi.mocked(executeCreateChannel).mockResolvedValueOnce({
            channelId: 2,
            avatarFailure: null,
        });

        let creating: Promise<void> = Promise.resolve();
        act(() => {
            creating = result.current.createChannel();
        });

        // The list is still the old one while it reloads, which is what cleared the selection.
        await waitFor(() => expect(listAllChannels).toHaveBeenCalledTimes(2));

        await act(async () => {
            reload([existing, created]);
            await creating;
        });

        expect(result.current.selectedChannelId).toBe(2);
    });
});
