import { useCallback, useRef, useState } from "react";
import type { Channel, ChannelAvatarMode } from "../types/media";
import { resolveErrorMessage } from "../utils/error-message";
import { useAsyncFlag } from "./use-async-flag";
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
import { logError } from "../utils/app-logger";

type UseChannelActionsOptions = {
    libraryPath: string;
    onError: (message: string) => void;
    onChannelDeleted?: (channelId: number) => void;
    selectedChannelId: number | null;
    setChannels: React.Dispatch<React.SetStateAction<Channel[]>>;
    setSelectedChannelId: (value: number | null) => void;
    setNewChannelName: (value: string) => void;
    setNewYoutubeHandle: (value: string) => void;
    setNewChannelAvatarMode: (value: ChannelAvatarMode) => void;
    setNewChannelAvatarPath: (value: string) => void;
    setUpdatingChannelAvatarId: (value: number | null) => void;
    channelToDelete: Channel | null;
    setChannelToDelete: (value: Channel | null) => void;
    setConfirmDeleteChannelOpen: (value: boolean) => void;
};

type UseChannelActionsReturn = {
    isLoadingChannels: boolean;
    isCreatingChannel: boolean;
    isDeletingChannel: boolean;
    isUpdatingChannelAvatar: boolean;
    isEditingChannel: boolean;
    loadChannels: () => Promise<void>;
    createChannelAction: (
        name: string,
        youtubeHandle: string,
        avatarMode: ChannelAvatarMode,
        avatarPath: string
    ) => Promise<boolean>;
    updateChannelIdentityAction: (
        channelId: number,
        name: string,
        youtubeHandle: string
    ) => Promise<boolean>;
    updateChannelAvatarAction: (
        channel: Channel,
        avatarMode: ChannelAvatarMode,
        avatarPath?: string
    ) => Promise<void>;
    confirmDeleteChannelAction: () => Promise<void>;
};

