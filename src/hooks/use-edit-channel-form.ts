import { useCallback, useState } from "react";
import type { Channel } from "../types/media";

export type EditChannelFormController = {
    editChannelOpen: boolean;
    // Sets the modal open flag; closing (false) also clears the fields.
    setEditChannelOpen: (value: boolean) => void;
    // Closes the modal WITHOUT clearing the fields, for callers that clear them separately.
    closeEditChannelForm: () => void;
    resetEditChannelForm: () => void;
    editingChannel: Channel | null;
    editChannelName: string;
    setEditChannelName: (value: string) => void;
    editYoutubeHandle: string;
    setEditYoutubeHandle: (value: string) => void;
    // Opens the modal populated from `channel`.
    requestEditChannel: (channel: Channel) => void;
};

// The edit-channel modal's form state, extracted from useChannels so that hook composes focused
// slices instead of flattening every channel concern into one. Owns only the edit fields and the
// modal open flag; the save call stays in useChannels, which holds the channel actions.
export function useEditChannelForm(): EditChannelFormController {
    const [editChannelOpen, setEditChannelOpenState] = useState(false);
    const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
    const [editChannelName, setEditChannelName] = useState("");
    const [editYoutubeHandle, setEditYoutubeHandle] = useState("");

    const resetEditChannelForm = useCallback((): void => {
        setEditingChannel(null);
        setEditChannelName("");
        setEditYoutubeHandle("");
    }, []);

    const setEditChannelOpen = useCallback(
        (value: boolean): void => {
            setEditChannelOpenState(value);

            if (!value) {
                resetEditChannelForm();
            }
        },
        [resetEditChannelForm]
    );

    const closeEditChannelForm = useCallback((): void => {
        setEditChannelOpenState(false);
    }, []);

    const requestEditChannel = useCallback((channel: Channel): void => {
        setEditingChannel(channel);
        setEditChannelName(channel.name);
        setEditYoutubeHandle(channel.youtube_handle);
        setEditChannelOpenState(true);
    }, []);

    return {
        editChannelOpen,
        setEditChannelOpen,
        closeEditChannelForm,
        resetEditChannelForm,
        editingChannel,
        editChannelName,
        setEditChannelName,
        editYoutubeHandle,
        setEditYoutubeHandle,
        requestEditChannel,
    };
}
