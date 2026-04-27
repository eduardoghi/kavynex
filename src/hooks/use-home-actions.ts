import { useCallback } from "react";
import type {
    AppSettingsController,
    ChannelsController,
    ErrorModalController,
    HomeUiGuardsController,
    MediaLibraryController,
} from "../types/controllers";
import { deleteChannelMediaFiles } from "../services/media-service";
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
    }, [channelsState, mediaLibrary]);

    const confirmDeleteChannel = useCallback(async (): Promise<void> => {
        try {
            const channelToDeleteId = channelsState.channelToDelete?.id ?? null;

            await executeDeleteSelectedChannel({
                selectedChannelId: channelsState.selectedChannelId,
                channelToDeleteId,
                closeSelectedChannelUiBeforeDelete,
                deleteChannelMediaFilesBeforeDelete: async () => {
                    if (channelToDeleteId === null) {
                        return;
                    }

                    await deleteChannelMediaFiles(
                        channelToDeleteId,
                        settingsState.settings.libraryPath
                    );
                },
                confirmDeleteChannel: channelsState.confirmDeleteChannel,
            });
        } catch (error) {
            logError("home-actions", "Failed to confirm channel deletion.", error, {
                selectedChannelId: channelsState.selectedChannelId,
                channelToDeleteId: channelsState.channelToDelete?.id ?? null,
            });
            errorState.showError(resolveErrorMessage(error, "Failed to delete channel."));
        }
    }, [
        channelsState.selectedChannelId,
        channelsState.channelToDelete,
        channelsState.confirmDeleteChannel,
        closeSelectedChannelUiBeforeDelete,
        errorState,
        settingsState.settings.libraryPath,
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
    }, [errorState, settingsState, uiGuards]);

    return {
        chooseLibraryPath,
        confirmDeleteChannel,
    };
}