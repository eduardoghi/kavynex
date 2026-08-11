import { useCallback, useState } from "react";
import type { ChannelAvatarMode } from "../../types/media";
import { pickImageFilePath } from "../../utils/pick-image-file";

type UseCreateChannelFormOptions = {
    onError: (message: string) => void;
};

export type CreateChannelFormController = {
    createChannelOpen: boolean;
    // Sets the modal open flag; closing (false) also clears the fields.
    setCreateChannelOpen: (value: boolean) => void;
    // Closes the modal WITHOUT clearing the fields, for the post-create-success path where the
    // channel action has already reset them (the wrapper above would redundantly reset again).
    closeCreateChannelForm: () => void;
    resetCreateChannelForm: () => void;
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
};

// The create-channel modal's form state, extracted from useChannels so that hook composes focused
// slices instead of flattening every channel concern into one. Owns only the new-channel fields, the
// modal open flag and the avatar picker; the actual create call stays in useChannels, which holds the
// channel actions.
export function useCreateChannelForm({
    onError,
}: UseCreateChannelFormOptions): CreateChannelFormController {
    const [createChannelOpen, setCreateChannelOpenState] = useState(false);
    const [newChannelName, setNewChannelName] = useState("");
    const [newYoutubeHandle, setNewYoutubeHandle] = useState("");
    const [newChannelAvatarMode, setNewChannelAvatarMode] = useState<ChannelAvatarMode>("none");
    const [newChannelAvatarPath, setNewChannelAvatarPath] = useState("");

    const resetCreateChannelForm = useCallback((): void => {
        setNewChannelName("");
        setNewYoutubeHandle("");
        setNewChannelAvatarMode("none");
        setNewChannelAvatarPath("");
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

    const closeCreateChannelForm = useCallback((): void => {
        setCreateChannelOpenState(false);
    }, []);

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

    return {
        createChannelOpen,
        setCreateChannelOpen,
        closeCreateChannelForm,
        resetCreateChannelForm,
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
    };
}
