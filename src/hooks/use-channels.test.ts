import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChannels } from "./use-channels";

vi.mock("@tauri-apps/plugin-dialog", () => ({
    open: vi.fn(),
}));

vi.mock("./use-channel-actions", () => ({
    useChannelActions: vi.fn(),
}));

import { useChannelActions } from "./use-channel-actions";

const mockedUseChannelActions = vi.mocked(useChannelActions);

const channelA = {
    id: 10,
    name: "Canal A",
    youtube_handle: "@canala",
    avatar_path: null,
    created_at: "2026-03-31T10:00:00.000Z",
};

describe("useChannels", () => {
    const createChannelAction = vi.fn();
    const updateChannelIdentityAction = vi.fn();
    const confirmDeleteChannelAction = vi.fn();
    const updateChannelAvatarAction = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();

        mockedUseChannelActions.mockImplementation((options) => {
            return {
                isLoadingChannels: false,
                isCreatingChannel: false,
                isDeletingChannel: false,
                isUpdatingChannelAvatar: false,
                isEditingChannel: false,
                loadChannels: vi.fn(async () => {
                    options.setChannels([channelA]);
                }),
                createChannelAction,
                updateChannelIdentityAction,
                confirmDeleteChannelAction,
                updateChannelAvatarAction,
            };
        });
    });

    it("loads channels on mount", async () => {
        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        await waitFor(() => {
            expect(result.current.channels).toEqual([channelA]);
        });
    });

    it("resets create channel form when modal closes", () => {
        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        act(() => {
            result.current.setCreateChannelOpen(true);
            result.current.setNewChannelName("Canal A");
            result.current.setNewYoutubeHandle("@canala");
            result.current.setNewChannelAvatarMode("manual");
            result.current.setNewChannelAvatarPath("C:/avatar.png");
        });

        act(() => {
            result.current.setCreateChannelOpen(false);
        });

        expect(result.current.newChannelName).toBe("");
        expect(result.current.newYoutubeHandle).toBe("");
        expect(result.current.newChannelAvatarMode).toBe("none");
        expect(result.current.newChannelAvatarPath).toBe("");
    });

    it("opens edit modal with selected channel data", async () => {
        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        await waitFor(() => {
            expect(result.current.channels).toEqual([channelA]);
        });

        act(() => {
            result.current.requestEditChannel(channelA);
        });

        expect(result.current.editChannelOpen).toBe(true);
        expect(result.current.editingChannel).toEqual(channelA);
        expect(result.current.editChannelName).toBe("Canal A");
        expect(result.current.editYoutubeHandle).toBe("@canala");
    });

    it("closes edit modal and resets form", async () => {
        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        await waitFor(() => {
            expect(result.current.channels).toEqual([channelA]);
        });

        act(() => {
            result.current.requestEditChannel(channelA);
        });

        act(() => {
            result.current.setEditChannelOpen(false);
        });

        expect(result.current.editChannelOpen).toBe(false);
        expect(result.current.editingChannel).toBeNull();
        expect(result.current.editChannelName).toBe("");
        expect(result.current.editYoutubeHandle).toBe("");
    });

    it("calls update channel identity action with current edit form values", async () => {
        updateChannelIdentityAction.mockResolvedValueOnce(true);

        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        await waitFor(() => {
            expect(result.current.channels).toEqual([channelA]);
        });

        act(() => {
            result.current.requestEditChannel(channelA);
            result.current.setEditChannelName("Canal Editado");
            result.current.setEditYoutubeHandle("@canaleditado");
        });

        await act(async () => {
            await result.current.saveEditedChannel();
        });

        expect(updateChannelIdentityAction).toHaveBeenCalledWith(
            10,
            "Canal Editado",
            "@canaleditado"
        );
        expect(result.current.editChannelOpen).toBe(false);
        expect(result.current.editingChannel).toBeNull();
    });

    it("keeps edit modal open when update channel identity fails", async () => {
        updateChannelIdentityAction.mockResolvedValueOnce(false);

        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        await waitFor(() => {
            expect(result.current.channels).toEqual([channelA]);
        });

        act(() => {
            result.current.requestEditChannel(channelA);
            result.current.setEditChannelName("Canal Editado");
            result.current.setEditYoutubeHandle("@canaleditado");
        });

        await act(async () => {
            await result.current.saveEditedChannel();
        });

        expect(updateChannelIdentityAction).toHaveBeenCalledWith(
            10,
            "Canal Editado",
            "@canaleditado"
        );
        expect(result.current.editChannelOpen).toBe(true);
        expect(result.current.editingChannel).toEqual(channelA);
        expect(result.current.editChannelName).toBe("Canal Editado");
        expect(result.current.editYoutubeHandle).toBe("@canaleditado");
    });

    it("opens delete modal with selected channel", () => {
        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        act(() => {
            result.current.requestDeleteChannel(channelA);
        });

        expect(result.current.confirmDeleteChannelOpen).toBe(true);
        expect(result.current.channelToDelete).toEqual(channelA);
    });

    it("closes delete modal when not deleting", () => {
        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        act(() => {
            result.current.requestDeleteChannel(channelA);
        });

        act(() => {
            result.current.closeDeleteChannelModal();
        });

        expect(result.current.confirmDeleteChannelOpen).toBe(false);
        expect(result.current.channelToDelete).toBeNull();
    });

    it("calls create channel action with current form values", async () => {
        createChannelAction.mockResolvedValueOnce(true);

        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        act(() => {
            result.current.setCreateChannelOpen(true);
            result.current.setNewChannelName("Canal A");
            result.current.setNewYoutubeHandle("@canala");
        });

        await act(async () => {
            await result.current.createChannel();
        });

        expect(createChannelAction).toHaveBeenCalledWith(
            "Canal A",
            "@canala",
            "none",
            ""
        );
        expect(result.current.createChannelOpen).toBe(false);
    });

    it("keeps create modal open when create channel fails", async () => {
        createChannelAction.mockResolvedValueOnce(false);

        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        act(() => {
            result.current.setCreateChannelOpen(true);
            result.current.setNewChannelName("Canal A");
            result.current.setNewYoutubeHandle("@canala");
        });

        await act(async () => {
            await result.current.createChannel();
        });

        expect(createChannelAction).toHaveBeenCalledWith(
            "Canal A",
            "@canala",
            "none",
            ""
        );
        expect(result.current.createChannelOpen).toBe(true);
        expect(result.current.newChannelName).toBe("Canal A");
        expect(result.current.newYoutubeHandle).toBe("@canala");
    });

    it("calls create channel action with manual avatar values", async () => {
        createChannelAction.mockResolvedValueOnce(true);

        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        act(() => {
            result.current.setCreateChannelOpen(true);
            result.current.setNewChannelName("Canal A");
            result.current.setNewYoutubeHandle("@canala");
            result.current.setNewChannelAvatarMode("manual");
            result.current.setNewChannelAvatarPath("C:/avatar.png");
        });

        await act(async () => {
            await result.current.createChannel();
        });

        expect(createChannelAction).toHaveBeenCalledWith(
            "Canal A",
            "@canala",
            "manual",
            "C:/avatar.png"
        );
    });

    it("clears avatar path manually", () => {
        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        act(() => {
            result.current.setNewChannelAvatarPath("C:/avatar.png");
        });

        act(() => {
            result.current.clearNewChannelAvatarPath();
        });

        expect(result.current.newChannelAvatarPath).toBe("");
    });
});