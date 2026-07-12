import { useCallback } from "react";
import type {
    AppSettingsController,
    ChannelsController,
    ErrorModalController,
    HomeUiGuardsController,
    MediaLibraryController,
} from "../types/controllers";
import { executeDeleteSelectedChannel } from "../use-cases/delete-selected-channel";
import { resolveErrorMessage } from "../utils/error-message";
import { logError } from "../utils/app-logger";
import { useMemoObject } from "./use-memo-object";

type UseHomeActionsOptions = {
    errorState: ErrorModalController;
    settingsState: AppSettingsController;
    channelsState: ChannelsController;
    mediaLibrary: MediaLibraryController;
    uiGuards: HomeUiGuardsController;
};

type UseHomeActionsReturn = {
    chooseLibraryPath: () => Promise<void>;
    confirmDeleteChannel: () => Promise<void>;
};

export function useHomeActions({
    errorState,
    settingsState,
    channelsState,
    mediaLibrary,
    uiGuards,
}: UseHomeActionsOptions): UseHomeActionsReturn {
    // Destructure the stable fields off the per-render controller objects so the callbacks
    // below can depend on them directly. This keeps the dependency arrays honest (no
    // eslint-disable) while still not depending on the whole objects, whose identity changes
    // every render. Fields that collide with a name this hook exports get an "Action" suffix.
    const { showError } = errorState;
    const { chooseLibraryPath: chooseLibraryPathAction } = settingsState;
    const {
        setSelectedChannelId,
        selectedChannelId,
        channelToDelete,
        confirmDeleteChannel: confirmDeleteChannelAction,
    } = channelsState;
    const { resetForm: resetAddMediaForm } = mediaLibrary.addMediaForm;
    const { addMediaOpen, clearMediaAndPlayer, setAddMediaOpen } = mediaLibrary;
    const {
        disableChannelDeletion,
        channelDeletionDisabledReason,
        disableLibraryPathChange,
        libraryPathChangeDisabledReason,
    } = uiGuards;

    const closeSelectedChannelUiBeforeDelete = useCallback(async (): Promise<void> => {
        setSelectedChannelId(null);
        clearMediaAndPlayer();

        if (addMediaOpen) {
            await resetAddMediaForm();
            setAddMediaOpen(false);
        }
    }, [
        setSelectedChannelId,
        resetAddMediaForm,
        addMediaOpen,
        clearMediaAndPlayer,
        setAddMediaOpen,
    ]);

    const confirmDeleteChannel = useCallback(async (): Promise<void> => {
        if (disableChannelDeletion) {
            showError(channelDeletionDisabledReason || "You cannot delete a channel right now.");
            return;
        }

        try {
            const channelToDeleteId = channelToDelete?.id ?? null;

            await executeDeleteSelectedChannel({
                selectedChannelId,
                channelToDeleteId,
                closeSelectedChannelUiBeforeDelete,
                confirmDeleteChannel: confirmDeleteChannelAction,
            });
        } catch (error) {
            logError("home-actions", "Failed to confirm channel deletion.", error, {
                selectedChannelId,
                channelToDeleteId: channelToDelete?.id ?? null,
            });
            showError(resolveErrorMessage(error, "Failed to delete channel."));
        }
    }, [
        selectedChannelId,
        channelToDelete,
        confirmDeleteChannelAction,
        closeSelectedChannelUiBeforeDelete,
        showError,
        disableChannelDeletion,
        channelDeletionDisabledReason,
    ]);

    const chooseLibraryPath = useCallback(async (): Promise<void> => {
        if (disableLibraryPathChange) {
            showError(
                libraryPathChangeDisabledReason ||
                    "You cannot change the library folder right now."
            );
            return;
        }

        try {
            await chooseLibraryPathAction();
        } catch (error) {
            logError("home-actions", "Failed to choose library path.", error);
            showError(resolveErrorMessage(error, "Failed to choose library folder."));
        }
    }, [
        showError,
        chooseLibraryPathAction,
        disableLibraryPathChange,
        libraryPathChangeDisabledReason,
    ]);

    return useMemoObject({
        chooseLibraryPath,
        confirmDeleteChannel,
    });
}