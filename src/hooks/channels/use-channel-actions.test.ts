import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChannelActions } from "./use-channel-actions";

vi.mock("../../utils/error-message", () => ({
    resolveErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

vi.mock("../../utils/app-logger", () => ({
    logError: vi.fn(),
}));

// One mock per image behind the shared calls, so each test sets up and checks the avatar and the
// banner apart.
const { downloadAvatar, downloadBanner, updateAvatar, updateBanner } = vi.hoisted(() => ({
    downloadAvatar: vi.fn(),
    downloadBanner: vi.fn(),
    updateAvatar: vi.fn(),
    updateBanner: vi.fn(),
}));

vi.mock("../../services/channel-service", () => ({
    createChannel: vi.fn(),
    ensureChannelCanBeCreated: vi.fn(),
    deleteChannelWithThumbnailCleanup: vi.fn(),
    listAllChannels: vi.fn(),
    updateChannelImageWithCleanup: vi.fn((kind: string, channelId: number, path: string | null) =>
        kind === "avatar" ? updateAvatar(channelId, path) : updateBanner(channelId, path)
    ),
    updateChannelNameHandle: vi.fn(),
}));

vi.mock("../../services/thumbnail-service", () => ({
    persistThumbnailFile: vi.fn(),
    downloadChannelImageFromHandle: vi.fn((kind: string, handle: string) =>
        kind === "avatar" ? downloadAvatar(handle) : downloadBanner(handle)
    ),
}));

import {
    createChannel,
    ensureChannelCanBeCreated,
    deleteChannelWithThumbnailCleanup,
    listAllChannels,
    updateChannelNameHandle,
} from "../../services/channel-service";
import { persistThumbnailFile } from "../../services/thumbnail-service";

describe("useChannelActions", () => {
    const setChannels = vi.fn();
    const setSelectedChannelId = vi.fn();
    const setNewChannelName = vi.fn();
    const setNewYoutubeHandle = vi.fn();
    const setNewChannelAvatarMode = vi.fn();
    const setNewChannelAvatarPath = vi.fn();
    const setChannelToDelete = vi.fn();
    const setConfirmDeleteChannelOpen = vi.fn();
    const onError = vi.fn();

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
                banner_path: null,
                created_at: "2026-03-31T10:00:00.000Z",
            },
        ]);

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
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
                banner_path: null,
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
                banner_path: null,
                created_at: "2026-03-31T10:00:00.000Z",
            },
        ]);

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
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
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
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
        expect(persistThumbnailFile).toHaveBeenCalledWith("C:/temp/avatar.png");
        expect(createChannel).toHaveBeenCalledWith(
            "Canal A",
            "@canala",
            "thumbnails/avatar.png"
        );
    });

    it("creates channel with youtube avatar", async () => {
        vi.mocked(downloadAvatar).mockResolvedValueOnce(
            "thumbnails/youtube-avatar.png"
        );
        vi.mocked(createChannel).mockResolvedValueOnce(10);
        vi.mocked(listAllChannels).mockResolvedValueOnce([]);

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
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
        expect(downloadAvatar).toHaveBeenCalledWith("@canala");
        expect(createChannel).toHaveBeenCalledWith(
            "Canal A",
            "@canala",
            "thumbnails/youtube-avatar.png"
        );
    });

    it("refuses a duplicate channel before writing or downloading its avatar", async () => {
        vi.mocked(ensureChannelCanBeCreated).mockRejectedValueOnce(
            new Error("A channel with this YouTube handle already exists.")
        );

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
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

        // The avatar would have landed in the library with no channel pointing at it.
        expect(created).toBe(false);
        expect(downloadAvatar).not.toHaveBeenCalled();
        expect(persistThumbnailFile).not.toHaveBeenCalled();
        expect(createChannel).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalled();
    });

    it("returns false when manual avatar mode has no file", async () => {
        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
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
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
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

    it("reports a created channel as created when only the list reload fails", async () => {
        // Reporting "Failed to create channel" here sent the user back to create it again, into
        // CHANNEL_ALREADY_EXISTS.
        vi.mocked(createChannel).mockResolvedValueOnce(10);
        vi.mocked(listAllChannels).mockRejectedValueOnce(new Error("database is locked"));
        const onNotice = vi.fn();

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onNotice,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        let created = false;

        await act(async () => {
            created = await result.current.createChannelAction("Canal A", "@canala", "none", "");
        });

        expect(created).toBe(true);
        // Not selected, since a list that does not hold it would clear the selection at once.
        expect(setSelectedChannelId).not.toHaveBeenCalled();
        expect(setNewChannelName).toHaveBeenCalledWith("");
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalledWith("Failed to create channel.");
        expect(onError).toHaveBeenCalledWith(expect.stringMatching(/was created/));
    });

    it("creates the channel and says so when the YouTube avatar cannot be downloaded", async () => {
        vi.mocked(downloadAvatar).mockRejectedValueOnce(new Error("offline"));
        vi.mocked(createChannel).mockResolvedValueOnce(11);
        vi.mocked(listAllChannels).mockResolvedValueOnce([]);
        const onNotice = vi.fn();

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onNotice,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
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
        expect(createChannel).toHaveBeenCalledWith("Canal A", "@canala", null);
        expect(onError).not.toHaveBeenCalled();
        expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/without an avatar/));
    });

    it("returns false when manual avatar mode has no library path", async () => {
        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "",
                onError,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
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
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
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
        expect(downloadAvatar).not.toHaveBeenCalled();
        expect(createChannel).not.toHaveBeenCalled();
    });

    it("discards a reentrant createChannelAction call while one is already running", async () => {
        vi.mocked(createChannel).mockImplementationOnce(() => new Promise(() => {}));

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
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
                banner_path: null,
                created_at: "2026-03-31T10:00:00.000Z",
            },
        ]);

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
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

    it("keeps an edit that was stored when only the list reload fails", async () => {
        // "Failed to update channel" with the edit form left open made the user redo a rename that
        // had already been saved.
        vi.mocked(updateChannelNameHandle).mockResolvedValueOnce(undefined);
        vi.mocked(listAllChannels).mockRejectedValueOnce(new Error("database is busy"));

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        let updated = false;

        await act(async () => {
            updated = await result.current.updateChannelIdentityAction(10, "Canal", "@canal");
        });

        expect(updated).toBe(true);
        expect(onError).toHaveBeenCalledWith(expect.stringContaining("The channel was updated"));
        expect(onError).not.toHaveBeenCalledWith("Failed to update channel.");
    });

    it("returns false and reports error when update channel identity fails", async () => {
        vi.mocked(updateChannelNameHandle).mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
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
            banner_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        };

        vi.mocked(persistThumbnailFile).mockResolvedValueOnce("thumbnails/new-avatar.png");
        vi.mocked(updateAvatar).mockResolvedValueOnce(0);
        vi.mocked(listAllChannels).mockResolvedValueOnce([]);

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        await act(async () => {
            await result.current.updateChannelImageAction(
                "avatar",
                channel,
                "manual",
                "C:/temp/avatar.png"
            );
        });

        expect(persistThumbnailFile).toHaveBeenCalledWith("C:/temp/avatar.png");
        expect(updateAvatar).toHaveBeenCalledWith(
            10,
            "thumbnails/new-avatar.png"
        );
        expect(listAllChannels).toHaveBeenCalled();
        expect(setChannels).toHaveBeenCalled();
        expect(result.current.updatingChannelAvatarId).toBeNull();
    });

    it("changes one channel image at a time, and says which while it runs", async () => {
        const channel = {
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: null,
            banner_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        };
        let finishBanner: (path: string) => void = () => {};
        downloadBanner.mockReturnValueOnce(
            new Promise<string>((resolve) => {
                finishBanner = resolve;
            })
        );
        updateBanner.mockResolvedValueOnce(0);
        vi.mocked(listAllChannels).mockResolvedValueOnce([]);

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        let banner: Promise<void> = Promise.resolve();
        act(() => {
            banner = result.current.updateChannelImageAction("banner", channel, "youtube");
        });

        // The library folder waits on this flag, for the banner as for the avatar.
        expect(result.current.isUpdatingChannelImage).toBe(true);
        expect(result.current.updatingChannelBannerId).toBe(10);
        expect(result.current.updatingChannelAvatarId).toBeNull();

        await act(async () => {
            await result.current.updateChannelImageAction("avatar", channel, "youtube");
        });

        expect(downloadAvatar).not.toHaveBeenCalled();

        await act(async () => {
            finishBanner("thumbnails/b.jpg");
            await banner;
        });

        expect(result.current.isUpdatingChannelImage).toBe(false);
        expect(result.current.updatingChannelBannerId).toBeNull();
    });

    describe("banner", () => {
        const channel = {
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: null,
            banner_path: "thumbnails/old-banner.jpg",
            created_at: "2026-03-31T10:00:00.000Z",
        };

        function renderBannerActions(libraryPath = "/library") {
            const rendered = renderHook(() =>
                useChannelActions({
                    libraryPath,
                    onError,
                    selectedChannelId: null,
                    setChannels,
                    setSelectedChannelId,
                    setNewChannelName,
                    setNewYoutubeHandle,
                    setNewChannelAvatarMode,
                    setNewChannelAvatarPath,
                    channelToDelete: null,
                    setChannelToDelete,
                    setConfirmDeleteChannelOpen,
                })
            );

            return rendered;
        }

        it("loads the banner from YouTube and stores it on the channel", async () => {
            vi.mocked(downloadBanner).mockResolvedValueOnce("thumbnails/b.jpg");
            vi.mocked(updateBanner).mockResolvedValueOnce(0);
            vi.mocked(listAllChannels).mockResolvedValueOnce([]);
            const { result } = renderBannerActions();

            await act(async () => {
                await result.current.updateChannelImageAction("banner", channel, "youtube");
            });

            expect(downloadBanner).toHaveBeenCalledWith("@canala");
            expect(updateBanner).toHaveBeenCalledWith(10, "thumbnails/b.jpg");
            expect(result.current.updatingChannelBannerId).toBeNull();
        });

        it("stores a picked image as the banner", async () => {
            vi.mocked(persistThumbnailFile).mockResolvedValueOnce("thumbnails/picked.png");
            vi.mocked(updateBanner).mockResolvedValueOnce(0);
            vi.mocked(listAllChannels).mockResolvedValueOnce([]);
            const { result } = renderBannerActions();

            await act(async () => {
                await result.current.updateChannelImageAction("banner", channel, "manual", "C:/pic.png");
            });

            expect(persistThumbnailFile).toHaveBeenCalledWith("C:/pic.png");
            expect(updateBanner).toHaveBeenCalledWith(10, "thumbnails/picked.png");
        });

        it("removes the banner", async () => {
            vi.mocked(updateBanner).mockResolvedValueOnce(0);
            vi.mocked(listAllChannels).mockResolvedValueOnce([]);
            const { result } = renderBannerActions();

            await act(async () => {
                await result.current.updateChannelImageAction("banner", channel, "none");
            });

            expect(updateBanner).toHaveBeenCalledWith(10, null);
            expect(downloadBanner).not.toHaveBeenCalled();
        });

        it("reports a banner that could not be loaded", async () => {
            vi.mocked(downloadBanner).mockRejectedValueOnce(new Error("offline"));
            const { result } = renderBannerActions();

            await act(async () => {
                await result.current.updateChannelImageAction("banner", channel, "youtube");
            });

            expect(onError).toHaveBeenCalledWith("Failed to update the channel banner.");
            expect(updateBanner).not.toHaveBeenCalled();
        });

        it("needs a library folder to store a banner", async () => {
            const { result } = renderBannerActions("");

            await act(async () => {
                await result.current.updateChannelImageAction("banner", channel, "youtube");
            });

            expect(onError).toHaveBeenCalledWith(
                "Choose a library folder before setting a channel banner."
            );
            expect(downloadBanner).not.toHaveBeenCalled();
        });
    });

    it("says so when the previous avatar file could not be removed", async () => {
        const channel = {
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: "thumbnails/old-avatar.png",
            banner_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        };
        const onNotice = vi.fn();

        vi.mocked(persistThumbnailFile).mockResolvedValueOnce("thumbnails/new-avatar.png");
        vi.mocked(updateAvatar).mockResolvedValueOnce(1);
        vi.mocked(listAllChannels).mockResolvedValueOnce([]);

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onNotice,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        await act(async () => {
            await result.current.updateChannelImageAction(
                "avatar",
                channel,
                "manual",
                "C:/temp/avatar.png"
            );
        });

        expect(onNotice).toHaveBeenCalledWith(
            expect.stringContaining("previous image could not be removed")
        );
        expect(onError).not.toHaveBeenCalled();
    });

    it("updates channel avatar from youtube", async () => {
        const channel = {
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: null,
            banner_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        };

        vi.mocked(downloadAvatar).mockResolvedValueOnce(
            "thumbnails/youtube-avatar.png"
        );
        vi.mocked(updateAvatar).mockResolvedValueOnce(0);
        vi.mocked(listAllChannels).mockResolvedValueOnce([]);

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        await act(async () => {
            await result.current.updateChannelImageAction("avatar", channel, "youtube");
        });

        expect(downloadAvatar).toHaveBeenCalledWith("@canala");
        expect(updateAvatar).toHaveBeenCalledWith(
            10,
            "thumbnails/youtube-avatar.png"
        );
        expect(result.current.updatingChannelAvatarId).toBeNull();
    });

    it("clears channel avatar when mode is none", async () => {
        const channel = {
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: "thumbnails/old-avatar.png",
            banner_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        };

        vi.mocked(updateAvatar).mockResolvedValueOnce(0);
        vi.mocked(listAllChannels).mockResolvedValueOnce([]);

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        await act(async () => {
            await result.current.updateChannelImageAction("avatar", channel, "none");
        });

        expect(updateAvatar).toHaveBeenCalledWith(10, null);
        expect(result.current.updatingChannelAvatarId).toBeNull();
    });

    it("reports error when manual avatar update has no file", async () => {
        const channel = {
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: null,
            banner_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        };

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                channelToDelete: null,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        await act(async () => {
            await result.current.updateChannelImageAction("avatar", channel, "manual", "");
        });

        expect(onError).toHaveBeenCalledWith(
            "Select an image file before updating the channel avatar."
        );
        expect(updateAvatar).not.toHaveBeenCalled();
        expect(result.current.updatingChannelAvatarId).toBeNull();
    });

    it("deletes selected channel and resets selection", async () => {
        vi.mocked(deleteChannelWithThumbnailCleanup).mockResolvedValueOnce(0);
        vi.mocked(listAllChannels).mockResolvedValueOnce([]);

        const channelToDelete = {
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: null,
            banner_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        };

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                selectedChannelId: 10,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
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
    });

    it("closes the dialog and drops the channel when only the reload after a delete fails", async () => {
        vi.mocked(deleteChannelWithThumbnailCleanup).mockResolvedValueOnce(0);
        vi.mocked(listAllChannels).mockRejectedValueOnce(new Error("database is locked"));

        const channelToDelete = {
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: null,
            banner_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        };

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                selectedChannelId: 10,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                channelToDelete,
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        await act(async () => {
            await result.current.confirmDeleteChannelAction();
        });

        expect(setConfirmDeleteChannelOpen).toHaveBeenCalledWith(false);
        expect(onError).toHaveBeenCalledWith(expect.stringContaining("The channel was deleted"));

        // The list drops the deleted channel even without a reload.
        const calls = vi.mocked(setChannels).mock.calls;
        const updater = calls[calls.length - 1]?.[0] as (
            current: (typeof channelToDelete)[]
        ) => (typeof channelToDelete)[];
        expect(updater([channelToDelete, { ...channelToDelete, id: 11 }]).map((c) => c.id)).toEqual([
            11,
        ]);
    });

    it("tells the user when a deleted channel left files behind", async () => {
        vi.mocked(deleteChannelWithThumbnailCleanup).mockResolvedValueOnce(1);
        vi.mocked(listAllChannels).mockResolvedValueOnce([]);
        const onNotice = vi.fn();

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                onNotice,
                selectedChannelId: 10,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
                channelToDelete: {
                    id: 10,
                    name: "Canal A",
                    youtube_handle: "@canala",
                    avatar_path: null,
                    banner_path: null,
                    created_at: "2026-03-31T10:00:00.000Z",
                },
                setChannelToDelete,
                setConfirmDeleteChannelOpen,
            })
        );

        await act(async () => {
            await result.current.confirmDeleteChannelAction();
        });

        expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("1 of its files"));
    });

    it("reports load error", async () => {
        vi.mocked(listAllChannels).mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() =>
            useChannelActions({
                libraryPath: "/library",
                onError,
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
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
                selectedChannelId: null,
                setChannels,
                setSelectedChannelId,
                setNewChannelName,
                setNewYoutubeHandle,
                setNewChannelAvatarMode,
                setNewChannelAvatarPath,
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