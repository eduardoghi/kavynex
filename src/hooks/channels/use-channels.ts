import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Channel, ChannelAvatarMode } from "../../types/media";
import { findSelectedChannel } from "../../utils/controller-helpers";
import { pickImageFilePath } from "../../utils/pick-image-file";
import { useChannelActions } from "./use-channel-actions";
import { useCreateChannelForm } from "./use-create-channel-form";
import { useEditChannelForm } from "./use-edit-channel-form";
import { useMemoObject } from "../use-memo-object";

type UseChannelsOptions = {
    libraryPath: string;
    onError: (message: string) => void;
    onChannelDeleted?: (channelId: number) => void;
};

export type ChannelsController = {
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

// Composition root for the channel sidebar. It owns the channel list, the selection and the
// delete flow, and composes the create- and edit-channel form state from useCreateChannelForm /
// useEditChannelForm rather than flattening every field into this one hook. The create/save/delete
// calls stay here because they need the channel actions (useChannelActions); the forms own only
// their own fields. The returned shape stays flat so consumers are unchanged.
export function useChannels({
    libraryPath,
    onError,
    onChannelDeleted,
}: UseChannelsOptions): ChannelsController {
    const [channels, setChannels] = useState<Channel[]>([]);
    const [selectedChannelId, setSelectedChannelId] = useState<number | null>(null);

    const [confirmDeleteChannelOpen, setConfirmDeleteChannelOpen] = useState(false);
    const [channelToDelete, setChannelToDelete] = useState<Channel | null>(null);
    const [updatingChannelAvatarId, setUpdatingChannelAvatarId] = useState<number | null>(null);

    const createForm = useCreateChannelForm({ onError });
    const editForm = useEditChannelForm();

    const previousLibraryPathRef = useRef(libraryPath);
    const hasLoadedInitialRef = useRef(false);

    const channelActions = useChannelActions({
        libraryPath,
        onError,
        onChannelDeleted,
        selectedChannelId,
        setChannels,
        setSelectedChannelId,
        setNewChannelName: createForm.setNewChannelName,
        setNewYoutubeHandle: createForm.setNewYoutubeHandle,
        setNewChannelAvatarMode: createForm.setNewChannelAvatarMode,
        setNewChannelAvatarPath: createForm.setNewChannelAvatarPath,
        setUpdatingChannelAvatarId,
        channelToDelete,
        setChannelToDelete,
        setConfirmDeleteChannelOpen,
    });

    // Destructure the stable fields off the per-render channelActions controller object so the
    // callbacks and effects below can depend on them directly. This keeps the dependency arrays
    // honest (no eslint-disable) while still not depending on the whole object, whose identity
    // changes every render.
    const {
        createChannelAction,
        updateChannelIdentityAction,
        updateChannelAvatarAction,
        loadChannels,
    } = channelActions;

    // The form fields and controls the callbacks/effects below and the return object read; pulled off
    // the two composed form controllers here so the rest of the hook is agnostic to where they live.
    const {
        resetCreateChannelForm,
        closeCreateChannelForm,
        newChannelName,
        newYoutubeHandle,
        newChannelAvatarMode,
        newChannelAvatarPath,
    } = createForm;
    const {
        resetEditChannelForm,
        closeEditChannelForm,
        editingChannel,
        editChannelName,
        editYoutubeHandle,
    } = editForm;

    const selectedChannel = useMemo(() => {
        return findSelectedChannel(channels, selectedChannelId);
    }, [channels, selectedChannelId]);

    const createChannel = useCallback(async (): Promise<void> => {
        const created = await createChannelAction(
            newChannelName,
            newYoutubeHandle,
            newChannelAvatarMode,
            newChannelAvatarPath
        );

        if (created) {
            closeCreateChannelForm();
        }
    }, [
        createChannelAction,
        newChannelAvatarMode,
        newChannelAvatarPath,
        newChannelName,
        newYoutubeHandle,
        closeCreateChannelForm,
    ]);

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
            closeEditChannelForm();
            resetEditChannelForm();
        }
    }, [
        updateChannelIdentityAction,
        editChannelName,
        editYoutubeHandle,
        editingChannel,
        closeEditChannelForm,
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

                await updateChannelAvatarAction(channel, "manual", normalizedPath);
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
        closeCreateChannelForm();
        closeEditChannelForm();

        void loadChannels();
    }, [
        loadChannels,
        libraryPath,
        resetCreateChannelForm,
        resetEditChannelForm,
        closeCreateChannelForm,
        closeEditChannelForm,
    ]);

    useEffect(() => {
        if (
            selectedChannelId !== null &&
            !channels.some((channel) => channel.id === selectedChannelId)
        ) {
            setSelectedChannelId(null);
        }
    }, [channels, selectedChannelId]);

    useEffect(() => {
        if (editingChannel && !channels.some((channel) => channel.id === editingChannel.id)) {
            resetEditChannelForm();
            closeEditChannelForm();
        }
    }, [channels, editingChannel, resetEditChannelForm, closeEditChannelForm]);

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

        createChannelOpen: createForm.createChannelOpen,
        setCreateChannelOpen: createForm.setCreateChannelOpen,
        newChannelName,
        setNewChannelName: createForm.setNewChannelName,
        newYoutubeHandle,
        setNewYoutubeHandle: createForm.setNewYoutubeHandle,
        newChannelAvatarMode,
        setNewChannelAvatarMode: createForm.setNewChannelAvatarMode,
        newChannelAvatarPath,
        setNewChannelAvatarPath: createForm.setNewChannelAvatarPath,
        pickChannelAvatarViaDialog: createForm.pickChannelAvatarViaDialog,
        clearNewChannelAvatarPath: createForm.clearNewChannelAvatarPath,

        editChannelOpen: editForm.editChannelOpen,
        setEditChannelOpen: editForm.setEditChannelOpen,
        editingChannel,
        editChannelName,
        setEditChannelName: editForm.setEditChannelName,
        editYoutubeHandle,
        setEditYoutubeHandle: editForm.setEditYoutubeHandle,
        requestEditChannel: editForm.requestEditChannel,
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
