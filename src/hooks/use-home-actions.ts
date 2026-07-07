import { useCallback, useMemo } from "react";
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
    const closeSelectedChannelUiBeforeDelete = useCallback(async (): Promise<void> => {
        channelsState.setSelectedChannelId(null);
        mediaLibrary.clearMediaAndPlayer();

        if (mediaLibrary.addMediaOpen) {
            await mediaLibrary.addMediaForm.resetForm();
            mediaLibrary.setAddMediaOpen(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the specific fields read inside, not the whole per-render channelsState/mediaLibrary objects
    }, [
        channelsState.setSelectedChannelId,
        mediaLibrary.addMediaForm.resetForm,
        mediaLibrary.addMediaOpen,
        mediaLibrary.clearMediaAndPlayer,
        mediaLibrary.setAddMediaOpen,
    ]);

    const confirmDeleteChannel = useCallback(async (): Promise<void> => {
        if (uiGuards.disableChannelDeletion) {
            errorState.showError(
                uiGuards.channelDeletionDisabledReason ||
                    "You cannot delete a channel right now."
            );
            return;
        }

        try {
            const channelToDeleteId = channelsState.channelToDelete?.id ?? null;

            await executeDeleteSelectedChannel({
                selectedChannelId: channelsState.selectedChannelId,
                channelToDeleteId,
                closeSelectedChannelUiBeforeDelete,
                confirmDeleteChannel: channelsState.confirmDeleteChannel,
            });
        } catch (error) {
            logError("home-actions", "Failed to confirm channel deletion.", error, {
                selectedChannelId: channelsState.selectedChannelId,
                channelToDeleteId: channelsState.channelToDelete?.id ?? null,
            });
            errorState.showError(resolveErrorMessage(error, "Failed to delete channel."));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the specific fields read inside, not the whole per-render errorState/uiGuards objects
    }, [
        channelsState.selectedChannelId,
        channelsState.channelToDelete,
        channelsState.confirmDeleteChannel,
        closeSelectedChannelUiBeforeDelete,
        errorState.showError,
        uiGuards.disableChannelDeletion,
        uiGuards.channelDeletionDisabledReason,
    ]);

    const chooseLibraryPath = useCallback(async (): Promise<void> => {
        if (uiGuards.disableLibraryPathChange) {
            errorState.showError(
                uiGuards.libraryPathChangeDisabledReason ||
                    "You cannot change the library folder right now."
            );
            return;
        }

        try {
            await settingsState.chooseLibraryPath();
        } catch (error) {
            logError("home-actions", "Failed to choose library path.", error);
            errorState.showError(resolveErrorMessage(error, "Failed to choose library folder."));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the specific fields read inside, not the whole per-render errorState/settingsState/uiGuards objects
    }, [
        errorState.showError,
        settingsState.chooseLibraryPath,
        uiGuards.disableLibraryPathChange,
        uiGuards.libraryPathChangeDisabledReason,
    ]);

    return useMemo(
        () => ({
            chooseLibraryPath,
            confirmDeleteChannel,
        }),
        [chooseLibraryPath, confirmDeleteChannel]
    );
}