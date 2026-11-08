import { useCallback } from "react";
import type { ChannelsController } from "../channels/use-channels";
import type { MediaLibraryController } from "../media/use-media-library";
import type { AppSettingsController } from "../settings/use-app-settings";
import type { ErrorModalController } from "../use-error-modal";
import type { HomeUiGuardsController } from "./use-home-ui-guards";
import { executeDeleteSelectedChannel } from "../../use-cases/delete-selected-channel";
import { resolveErrorMessage } from "../../utils/error-message";
import { logError } from "../../utils/app-logger";
import { useMemoObject } from "../use-memo-object";

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
    // The fields used below, not the whole controller (see CONTRIBUTING.md's hook conventions).
    // Fields that collide with a name this hook exports get an "Action" suffix.
    const { showError } = errorState;
    const { chooseLibraryPath: chooseLibraryPathAction } = settingsState;
    const {
        setSelectedChannelId,
        selectedChannelId,
        channelToDelete,
        confirmDeleteChannel: confirmDeleteChannelAction,
    } = channelsState;
    const { resetForm: resetAddMediaForm } = mediaLibrary.adding.addMediaForm;
    const { clearMediaAndPlayer } = mediaLibrary;
    const { addMediaOpen, setAddMediaOpen } = mediaLibrary.adding;
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
            showError(channelDeletionDisabledReason);
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
            showError(libraryPathChangeDisabledReason);
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