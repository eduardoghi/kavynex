import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChannelActions } from "./use-channel-actions";

vi.mock("../utils/error-message", () => ({
    resolveErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

vi.mock("../services/channel-service", () => ({
    createChannel: vi.fn(),
    deleteChannelWithThumbnailCleanup: vi.fn(),
    listAllChannels: vi.fn(),
    updateChannelAvatarWithCleanup: vi.fn(),
    updateChannelNameHandle: vi.fn(),
}));

vi.mock("../services/thumbnail-service", () => ({
    persistThumbnailFile: vi.fn(),
    downloadChannelAvatarFromHandle: vi.fn(),
    deleteThumbnailFile: vi.fn(),
}));

import {
    createChannel,
    deleteChannelWithThumbnailCleanup,
    listAllChannels,
    updateChannelAvatarWithCleanup,
    updateChannelNameHandle,
} from "../services/channel-service";
import {
    downloadChannelAvatarFromHandle,
    persistThumbnailFile,
} from "../services/thumbnail-service";

describe("useChannelActions", () => {
    const setChannels = vi.fn();
    const setSelectedChannelId = vi.fn();
    const setNewChannelName = vi.fn();
    const setNewYoutubeHandle = vi.fn();
    const setNewChannelAvatarMode = vi.fn();
    const setNewChannelAvatarPath = vi.fn();
    const setUpdatingChannelAvatarId = vi.fn();
    const setChannelToDelete = vi.fn();
    const setConfirmDeleteChannelOpen = vi.fn();
    const onError = vi.fn();
    const onChannelDeleted = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("loads channels successfully", async () => {
        vi.mocked(listAllChannels).mockResolvedValueOnce([
            {
                id: 1,
                name: "Canal A",
                youtube_handle: "@canala",
                avatar_path: null,
                created_at: "2026-03-31T10:00:00.000Z",
            },
        ]);

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onChannelDeleted,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                setUpdatingChannelAvatarId,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        await act(async () => {
            await result.current.loadChannels();
        });

        expect(listAllChannels).toHaveBeenCalledTimes(1);
        expect(setChannels).toHaveBeenCalledWith([
            {
                id: 1,
                name: "Canal A",
                youtube_handle: "@canala",
                avatar_path: null,
                created_at: "2026-03-31T10:00:00.000Z",
            },
        ]);
    });

    it("creates channel without avatar and refreshes list", async () => {
        vi.mocked(createChannel).mockResolvedValueOnce(10);
        vi.mocked(listAllChannels).mockResolvedValueOnce([
            {
                id: 10,
                name: "Canal A",
                youtube_handle: "@canala",
                avatar_path: null,
                created_at: "2026-03-31T10:00:00.000Z",
            },
        ]);

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onChannelDeleted,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                setUpdatingChannelAvatarId,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        let created = false;

        await act(async () => {
            created = await result.current.createChannelAction(
                "  Canal A  ",
                "  @canala  ",
                "none",
                ""
            );
        });

        expect(created).toBe(true);
        expect(createChannel).toHaveBeenCalledWith("Canal A", "@canala", null);
        expect(listAllChannels).toHaveBeenCalled();
        expect(setChannels).toHaveBeenCalled();
        expect(setSelectedChannelId).toHaveBeenCalledWith(10);
        expect(setNewChannelName).toHaveBeenCalledWith("");
        expect(setNewYoutubeHandle).toHaveBeenCalledWith("");
        expect(setNewChannelAvatarMode).toHaveBeenCalledWith("none");
        expect(setNewChannelAvatarPath).toHaveBeenCalledWith("");
    });

    it("creates channel with manual avatar", async () => {
        vi.mocked(persistThumbnailFile).mockResolvedValueOnce("thumbnails/avatar.png");
        vi.mocked(createChannel).mockResolvedValueOnce(10);
        vi.mocked(listAllChannels).mockResolvedValueOnce([]);

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onChannelDeleted,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                setUpdatingChannelAvatarId,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        let created = false;

        await act(async () => {
            created = await result.current.createChannelAction(
                "Canal A",
                "@canala",
                "manual",
                "C:/temp/avatar.png"
            );
        });

        expect(created).toBe(true);
        expect(persistThumbnailFile).toHaveBeenCalledWith(
            "C:/temp/avatar.png",
            "/library"
        );
        expect(createChannel).toHaveBeenCalledWith(
            "Canal A",
            "@canala",
            "thumbnails/avatar.png"
        );
    });

    it("creates channel with youtube avatar", async () => {
        vi.mocked(downloadChannelAvatarFromHandle).mockResolvedValueOnce(
            "thumbnails/youtube-avatar.png"
        );
        vi.mocked(createChannel).mockResolvedValueOnce(10);
        vi.mocked(listAllChannels).mockResolvedValueOnce([]);

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onChannelDeleted,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                setUpdatingChannelAvatarId,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        let created = false;

        await act(async () => {
            created = await result.current.createChannelAction(
                "Canal A",
                "@canala",
                "youtube",
                ""
            );
        });

        expect(created).toBe(true);
        expect(downloadChannelAvatarFromHandle).toHaveBeenCalledWith(
            "@canala",
            "/library"
        );
        expect(createChannel).toHaveBeenCalledWith(
            "Canal A",
            "@canala",
            "thumbnails/youtube-avatar.png"
        );
    });

    it("returns false when manual avatar mode has no file", async () => {
        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onChannelDeleted,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                setUpdatingChannelAvatarId,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        let created = true;

        await act(async () => {
            created = await result.current.createChannelAction(
                "Canal A",
                "@canala",
                "manual",
                ""
            );
        });

        expect(created).toBe(false);
        expect(onError).toHaveBeenCalledWith(
            "Select an avatar file before creating the channel."
        );
        expect(createChannel).not.toHaveBeenCalled();
    });

    it("returns false when create channel fails", async () => {
        vi.mocked(createChannel).mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onChannelDeleted,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                setUpdatingChannelAvatarId,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        let created = true;

        await act(async () => {
            created = await result.current.createChannelAction(
                "Canal A",
                "@canala",
                "none",
                ""
            );
        });

        expect(created).toBe(false);
        expect(onError).toHaveBeenCalledWith("Failed to create channel.");
        expect(setSelectedChannelId).not.toHaveBeenCalled();
    });

    it("returns false when manual avatar mode has no library path", async () => {
        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "",
                onError,
                onChannelDeleted,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                setUpdatingChannelAvatarId,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        let created = true;

        await act(async () => {
            created = await result.current.createChannelAction(
                "Canal A",
                "@canala",
                "manual",
                "C:/avatar.png"
            );
        });

        expect(created).toBe(false);
        expect(onError).toHaveBeenCalledWith(
            "Choose a library folder before importing a manual avatar."
        );
        expect(persistThumbnailFile).not.toHaveBeenCalled();
        expect(createChannel).not.toHaveBeenCalled();
    });

    it("returns false when youtube avatar mode has no library path", async () => {
        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "",
                onError,
                onChannelDeleted,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                setUpdatingChannelAvatarId,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        let created = true;

        await act(async () => {
            created = await result.current.createChannelAction(
                "Canal A",
                "@canala",
                "youtube",
                ""
            );
        });

        expect(created).toBe(false);
        expect(onError).toHaveBeenCalledWith(
            "Choose a library folder before importing a YouTube avatar."
        );
        expect(downloadChannelAvatarFromHandle).not.toHaveBeenCalled();
        expect(createChannel).not.toHaveBeenCalled();
    });

    it("discards a reentrant createChannelAction call while one is already running", async () => {
        vi.mocked(createChannel).mockImplementationOnce(() => new Promise(() => {}));

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onChannelDeleted,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                setUpdatingChannelAvatarId,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        act(() => {
            void result.current.createChannelAction("Canal A", "@canala", "none", "");
        });

        let secondCallResult = true;

        await act(async () => {
            secondCallResult = await result.current.createChannelAction(
                "Canal B",
                "@canalb",
                "none",
                ""
            );
        });

        expect(secondCallResult).toBe(false);
        expect(onError).not.toHaveBeenCalled();
        expect(createChannel).toHaveBeenCalledTimes(1);
    });

    it("updates channel identity successfully with trimmed values", async () => {
        vi.mocked(updateChannelNameHandle).mockResolvedValueOnce(undefined);
        vi.mocked(listAllChannels).mockResolvedValueOnce([
            {
                id: 10,
                name: "Canal Editado",
                youtube_handle: "@canaleditado",
                avatar_path: null,
                created_at: "2026-03-31T10:00:00.000Z",
            },
        ]);

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onChannelDeleted,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                setUpdatingChannelAvatarId,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        let updated = false;

        await act(async () => {
            updated = await result.current.updateChannelIdentityAction(
                10,
                "  Canal Editado  ",
                "  @canaleditado  "
            );
        });

        expect(updated).toBe(true);
        expect(updateChannelNameHandle).toHaveBeenCalledWith(
            10,
            "Canal Editado",
            "@canaleditado"
        );
        expect(listAllChannels).toHaveBeenCalled();
        expect(setChannels).toHaveBeenCalled();
    });

    it("returns false and reports error when update channel identity fails", async () => {
        vi.mocked(updateChannelNameHandle).mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onChannelDeleted,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                setUpdatingChannelAvatarId,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        let updated = true;

        await act(async () => {
            updated = await result.current.updateChannelIdentityAction(
                10,
                "Canal Editado",
                "@canaleditado"
            );
        });

        expect(updated).toBe(false);
        expect(onError).toHaveBeenCalledWith("Failed to update channel.");
    });

    it("updates channel avatar with manual file", async () => {
        const channel = {
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        };

        vi.mocked(persistThumbnailFile).mockResolvedValueOnce("thumbnails/new-avatar.png");
        vi.mocked(updateChannelAvatarWithCleanup).mockResolvedValueOnce(undefined);
        vi.mocked(listAllChannels).mockResolvedValueOnce([]);

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onChannelDeleted,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                setUpdatingChannelAvatarId,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        await act(async () => {
            await result.current.updateChannelAvatarAction(
                channel,
                "manual",
                "C:/temp/avatar.png"
            );
        });

        expect(setUpdatingChannelAvatarId).toHaveBeenCalledWith(10);
        expect(persistThumbnailFile).toHaveBeenCalledWith(
            "C:/temp/avatar.png",
            "/library"
        );
        expect(updateChannelAvatarWithCleanup).toHaveBeenCalledWith(
            10,
            "thumbnails/new-avatar.png",
            "/library"
        );
        expect(listAllChannels).toHaveBeenCalled();
        expect(setChannels).toHaveBeenCalled();
        expect(setUpdatingChannelAvatarId).toHaveBeenLastCalledWith(null);
    });

    it("updates channel avatar from youtube", async () => {
        const channel = {
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        };

        vi.mocked(downloadChannelAvatarFromHandle).mockResolvedValueOnce(
            "thumbnails/youtube-avatar.png"
        );
        vi.mocked(updateChannelAvatarWithCleanup).mockResolvedValueOnce(undefined);
        vi.mocked(listAllChannels).mockResolvedValueOnce([]);

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onChannelDeleted,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                setUpdatingChannelAvatarId,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        await act(async () => {
            await result.current.updateChannelAvatarAction(channel, "youtube");
        });

        expect(downloadChannelAvatarFromHandle).toHaveBeenCalledWith(
            "@canala",
            "/library"
        );
        expect(updateChannelAvatarWithCleanup).toHaveBeenCalledWith(
            10,
            "thumbnails/youtube-avatar.png",
            "/library"
        );
        expect(setUpdatingChannelAvatarId).toHaveBeenLastCalledWith(null);
    });

    it("clears channel avatar when mode is none", async () => {
        const channel = {
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: "thumbnails/old-avatar.png",
            created_at: "2026-03-31T10:00:00.000Z",
        };

        vi.mocked(updateChannelAvatarWithCleanup).mockResolvedValueOnce(undefined);
        vi.mocked(listAllChannels).mockResolvedValueOnce([]);

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onChannelDeleted,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                setUpdatingChannelAvatarId,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        await act(async () => {
            await result.current.updateChannelAvatarAction(channel, "none");
        });

        expect(updateChannelAvatarWithCleanup).toHaveBeenCalledWith(
            10,
            null,
            "/library"
        );
        expect(setUpdatingChannelAvatarId).toHaveBeenLastCalledWith(null);
    });

    it("reports error when manual avatar update has no file", async () => {
        const channel = {
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        };

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onChannelDeleted,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                setUpdatingChannelAvatarId,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        await act(async () => {
            await result.current.updateChannelAvatarAction(channel, "manual", "");
        });

        expect(onError).toHaveBeenCalledWith(
            "Select an avatar file before updating the channel."
        );
        expect(updateChannelAvatarWithCleanup).not.toHaveBeenCalled();
        expect(setUpdatingChannelAvatarId).toHaveBeenLastCalledWith(null);
    });

    it("deletes selected channel and resets selection", async () => {
        vi.mocked(deleteChannelWithThumbnailCleanup).mockResolvedValueOnce(undefined);
        vi.mocked(listAllChannels).mockResolvedValueOnce([]);

        const channelToDelete = {
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        };

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onChannelDeleted,
                selectedChannelId: 10,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                setUpdatingChannelAvatarId,
                channelToDelete,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        await act(async () => {
            await result.current.confirmDeleteChannelAction();
        });

        expect(deleteChannelWithThumbnailCleanup).toHaveBeenCalledWith(10);
        expect(setSelectedChannelId).toHaveBeenCalledWith(null);
        expect(setChannels).toHaveBeenCalledWith([]);
        expect(setConfirmDeleteChannelOpen).toHaveBeenCalledWith(false);
        expect(setChannelToDelete).toHaveBeenCalledWith(null);
        expect(onChannelDeleted).toHaveBeenCalledWith(10);
    });

    it("reports load error", async () => {
        vi.mocked(listAllChannels).mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onChannelDeleted,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                setUpdatingChannelAvatarId,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        await act(async () => {
            await result.current.loadChannels();
        });

        expect(onError).toHaveBeenCalledWith("Failed to load channels.");
    });

    it("does nothing when confirm delete is called without channel", async () => {
        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onChannelDeleted,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                setUpdatingChannelAvatarId,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        await act(async () => {
            await result.current.confirmDeleteChannelAction();
        });

        expect(deleteChannelWithThumbnailCleanup).not.toHaveBeenCalled();
    });
});