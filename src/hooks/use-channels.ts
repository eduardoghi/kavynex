import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Channel, ChannelAvatarMode } from "../types/media";
import { findSelectedChannel } from "../utils/controller-helpers";
import { pickImageFilePath } from "../utils/pick-image-file";
import { useChannelActions } from "./use-channel-actions";
import { useMemoObject } from "./use-memo-object";

type UseChannelsOptions = {
    libraryPath: string;
    onError: (message: string) => void;
    onChannelDeleted?: (channelId: number) => void;
};

type UseChannelsReturn = {
    channels: Channel[];
    selectedChannelId: number | null;
    selectedChannel: Channel | null;

    createChannelOpen: boolean;
    setCreateChannelOpen: (value: boolean) => void;
    newChannelName: string;
    setNewChannelName: (value: string) => void;
    newYoutubeHandle: string;
    setNewYoutubeHandle: (value: string) => void;
    newChannelAvatarMode: ChannelAvatarMode;
    setNewChannelAvatarMode: (value: ChannelAvatarMode) => void;
    newChannelAvatarPath: string;
    setNewChannelAvatarPath: (value: string) => void;
    pickChannelAvatarViaDialog: () => Promise<void>;
    clearNewChannelAvatarPath: () => void;

    editChannelOpen: boolean;
    setEditChannelOpen: (value: boolean) => void;
    editingChannel: Channel | null;
    editChannelName: string;
    setEditChannelName: (value: string) => void;
    editYoutubeHandle: string;
    setEditYoutubeHandle: (value: string) => void;
    requestEditChannel: (channel: Channel) => void;
    saveEditedChannel: () => Promise<void>;
    isEditingChannel: boolean;

    confirmDeleteChannelOpen: boolean;
    channelToDelete: Channel | null;

    isLoadingChannels: boolean;
    isCreatingChannel: boolean;
    isDeletingChannel: boolean;
    isUpdatingChannelAvatar: boolean;
    updatingChannelAvatarId: number | null;

    setSelectedChannelId: (value: number | null) => void;
    createChannel: () => Promise<void>;
    requestDeleteChannel: (channel: Channel) => void;
    updateChannelAvatarFromFile: (channel: Channel) => Promise<void>;
    updateChannelAvatarFromYouTube: (channel: Channel) => Promise<void>;
    removeChannelAvatar: (channel: Channel) => Promise<void>;
    confirmDeleteChannel: () => Promise<void>;
    closeDeleteChannelModal: () => void;
};

