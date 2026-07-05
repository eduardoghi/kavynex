import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "../types/media";
import { useChannels } from "./use-channels";

vi.mock("@tauri-apps/plugin-dialog", () => ({
    open: vi.fn(),
}));

vi.mock("./use-channel-actions", () => ({
    useChannelActions: vi.fn(),
}));

import { open } from "@tauri-apps/plugin-dialog";
import { useChannelActions } from "./use-channel-actions";

const mockedUseChannelActions = vi.mocked(useChannelActions);
const mockedOpen = vi.mocked(open);

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

    it("has expected initial state before any channels load", () => {
        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        expect(result.current.selectedChannelId).toBeNull();
        expect(result.current.createChannelOpen).toBe(false);
        expect(result.current.newChannelName).toBe("");
        expect(result.current.newYoutubeHandle).toBe("");
        expect(result.current.newChannelAvatarMode).toBe("none");
        expect(result.current.newChannelAvatarPath).toBe("");
        expect(result.current.editChannelOpen).toBe(false);
        expect(result.current.editingChannel).toBeNull();
        expect(result.current.editChannelName).toBe("");
        expect(result.current.editYoutubeHandle).toBe("");
        expect(result.current.confirmDeleteChannelOpen).toBe(false);
        expect(result.current.channelToDelete).toBeNull();
    });

    it("computes selectedChannel from channels and selectedChannelId", async () => {
        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        await waitFor(() => {
            expect(result.current.channels).toEqual([channelA]);
        });

        expect(result.current.selectedChannel).toBeNull();

        act(() => {
            result.current.setSelectedChannelId(10);
        });

        expect(result.current.selectedChannel).toEqual(channelA);
    });

    it("selects channel avatar via dialog", async () => {
        mockedOpen.mockResolvedValueOnce("  C:/avatar.png  ");

        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        await act(async () => {
            await result.current.pickChannelAvatarViaDialog();
        });

        expect(mockedOpen).toHaveBeenCalledWith({
            multiple: false,
            directory: false,
            filters: [
                {
                    name: "Images",
                    extensions: ["png", "jpg", "jpeg", "webp", "bmp", "avif"],
                },
            ],
        });
        expect(result.current.newChannelAvatarMode).toBe("manual");
        expect(result.current.newChannelAvatarPath).toBe("C:/avatar.png");
    });

    it("does nothing when avatar dialog is cancelled", async () => {
        mockedOpen.mockResolvedValueOnce(null);

        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        await act(async () => {
            await result.current.pickChannelAvatarViaDialog();
        });

        expect(result.current.newChannelAvatarMode).toBe("none");
        expect(result.current.newChannelAvatarPath).toBe("");
    });

    it("does nothing when avatar dialog returns only whitespace", async () => {
        mockedOpen.mockResolvedValueOnce("   ");

        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        await act(async () => {
            await result.current.pickChannelAvatarViaDialog();
        });

        expect(result.current.newChannelAvatarMode).toBe("none");
        expect(result.current.newChannelAvatarPath).toBe("");
    });

    it("reports error when avatar dialog fails", async () => {
        mockedOpen.mockRejectedValueOnce(new Error("boom"));
        const onError = vi.fn();

        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError,
            })
        );

        await act(async () => {
            await result.current.pickChannelAvatarViaDialog();
        });

        expect(onError).toHaveBeenCalledWith("Failed to select avatar file.");
    });

    it("uses the latest onError callback for the avatar dialog after a rerender", async () => {
        mockedOpen.mockRejectedValueOnce(new Error("boom"));
        const initialOnError = vi.fn();
        const nextOnError = vi.fn();

        const { result, rerender } = renderHook(
            ({ onError }: { onError: (message: string) => void }) =>
                useChannels({ libraryPath: "/library", onError }),
            { initialProps: { onError: initialOnError } }
        );

        rerender({ onError: nextOnError });

        await act(async () => {
            await result.current.pickChannelAvatarViaDialog();
        });

        expect(nextOnError).toHaveBeenCalledWith("Failed to select avatar file.");
        expect(initialOnError).not.toHaveBeenCalled();
    });

    it("updates channel avatar from file dialog selection", async () => {
        mockedOpen.mockResolvedValueOnce("  C:/new-avatar.png  ");

        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        await act(async () => {
            await result.current.updateChannelAvatarFromFile(channelA);
        });

        expect(mockedOpen).toHaveBeenCalledWith({
            multiple: false,
            directory: false,
            filters: [
                {
                    name: "Images",
                    extensions: ["png", "jpg", "jpeg", "webp", "bmp", "avif"],
                },
            ],
        });
        expect(updateChannelAvatarAction).toHaveBeenCalledWith(
            channelA,
            "manual",
            "C:/new-avatar.png"
        );
    });

    it("does not update channel avatar when file dialog is cancelled", async () => {
        mockedOpen.mockResolvedValueOnce(null);

        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        await act(async () => {
            await result.current.updateChannelAvatarFromFile(channelA);
        });

        expect(updateChannelAvatarAction).not.toHaveBeenCalled();
    });

    it("does not update channel avatar when file dialog returns only whitespace", async () => {
        mockedOpen.mockResolvedValueOnce("   ");

        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        await act(async () => {
            await result.current.updateChannelAvatarFromFile(channelA);
        });

        expect(updateChannelAvatarAction).not.toHaveBeenCalled();
    });

    it("reports error when updating channel avatar from file fails", async () => {
        mockedOpen.mockRejectedValueOnce(new Error("boom"));
        const onError = vi.fn();

        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError,
            })
        );

        await act(async () => {
            await result.current.updateChannelAvatarFromFile(channelA);
        });

        expect(onError).toHaveBeenCalledWith("Failed to select avatar file.");
        expect(updateChannelAvatarAction).not.toHaveBeenCalled();
    });

    it("uses the latest onError callback for file avatar updates after a rerender", async () => {
        mockedOpen.mockRejectedValueOnce(new Error("boom"));
        const initialOnError = vi.fn();
        const nextOnError = vi.fn();

        const { result, rerender } = renderHook(
            ({ onError }: { onError: (message: string) => void }) =>
                useChannels({ libraryPath: "/library", onError }),
            { initialProps: { onError: initialOnError } }
        );

        rerender({ onError: nextOnError });

        await act(async () => {
            await result.current.updateChannelAvatarFromFile(channelA);
        });

        expect(nextOnError).toHaveBeenCalledWith("Failed to select avatar file.");
        expect(initialOnError).not.toHaveBeenCalled();
    });

    it("updates channel avatar from youtube", async () => {
        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        await act(async () => {
            await result.current.updateChannelAvatarFromYouTube(channelA);
        });

        expect(updateChannelAvatarAction).toHaveBeenCalledWith(channelA, "youtube");
    });

    it("uses the latest channelActions for youtube avatar updates after a rerender", async () => {
        const secondUpdateAction = vi.fn();
        let renderCount = 0;

        mockedUseChannelActions.mockImplementation((options) => {
            renderCount += 1;

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
                updateChannelAvatarAction:
                    renderCount === 1 ? updateChannelAvatarAction : secondUpdateAction,
            };
        });

        const { result, rerender } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        rerender();

        await act(async () => {
            await result.current.updateChannelAvatarFromYouTube(channelA);
        });

        expect(secondUpdateAction).toHaveBeenCalledWith(channelA, "youtube");
        expect(updateChannelAvatarAction).not.toHaveBeenCalled();
    });

    it("removes channel avatar", async () => {
        const { result } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        await act(async () => {
            await result.current.removeChannelAvatar(channelA);
        });

        expect(updateChannelAvatarAction).toHaveBeenCalledWith(channelA, "none");
    });

    it("uses the latest channelActions for avatar removal after a rerender", async () => {
        const secondUpdateAction = vi.fn();
        let renderCount = 0;

        mockedUseChannelActions.mockImplementation((options) => {
            renderCount += 1;

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
                updateChannelAvatarAction:
                    renderCount === 1 ? updateChannelAvatarAction : secondUpdateAction,
            };
        });

        const { result, rerender } = renderHook(() =>
            useChannels({
                libraryPath: "/library",
                onError: vi.fn(),
            })
        );

        rerender();

        await act(async () => {
            await result.current.removeChannelAvatar(channelA);
        });

        expect(secondUpdateAction).toHaveBeenCalledWith(channelA, "none");
        expect(updateChannelAvatarAction).not.toHaveBeenCalled();
    });

    it("keeps delete modal open when isDeletingChannel is true", async () => {
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

        mockedUseChannelActions.mockImplementation((options) => {
            return {
                isLoadingChannels: false,
                isCreatingChannel: false,
                isDeletingChannel: true,
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

        act(() => {
            result.current.setNewChannelName("force rerender");
        });

        expect(result.current.isDeletingChannel).toBe(true);

        act(() => {
            result.current.closeDeleteChannelModal();
        });

        expect(result.current.confirmDeleteChannelOpen).toBe(true);
        expect(result.current.channelToDelete).toEqual(channelA);
    });

    it("resets state and reloads channels when libraryPath changes", async () => {
        const { result, rerender } = renderHook(
            ({ libraryPath }: { libraryPath: string }) =>
                useChannels({
                    libraryPath,
                    onError: vi.fn(),
                }),
            { initialProps: { libraryPath: "/library" } }
        );

        await waitFor(() => {
            expect(result.current.channels).toEqual([channelA]);
        });

        act(() => {
            result.current.setSelectedChannelId(10);
            result.current.setCreateChannelOpen(true);
            result.current.setNewChannelName("Canal A");
        });

        act(() => {
            result.current.requestEditChannel(channelA);
        });

        act(() => {
            result.current.requestDeleteChannel(channelA);
        });

        rerender({ libraryPath: "/library2" });

        await waitFor(() => {
            expect(result.current.channels).toEqual([channelA]);
        });

        expect(result.current.selectedChannelId).toBeNull();
        expect(result.current.channelToDelete).toBeNull();
        expect(result.current.confirmDeleteChannelOpen).toBe(false);
        expect(result.current.createChannelOpen).toBe(false);
        expect(result.current.newChannelName).toBe("");
        expect(result.current.editChannelOpen).toBe(false);
        expect(result.current.editingChannel).toBeNull();
    });

    it("does not reset state when libraryPath is unchanged across a rerender", async () => {
        const { result, rerender } = renderHook(
            ({ libraryPath }: { libraryPath: string }) =>
                useChannels({
                    libraryPath,
                    onError: vi.fn(),
                }),
            { initialProps: { libraryPath: "/library" } }
        );

        await waitFor(() => {
            expect(result.current.channels).toEqual([channelA]);
        });

        act(() => {
            result.current.setSelectedChannelId(10);
        });

        rerender({ libraryPath: "/library" });

        expect(result.current.selectedChannelId).toBe(10);
        expect(result.current.channels).toEqual([channelA]);
    });

    it("resets selectedChannelId when the selected channel is removed from the list", async () => {
        let capturedSetChannels: React.Dispatch<React.SetStateAction<Channel[]>> | null =
            null;

        mockedUseChannelActions.mockImplementation((options) => {
            capturedSetChannels = options.setChannels;

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
            result.current.setSelectedChannelId(10);
        });

        expect(result.current.selectedChannelId).toBe(10);

        act(() => {
            capturedSetChannels?.([]);
        });

        await waitFor(() => {
            expect(result.current.selectedChannelId).toBeNull();
        });
    });

    it("keeps selectedChannelId when the selected channel remains in the list", async () => {
        let capturedSetChannels: React.Dispatch<React.SetStateAction<Channel[]>> | null =
            null;

        mockedUseChannelActions.mockImplementation((options) => {
            capturedSetChannels = options.setChannels;

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
            result.current.setSelectedChannelId(10);
        });

        act(() => {
            capturedSetChannels?.([channelA]);
        });

        expect(result.current.selectedChannelId).toBe(10);
    });

    it("closes edit modal when the editing channel is removed from the list", async () => {
        let capturedSetChannels: React.Dispatch<React.SetStateAction<Channel[]>> | null =
            null;

        mockedUseChannelActions.mockImplementation((options) => {
            capturedSetChannels = options.setChannels;

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

        act(() => {
            capturedSetChannels?.([]);
        });

        await waitFor(() => {
            expect(result.current.editChannelOpen).toBe(false);
        });

        expect(result.current.editingChannel).toBeNull();
    });

    it("keeps edit modal open when the editing channel remains in the list", async () => {
        let capturedSetChannels: React.Dispatch<React.SetStateAction<Channel[]>> | null =
            null;

        mockedUseChannelActions.mockImplementation((options) => {
            capturedSetChannels = options.setChannels;

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
            capturedSetChannels?.([channelA]);
        });

        expect(result.current.editChannelOpen).toBe(true);
        expect(result.current.editingChannel).toEqual(channelA);
    });
});