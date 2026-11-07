import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Channel, ChannelAvatarMode, ChannelImageKind } from "../../types/media";
import { listChannelMediaPage } from "../../services/media-service";
import { logError } from "../../utils/app-logger";
import { findSelectedChannel } from "../../utils/controller-helpers";
import { pickImageFilePath } from "../../utils/pick-image-file";
import { useChannelActions } from "./use-channel-actions";
import { useCreateChannelForm } from "./use-create-channel-form";
import { useEditChannelForm } from "./use-edit-channel-form";
import { useMemoObject } from "../use-memo-object";
import { useRequestGuard } from "../use-request-guard";

// The query behind the count the delete confirmation shows. The paged media query returns the
// channel's total alongside the page, so asking it for one row under no filter is a count, through
// a command the app already calls, rather than a command of its own for one number.
const COUNT_ONLY_QUERY: Parameters<typeof listChannelMediaPage>[1] = {
    mediaType: "all",
    watched: "all",
    publication: "all",
    search: "",
    sortCategory: "added_date",
    sortDirection: "desc",
    limit: 1,
    offset: 0,
};

type UseChannelsOptions = {
    libraryPath: string;
    onError: (message: string) => void;
    onNotice?: (message: string) => void;
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
    // How many media the channel awaiting confirmation holds, for the confirmation to name the
    // scale of what goes. `null` until the count arrives, and left `null` if it fails, in which case
    // the confirmation keeps its generic wording. Never a condition on the delete itself.
    channelToDeleteMediaCount: number | null;

    isLoadingChannels: boolean;
    // See useChannelActions. The Home page offers to try again instead of the first-run screen.
    channelsLoadFailed: boolean;
    reloadChannels: () => Promise<void>;
    isCreatingChannel: boolean;
    isDeletingChannel: boolean;
    // See useChannelActions. The library folder waits for it.
    isUpdatingChannelImage: boolean;
    updatingChannelAvatarId: number | null;
    updatingChannelBannerId: number | null;

    setSelectedChannelId: (value: number | null) => void;
    createChannel: () => Promise<void>;
    requestDeleteChannel: (channel: Channel) => void;
    updateChannelAvatarFromFile: (channel: Channel) => Promise<void>;
    updateChannelAvatarFromYouTube: (channel: Channel) => Promise<void>;
    removeChannelAvatar: (channel: Channel) => Promise<void>;
    updateChannelBannerFromFile: (channel: Channel) => Promise<void>;
    updateChannelBannerFromYouTube: (channel: Channel) => Promise<void>;
    removeChannelBanner: (channel: Channel) => Promise<void>;
    confirmDeleteChannel: () => Promise<void>;
    closeDeleteChannelModal: () => void;
};