export function useChannels({
    libraryPath,
    onError,
    onChannelDeleted,
}: UseChannelsOptions): UseChannelsReturn {
    const [channels, setChannels] = useState<Channel[]>([]);
    const [selectedChannelId, setSelectedChannelId] = useState<number | null>(null);

    const [createChannelOpen, setCreateChannelOpenState] = useState(false);
    const [newChannelName, setNewChannelName] = useState("");
    const [newYoutubeHandle, setNewYoutubeHandle] = useState("");
    const [newChannelAvatarMode, setNewChannelAvatarMode] =
        useState<ChannelAvatarMode>("none");
    const [newChannelAvatarPath, setNewChannelAvatarPath] = useState("");

    const [editChannelOpen, setEditChannelOpenState] = useState(false);
    const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
    const [editChannelName, setEditChannelName] = useState("");
    const [editYoutubeHandle, setEditYoutubeHandle] = useState("");

    const [confirmDeleteChannelOpen, setConfirmDeleteChannelOpen] = useState(false);
    const [channelToDelete, setChannelToDelete] = useState<Channel | null>(null);
    const [updatingChannelAvatarId, setUpdatingChannelAvatarId] = useState<number | null>(null);

    const previousLibraryPathRef = useRef(libraryPath);
    const hasLoadedInitialRef = useRef(false);

    const channelActions = useChannelActions({
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
    });

    // Destructure the stable fields off the per-render channelActions controller object so
    // the callbacks and effects below can depend on them directly. This keeps the dependency
    // arrays honest (no eslint-disable) while still not depending on the whole object, whose
    // identity changes every render.
    const {
        createChannelAction,
        updateChannelIdentityAction,
        updateChannelAvatarAction,
        loadChannels,
    } = channelActions;

    const selectedChannel = useMemo(() => {
        return findSelectedChannel(channels, selectedChannelId);
    }, [channels, selectedChannelId]);

    const resetCreateChannelForm = useCallback((): void => {
        setNewChannelName("");
        setNewYoutubeHandle("");
        setNewChannelAvatarMode("none");
        setNewChannelAvatarPath("");
    }, []);

    const resetEditChannelForm = useCallback((): void => {
        setEditingChannel(null);
        setEditChannelName("");
        setEditYoutubeHandle("");
    }, []);

    const setCreateChannelOpen = useCallback(
        (value: boolean): void => {
            setCreateChannelOpenState(value);

            if (!value) {
                resetCreateChannelForm();
            }
        },
        [resetCreateChannelForm]
    );

    const setEditChannelOpen = useCallback(
        (value: boolean): void => {
            setEditChannelOpenState(value);

            if (!value) {
                resetEditChannelForm();
            }
        },
        [resetEditChannelForm]
    );

    const pickChannelAvatarViaDialog = useCallback(async (): Promise<void> => {
        try {
            const normalizedPath = await pickImageFilePath();

            if (!normalizedPath) {
                return;
            }

            setNewChannelAvatarMode("manual");
            setNewChannelAvatarPath(normalizedPath);
        } catch {
            onError("Failed to select avatar file.");
        }
    }, [onError]);

    const clearNewChannelAvatarPath = useCallback((): void => {
        setNewChannelAvatarPath("");
    }, []);

    const createChannel = useCallback(async (): Promise<void> => {
        const created = await createChannelAction(
            newChannelName,
            newYoutubeHandle,
            newChannelAvatarMode,
            newChannelAvatarPath
        );

        if (created) {
            setCreateChannelOpenState(false);
        }
    }, [
        createChannelAction,
        newChannelAvatarMode,
        newChannelAvatarPath,
        newChannelName,
        newYoutubeHandle,
    ]);

    const requestEditChannel = useCallback((channel: Channel): void => {
        setEditingChannel(channel);
        setEditChannelName(channel.name);
        setEditYoutubeHandle(channel.youtube_handle);
        setEditChannelOpenState(true);
    }, []);

    const saveEditedChannel = useCallback(async (): Promise<void> => {
        if (!editingChannel) {
            return;
        }

        const saved = await updateChannelIdentityAction(
            editingChannel.id,
            editChannelName,
            editYoutubeHandle
        );

        if (saved) {
            setEditChannelOpenState(false);
            resetEditChannelForm();
        }
    }, [
        updateChannelIdentityAction,
        editChannelName,
        editYoutubeHandle,
        editingChannel,
        resetEditChannelForm,
    ]);

    const requestDeleteChannel = useCallback((channel: Channel): void => {
        setChannelToDelete(channel);
        setConfirmDeleteChannelOpen(true);
    }, []);

    const updateChannelAvatarFromFile = useCallback(
        async (channel: Channel): Promise<void> => {
            try {
                const normalizedPath = await pickImageFilePath();

                if (!normalizedPath) {
                    return;
                }

                await updateChannelAvatarAction(
                    channel,
                    "manual",
                    normalizedPath
                );
            } catch {
                onError("Failed to select avatar file.");
            }
        },
        [updateChannelAvatarAction, onError]
    );

    const updateChannelAvatarFromYouTube = useCallback(
        async (channel: Channel): Promise<void> => {
            await updateChannelAvatarAction(channel, "youtube");
        },
        [updateChannelAvatarAction]
    );

    const removeChannelAvatar = useCallback(
        async (channel: Channel): Promise<void> => {
            await updateChannelAvatarAction(channel, "none");
        },
        [updateChannelAvatarAction]
    );

    const closeDeleteChannelModal = useCallback((): void => {
        if (channelActions.isDeletingChannel) {
            return;
        }

        setConfirmDeleteChannelOpen(false);
        setChannelToDelete(null);
    }, [channelActions.isDeletingChannel]);

    useEffect(() => {
        if (hasLoadedInitialRef.current) {
            return;
        }

        hasLoadedInitialRef.current = true;
        void loadChannels();
    }, [loadChannels]);

    useEffect(() => {
        if (previousLibraryPathRef.current === libraryPath) {
            return;
        }

        previousLibraryPathRef.current = libraryPath;
        setSelectedChannelId(null);
        setChannels([]);
        setChannelToDelete(null);
        setConfirmDeleteChannelOpen(false);
        setUpdatingChannelAvatarId(null);
        resetCreateChannelForm();
        resetEditChannelForm();
        setCreateChannelOpenState(false);
        setEditChannelOpenState(false);

        void loadChannels();
    }, [loadChannels, libraryPath, resetCreateChannelForm, resetEditChannelForm]);

    useEffect(() => {
        if (
            selectedChannelId !== null &&
            !channels.some((channel) => channel.id === selectedChannelId)
        ) {
            setSelectedChannelId(null);
        }
    }, [channels, selectedChannelId]);

    useEffect(() => {
        if (
            editingChannel &&
            !channels.some((channel) => channel.id === editingChannel.id)
        ) {
            resetEditChannelForm();
            setEditChannelOpenState(false);
        }
    }, [channels, editingChannel, resetEditChannelForm]);

    const isEditingChannel = channelActions.isEditingChannel;
    const isLoadingChannels = channelActions.isLoadingChannels;
    const isCreatingChannel = channelActions.isCreatingChannel;
    const isDeletingChannel = channelActions.isDeletingChannel;
    const isUpdatingChannelAvatar = channelActions.isUpdatingChannelAvatar;
    const confirmDeleteChannel = channelActions.confirmDeleteChannelAction;

    return useMemoObject({
        channels,
        selectedChannelId,
        selectedChannel,

        createChannelOpen,
        setCreateChannelOpen,
        newChannelName,
        setNewChannelName,
        newYoutubeHandle,
        setNewYoutubeHandle,
        newChannelAvatarMode,
        setNewChannelAvatarMode,
        newChannelAvatarPath,
        setNewChannelAvatarPath,
        pickChannelAvatarViaDialog,
        clearNewChannelAvatarPath,

        editChannelOpen,
        setEditChannelOpen,
        editingChannel,
        editChannelName,
        setEditChannelName,
        editYoutubeHandle,
        setEditYoutubeHandle,
        requestEditChannel,
        saveEditedChannel,
        isEditingChannel,

        confirmDeleteChannelOpen,
        channelToDelete,

        isLoadingChannels,
        isCreatingChannel,
        isDeletingChannel,
        isUpdatingChannelAvatar,
        updatingChannelAvatarId,

        setSelectedChannelId,
        createChannel,
        requestDeleteChannel,
        updateChannelAvatarFromFile,
        updateChannelAvatarFromYouTube,
        removeChannelAvatar,
        confirmDeleteChannel,
        closeDeleteChannelModal,
    });
}