export function useChannelActions({
    libraryPath,
    onError,
    onChannelDeleted,
    selectedChannelId,
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
}: UseChannelActionsOptions): UseChannelActionsReturn {
    const [isLoadingChannels, setIsLoadingChannels] = useState(false);
    const latestLoadRequestIdRef = useRef(0);

    const { isRunning: isCreatingChannel, runWithFlag: runCreateChannel } = useAsyncFlag();
    const { isRunning: isDeletingChannel, runWithFlag: runDeleteChannel } = useAsyncFlag();
    const { isRunning: isUpdatingChannelAvatar, runWithFlag: runUpdateChannelAvatar } =
        useAsyncFlag();
    const { isRunning: isEditingChannel, runWithFlag: runEditChannel } = useAsyncFlag();

    // A request-id guard (not a mutex) so a rapid library switch supersedes the previous
    // load: the newer call runs immediately and the stale response is discarded instead of
    // leaving the old library's channels on screen.
    const loadChannels = useCallback(async (): Promise<void> => {
        const requestId = ++latestLoadRequestIdRef.current;
        setIsLoadingChannels(true);

        try {
            const items = await listAllChannels();

            if (requestId !== latestLoadRequestIdRef.current) {
                return;
            }

            setChannels(items);
        } catch (error) {
            if (requestId !== latestLoadRequestIdRef.current) {
                return;
            }

            logError("channels", "Failed to load channels.", error);
            onError(resolveErrorMessage(error, "Failed to load channels."));
        } finally {
            if (requestId === latestLoadRequestIdRef.current) {
                setIsLoadingChannels(false);
            }
        }
    }, [onError, setChannels]);

    const createChannelAction = useCallback(
        async (
            name: string,
            youtubeHandle: string,
            avatarMode: ChannelAvatarMode,
            avatarPath: string
        ): Promise<boolean> => {
            const normalizedName = name.trim();
            const normalizedYoutubeHandle = youtubeHandle.trim();
            const normalizedAvatarPath = avatarPath.trim();
            const normalizedLibraryPath = libraryPath.trim();

            const created = await runCreateChannel(async () => {
                try {
                    let finalAvatarPath: string | null = null;

                    if (avatarMode === "manual") {
                        if (!normalizedAvatarPath) {
                            onError("Select an avatar file before creating the channel.");
                            return false;
                        }

                        if (!normalizedLibraryPath) {
                            onError("Choose a library folder before importing a manual avatar.");
                            return false;
                        }

                        finalAvatarPath = await persistThumbnailFile(
                            normalizedAvatarPath,
                            normalizedLibraryPath
                        );
                    } else if (avatarMode === "youtube") {
                        if (!normalizedLibraryPath) {
                            onError("Choose a library folder before importing a YouTube avatar.");
                            return false;
                        }

                        finalAvatarPath = await downloadChannelAvatarFromHandle(
                            normalizedYoutubeHandle,
                            normalizedLibraryPath
                        );
                    }

                    const createdId = await createChannel(
                        normalizedName,
                        normalizedYoutubeHandle,
                        finalAvatarPath
                    );

                    const items = await listAllChannels();

                    setChannels(items);
                    setSelectedChannelId(createdId);
                    setNewChannelName("");
                    setNewYoutubeHandle("");
                    setNewChannelAvatarMode("none");
                    setNewChannelAvatarPath("");
                    return true;
                } catch (error) {
                    logError("channels", "Failed to create channel.", error, {
                        name: normalizedName,
                        youtubeHandle: normalizedYoutubeHandle,
                        avatarMode,
                        avatarPath: normalizedAvatarPath,
                        libraryPath: normalizedLibraryPath,
                    });
                    onError(resolveErrorMessage(error, "Failed to create channel."));
                    return false;
                }
            });

            return created ?? false;
        },
        [
            libraryPath,
            onError,
            runCreateChannel,
            setChannels,
            setNewChannelAvatarMode,
            setNewChannelAvatarPath,
            setNewChannelName,
            setNewYoutubeHandle,
            setSelectedChannelId,
        ]
    );

    const updateChannelIdentityAction = useCallback(
        async (
            channelId: number,
            name: string,
            youtubeHandle: string
        ): Promise<boolean> => {
            const normalizedName = name.trim();
            const normalizedYoutubeHandle = youtubeHandle.trim();

            const updated = await runEditChannel(async () => {
                try {
                    await updateChannelNameHandle(
                        channelId,
                        normalizedName,
                        normalizedYoutubeHandle
                    );

                    const items = await listAllChannels();
                    setChannels(items);

                    return true;
                } catch (error) {
                    logError("channels", "Failed to update channel identity.", error, {
                        channelId,
                        name: normalizedName,
                        youtubeHandle: normalizedYoutubeHandle,
                    });
                    onError(resolveErrorMessage(error, "Failed to update channel."));
                    return false;
                }
            });

            return updated ?? false;
        },
        [onError, runEditChannel, setChannels]
    );

    const updateChannelAvatarAction = useCallback(
        async (
            channel: Channel,
            avatarMode: ChannelAvatarMode,
            avatarPath = ""
        ): Promise<void> => {
            const normalizedLibraryPath = libraryPath.trim();
            const normalizedAvatarPath = avatarPath.trim();

            await runUpdateChannelAvatar(async () => {
                setUpdatingChannelAvatarId(channel.id);

                try {
                    let nextAvatarPath: string | null = null;

                    if (avatarMode === "manual") {
                        if (!normalizedAvatarPath) {
                            onError("Select an avatar file before updating the channel.");
                            return;
                        }

                        if (!normalizedLibraryPath) {
                            onError("Choose a library folder before importing a manual avatar.");
                            return;
                        }

                        nextAvatarPath = await persistThumbnailFile(
                            normalizedAvatarPath,
                            normalizedLibraryPath
                        );
                    } else if (avatarMode === "youtube") {
                        if (!normalizedLibraryPath) {
                            onError("Choose a library folder before importing a YouTube avatar.");
                            return;
                        }

                        nextAvatarPath = await downloadChannelAvatarFromHandle(
                            channel.youtube_handle,
                            normalizedLibraryPath
                        );
                    }

                    await updateChannelAvatarWithCleanup(channel.id, nextAvatarPath);

                    const items = await listAllChannels();
                    setChannels(items);
                } catch (error) {
                    logError("channels", "Failed to update channel avatar.", error, {
                        channelId: channel.id,
                        youtubeHandle: channel.youtube_handle,
                        avatarMode,
                        avatarPath: normalizedAvatarPath,
                        libraryPath: normalizedLibraryPath,
                    });
                    onError(resolveErrorMessage(error, "Failed to update channel avatar."));
                } finally {
                    setUpdatingChannelAvatarId(null);
                }
            });
        },
        [
            libraryPath,
            onError,
            runUpdateChannelAvatar,
            setChannels,
            setUpdatingChannelAvatarId,
        ]
    );

    const confirmDeleteChannelAction = useCallback(async (): Promise<void> => {
        if (!channelToDelete) {
            return;
        }

        await runDeleteChannel(async () => {
            try {
                await deleteChannelWithThumbnailCleanup(channelToDelete.id);

                if (selectedChannelId === channelToDelete.id) {
                    setSelectedChannelId(null);
                }

                const items = await listAllChannels();
                setChannels(items);

                setConfirmDeleteChannelOpen(false);
                setChannelToDelete(null);
                onChannelDeleted?.(channelToDelete.id);
            } catch (error) {
                logError("channels", "Failed to delete channel.", error, {
                    channelId: channelToDelete.id,
                    libraryPath,
                });
                onError(resolveErrorMessage(error, "Failed to delete channel."));
            }
        });
    }, [
        channelToDelete,
        libraryPath,
        onChannelDeleted,
        onError,
        runDeleteChannel,
        selectedChannelId,
        setChannelToDelete,
        setChannels,
        setConfirmDeleteChannelOpen,
        setSelectedChannelId,
    ]);

    return {
        isLoadingChannels,
        isCreatingChannel,
        isDeletingChannel,
        isUpdatingChannelAvatar,
        isEditingChannel,
        loadChannels,
        createChannelAction,
        updateChannelIdentityAction,
        updateChannelAvatarAction,
        confirmDeleteChannelAction,
    };
}