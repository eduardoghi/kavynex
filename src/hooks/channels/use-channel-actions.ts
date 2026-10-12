import { useCallback, useState } from "react";
import { useMemoObject } from "../use-memo-object";
import type { Channel, ChannelAvatarMode } from "../../types/media";
import { resolveErrorMessage } from "../../utils/error-message";
import { useAsyncFlag } from "../use-async-flag";
import { useRequestGuard } from "../use-request-guard";
import {
    deleteChannelWithThumbnailCleanup,
    listAllChannels,
    updateChannelAvatarWithCleanup,
    updateChannelNameHandle,
} from "../../services/channel-service";
import {
    downloadChannelAvatarFromHandle,
    persistThumbnailFile,
} from "../../services/thumbnail-service";
import { logError } from "../../utils/app-logger";
import { leftoverAvatarNotice, leftoverFilesNotice } from "../../utils/leftover-files-notice";
import { executeCreateChannel, type CreateChannelAvatar } from "../../use-cases/create-channel";

type UseChannelActionsOptions = {
    libraryPath: string;
    onError: (message: string) => void;
    onNotice?: (message: string) => void;
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
    // The last load of the list failed, so an empty list says nothing about whether channels exist.
    channelsLoadFailed: boolean;
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
    onNotice,
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
    const [channelsLoadFailed, setChannelsLoadFailed] = useState(false);
    const loadRequestGuard = useRequestGuard();

    const { isRunning: isCreatingChannel, runWithFlag: runCreateChannel } = useAsyncFlag();
    const { isRunning: isDeletingChannel, runWithFlag: runDeleteChannel } = useAsyncFlag();
    const { isRunning: isUpdatingChannelAvatar, runWithFlag: runUpdateChannelAvatar } =
        useAsyncFlag();
    const { isRunning: isEditingChannel, runWithFlag: runEditChannel } = useAsyncFlag();

    // A request-id guard (not a mutex) so a rapid library switch supersedes the previous
    // load. The newer call runs immediately and the stale response is discarded instead of
    // leaving the old library's channels on screen.
    const loadChannels = useCallback(async (): Promise<void> => {
        const requestId = loadRequestGuard.begin();
        setIsLoadingChannels(true);

        try {
            const items = await listAllChannels();

            if (!loadRequestGuard.isCurrent(requestId)) {
                return;
            }

            setChannels(items);
            setChannelsLoadFailed(false);
        } catch (error) {
            if (!loadRequestGuard.isCurrent(requestId)) {
                return;
            }

            setChannelsLoadFailed(true);
            logError("channels", "Failed to load channels.", error);
            onError(resolveErrorMessage(error, "Failed to load channels."));
        } finally {
            if (loadRequestGuard.isCurrent(requestId)) {
                setIsLoadingChannels(false);
            }
        }
    }, [loadRequestGuard, onError, setChannels]);

    // A reload after a write that already landed. Its failure is reported with `message`, which says
    // the change was stored, rather than as a failure of the change itself.
    const reloadChannelsAfterChange = useCallback(
        async (message: string): Promise<void> => {
            try {
                setChannels(await listAllChannels());
            } catch (error) {
                logError("channels", "Failed to reload channels after a change.", error);
                onError(message);
            }
        },
        [onError, setChannels]
    );

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
                let avatar: CreateChannelAvatar = { mode: "none" };

                if (avatarMode === "manual") {
                    if (!normalizedAvatarPath) {
                        onError("Select an avatar file before creating the channel.");
                        return false;
                    }

                    if (!normalizedLibraryPath) {
                        onError("Choose a library folder before importing a manual avatar.");
                        return false;
                    }

                    avatar = { mode: "manual", sourcePath: normalizedAvatarPath };
                } else if (avatarMode === "youtube") {
                    if (!normalizedLibraryPath) {
                        onError("Choose a library folder before importing a YouTube avatar.");
                        return false;
                    }

                    avatar = { mode: "youtube" };
                }

                let result;

                try {
                    result = await executeCreateChannel(
                        normalizedName,
                        normalizedYoutubeHandle,
                        avatar
                    );
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

                // The channel exists from here on, so nothing below may report the creation as
                // failed. That would send the user back to create it again, into
                // CHANNEL_ALREADY_EXISTS.
                setNewChannelName("");
                setNewYoutubeHandle("");
                setNewChannelAvatarMode("none");
                setNewChannelAvatarPath("");

                if (result.avatarFailure !== null) {
                    logError(
                        "channels",
                        "Created the channel without its YouTube avatar.",
                        result.avatarFailure,
                        { youtubeHandle: normalizedYoutubeHandle }
                    );
                    onNotice?.(
                        "The channel was created without an avatar, because the YouTube avatar " +
                            "could not be downloaded. You can set one later from the channel menu."
                    );
                }

                // Selected only once the list holds it. useChannels clears a selection the list
                // does not contain, so selecting first lost the new channel during the reload.
                try {
                    setChannels(await listAllChannels());
                    setSelectedChannelId(result.channelId);
                } catch (error) {
                    logError("channels", "Failed to reload channels after creating one.", error);
                    onError(
                        "The channel was created, but the channel list could not be reloaded. " +
                            "Restart the app if it does not show up."
                    );
                }

                return true;
            });

            return created ?? false;
        },
        [
            libraryPath,
            onError,
            onNotice,
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
                } catch (error) {
                    logError("channels", "Failed to update channel identity.", error, {
                        channelId,
                        name: normalizedName,
                        youtubeHandle: normalizedYoutubeHandle,
                    });
                    onError(resolveErrorMessage(error, "Failed to update channel."));
                    return false;
                }

                // The change is stored by now, so a list that will not reload is not a failed edit.
                // Reported on its own, as creating a channel does, and the edit form closes.
                await reloadChannelsAfterChange(
                    "The channel was updated, but the channel list could not be reloaded. Restart the app if it does not show the change."
                );

                return true;
            });

            return updated ?? false;
        },
        [onError, reloadChannelsAfterChange, runEditChannel]
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

                        nextAvatarPath = await persistThumbnailFile(normalizedAvatarPath);
                    } else if (avatarMode === "youtube") {
                        if (!normalizedLibraryPath) {
                            onError("Choose a library folder before importing a YouTube avatar.");
                            return;
                        }

                        nextAvatarPath = await downloadChannelAvatarFromHandle(
                            channel.youtube_handle
                        );
                    }

                    const leftoverFiles = await updateChannelAvatarWithCleanup(
                        channel.id,
                        nextAvatarPath
                    );

                    if (leftoverFiles > 0) {
                        onNotice?.(leftoverAvatarNotice());
                    }

                    // Reports its own failure, which says the avatar was stored.
                    await reloadChannelsAfterChange(
                        "The avatar was changed, but the channel list could not be reloaded. Restart the app if it does not show the new avatar."
                    );
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
            onNotice,
            reloadChannelsAfterChange,
            runUpdateChannelAvatar,
            setUpdatingChannelAvatarId,
        ]
    );

    const confirmDeleteChannelAction = useCallback(async (): Promise<void> => {
        if (!channelToDelete) {
            return;
        }

        await runDeleteChannel(async () => {
            const deletedId = channelToDelete.id;
            let leftoverFiles: number;

            try {
                leftoverFiles = await deleteChannelWithThumbnailCleanup(deletedId);
            } catch (error) {
                logError("channels", "Failed to delete channel.", error, {
                    channelId: deletedId,
                    libraryPath,
                });
                onError(resolveErrorMessage(error, "Failed to delete channel."));
                return;
            }

            // The delete is committed from here on, so the dialog closes and the channel leaves the
            // list whatever the reload below does. Reported as a failed delete, a failed reload left
            // the dialog open on a channel that no longer exists, and a retry hit a missing row.
            if (selectedChannelId === deletedId) {
                setSelectedChannelId(null);
            }

            setConfirmDeleteChannelOpen(false);
            setChannelToDelete(null);

            if (leftoverFiles > 0) {
                onNotice?.(leftoverFilesNotice("channel", leftoverFiles));
            }

            try {
                setChannels(await listAllChannels());
            } catch (error) {
                setChannels((current) => current.filter((channel) => channel.id !== deletedId));
                logError("channels", "Failed to reload channels after deleting one.", error);
                onError(
                    "The channel was deleted, but the channel list could not be reloaded. " +
                        "Restart the app if the list looks wrong."
                );
            }
        });
    }, [
        channelToDelete,
        libraryPath,
        onError,
        onNotice,
        runDeleteChannel,
        selectedChannelId,
        setChannelToDelete,
        setChannels,
        setConfirmDeleteChannelOpen,
        setSelectedChannelId,
    ]);

    return useMemoObject({
        isLoadingChannels,
        channelsLoadFailed,
        isCreatingChannel,
        isDeletingChannel,
        isUpdatingChannelAvatar,
        isEditingChannel,
        loadChannels,
        createChannelAction,
        updateChannelIdentityAction,
        updateChannelAvatarAction,
        confirmDeleteChannelAction,
    });
}