// Composition root for the channel sidebar. It owns the channel list, the selection and the
// delete flow, and composes the create- and edit-channel form state from useCreateChannelForm /
// useEditChannelForm rather than flattening every field into this one hook. The create/save/delete
// calls stay here because they need the channel actions (useChannelActions). The forms own only
// their own fields. The returned shape stays flat so consumers are unchanged.
export function useChannels({
    libraryPath,
    onError,
    onNotice,
}: UseChannelsOptions): ChannelsController {
    const [channels, setChannels] = useState<Channel[]>([]);
    const [selectedChannelId, setSelectedChannelId] = useState<number | null>(null);

    const [confirmDeleteChannelOpen, setConfirmDeleteChannelOpen] = useState(false);
    const [channelToDelete, setChannelToDelete] = useState<Channel | null>(null);
    const [channelToDeleteMediaCount, setChannelToDeleteMediaCount] = useState<number | null>(
        null
    );

    // Latest wins over the count query. A second delete request before the first count answers
    // must not land the first channel's number under the second channel's name.
    const deleteCountGuard = useRequestGuard();

    const createForm = useCreateChannelForm({ onError });
    const editForm = useEditChannelForm();

    const previousLibraryPathRef = useRef(libraryPath);
    const hasLoadedInitialRef = useRef(false);

    const channelActions = useChannelActions({
        libraryPath,
        onError,
        onNotice,
        selectedChannelId,
        setChannels,
        setSelectedChannelId,
        setNewChannelName: createForm.setNewChannelName,
        setNewYoutubeHandle: createForm.setNewYoutubeHandle,
        setNewChannelAvatarMode: createForm.setNewChannelAvatarMode,
        setNewChannelAvatarPath: createForm.setNewChannelAvatarPath,
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
        updateChannelImageAction,
        loadChannels,
    } = channelActions;

    // Form fields and controls the callbacks/effects below and the return object read, pulled off
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

    const requestDeleteChannel = useCallback(
        (channel: Channel): void => {
            setChannelToDelete(channel);
            setChannelToDeleteMediaCount(null);
            setConfirmDeleteChannelOpen(true);

            // The confirmation opens at once, on its generic wording, and the count lands under
            // it when the query answers. A failure is logged and leaves the wording generic. The
            // delete never waits on this number and never depends on it.
            const requestId = deleteCountGuard.begin();

            void (async () => {
                try {
                    const page = await listChannelMediaPage(channel.id, COUNT_ONLY_QUERY);

                    if (deleteCountGuard.isCurrent(requestId)) {
                        setChannelToDeleteMediaCount(page.total);
                    }
                } catch (error) {
                    logError("channels", "Failed to count the media of the channel to delete.", error, {
                        channelId: channel.id,
                    });
                }
            })();
        },
        [deleteCountGuard]
    );

    const updateChannelImageFromFile = useCallback(
        async (kind: ChannelImageKind, channel: Channel): Promise<void> => {
            let picked: string | null;

            // Only the dialog is in here. The update reports its own failures, and the generic
            // message below would have hidden them.
            try {
                picked = await pickImageFilePath();
            } catch (error) {
                logError("channels", `Failed to open the ${kind} file dialog.`, error);
                onError(`Failed to select the ${kind} file.`);
                return;
            }

            if (picked) {
                await updateChannelImageAction(kind, channel, "manual", picked);
            }
        },
        [updateChannelImageAction, onError]
    );

    // The sidebar's menu items, three per image.
    const channelImageMenu = useMemo(
        () => ({
            updateChannelAvatarFromFile: (channel: Channel) =>
                updateChannelImageFromFile("avatar", channel),
            updateChannelAvatarFromYouTube: (channel: Channel) =>
                updateChannelImageAction("avatar", channel, "youtube"),
            removeChannelAvatar: (channel: Channel) =>
                updateChannelImageAction("avatar", channel, "none"),
            updateChannelBannerFromFile: (channel: Channel) =>
                updateChannelImageFromFile("banner", channel),
            updateChannelBannerFromYouTube: (channel: Channel) =>
                updateChannelImageAction("banner", channel, "youtube"),
            removeChannelBanner: (channel: Channel) =>
                updateChannelImageAction("banner", channel, "none"),
        }),
        [updateChannelImageAction, updateChannelImageFromFile]
    );

    const closeDeleteChannelModal = useCallback((): void => {
        if (channelActions.isDeletingChannel) {
            return;
        }

        deleteCountGuard.invalidate();
        setConfirmDeleteChannelOpen(false);
        setChannelToDelete(null);
        setChannelToDeleteMediaCount(null);
    }, [channelActions.isDeletingChannel, deleteCountGuard]);

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
        setChannelToDeleteMediaCount(null);
        setConfirmDeleteChannelOpen(false);
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
        channelToDeleteMediaCount,

        isLoadingChannels,
        channelsLoadFailed: channelActions.channelsLoadFailed,
        reloadChannels: loadChannels,
        isCreatingChannel,
        isDeletingChannel,
        isUpdatingChannelImage: channelActions.isUpdatingChannelImage,
        updatingChannelAvatarId: channelActions.updatingChannelAvatarId,
        updatingChannelBannerId: channelActions.updatingChannelBannerId,

        setSelectedChannelId,
        createChannel,
        requestDeleteChannel,
        ...channelImageMenu,
        confirmDeleteChannel,
        closeDeleteChannelModal,
    });
}
