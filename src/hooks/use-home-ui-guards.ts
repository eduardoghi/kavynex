import { useCallback, useMemo } from "react";
import type {
    AppSettingsController,
    ChannelsController,
    HomeUiGuardsController,
    MediaLibraryController,
} from "../types/controllers";
import {
    isMediaOperationBusy,
    resolveMediaOperationBusyReason,
} from "../utils/media-operation-busy";

type UseHomeUiGuardsOptions = {
    settingsState: AppSettingsController;
    mediaLibrary: MediaLibraryController;
    channelsState: Pick<ChannelsController, "isUpdatingChannelAvatar">;
};

function buildMediaPreparationState(mediaLibrary: MediaLibraryController) {
    return {
        isAddingMedia: mediaLibrary.isAddingMedia,
        isYtDlpRunning: mediaLibrary.isYtDlpRunning,
        isCancellingYtDlp: mediaLibrary.isCancellingYtDlp,
        isGeneratingThumb: mediaLibrary.addMediaForm.isGeneratingThumb,
        isLoadingYtDlpFormats: mediaLibrary.addMediaForm.isLoadingYtDlpFormats,
    };
}

function resolveLibraryPathChangeDisabledReason(
    settingsState: AppSettingsController,
    mediaLibrary: MediaLibraryController,
    isUpdatingChannelAvatar: boolean
): string {
    const hasExistingLibraryPath = settingsState.settings.libraryPath.trim() !== "";

    if (settingsState.isMigratingLibraryPath) {
        return hasExistingLibraryPath
            ? "Library migration is in progress."
            : "Library folder setup is in progress.";
    }

    if (isUpdatingChannelAvatar) {
        return "Wait for the channel avatar update to finish before changing the library folder.";
    }

    const mediaPreparationState = buildMediaPreparationState(mediaLibrary);
    const mediaOperationReason = resolveMediaOperationBusyReason(mediaPreparationState);

    if (mediaOperationReason) {
        return mediaOperationReason;
    }

    if (mediaLibrary.mediaPlayer.viewMode === "player") {
        return "Close the player before changing the library folder.";
    }

    return "";
}

export function useHomeUiGuards({
    settingsState,
    mediaLibrary,
    channelsState,
}: UseHomeUiGuardsOptions): HomeUiGuardsController {
    const isAddMediaModalLocked = useMemo(() => {
        return isMediaOperationBusy(buildMediaPreparationState(mediaLibrary));
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the specific primitives read inside, not the whole per-render mediaLibrary object
    }, [
        mediaLibrary.isAddingMedia,
        mediaLibrary.isYtDlpRunning,
        mediaLibrary.isCancellingYtDlp,
        mediaLibrary.addMediaForm.isGeneratingThumb,
        mediaLibrary.addMediaForm.isLoadingYtDlpFormats,
    ]);

    // Deleting a channel while a download for it is in flight would make the pending
    // insert fail against a missing channel and waste the whole download.
    const channelDeletionDisabledReason = useMemo(() => {
        if (isMediaOperationBusy(buildMediaPreparationState(mediaLibrary))) {
            return "Wait for the media import or download to finish before deleting a channel.";
        }

        return "";
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the specific primitives read inside, not the whole per-render mediaLibrary object
    }, [
        mediaLibrary.isAddingMedia,
        mediaLibrary.isYtDlpRunning,
        mediaLibrary.isCancellingYtDlp,
        mediaLibrary.addMediaForm.isGeneratingThumb,
        mediaLibrary.addMediaForm.isLoadingYtDlpFormats,
    ]);

    const disableChannelDeletion = useMemo(() => {
        return !!channelDeletionDisabledReason;
    }, [channelDeletionDisabledReason]);

    const libraryPathChangeDisabledReason = useMemo(() => {
        return resolveLibraryPathChangeDisabledReason(
            settingsState,
            mediaLibrary,
            channelsState.isUpdatingChannelAvatar
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the specific primitives read inside, not the whole per-render settingsState/mediaLibrary objects
    }, [
        settingsState.settings.libraryPath,
        settingsState.isMigratingLibraryPath,
        mediaLibrary.isAddingMedia,
        mediaLibrary.isYtDlpRunning,
        mediaLibrary.isCancellingYtDlp,
        mediaLibrary.addMediaForm.isGeneratingThumb,
        mediaLibrary.addMediaForm.isLoadingYtDlpFormats,
        mediaLibrary.mediaPlayer.viewMode,
        channelsState.isUpdatingChannelAvatar,
    ]);

    const disableLibraryPathChange = useMemo(() => {
        return !!libraryPathChangeDisabledReason;
    }, [libraryPathChangeDisabledReason]);

    const closeAddMediaModalSafely = useCallback(async (): Promise<void> => {
        if (isMediaOperationBusy(buildMediaPreparationState(mediaLibrary))) {
            return;
        }

        await mediaLibrary.closeAddMediaModal();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the specific primitives plus the stable memoized callback, not the whole per-render mediaLibrary object
    }, [
        mediaLibrary.isAddingMedia,
        mediaLibrary.isYtDlpRunning,
        mediaLibrary.isCancellingYtDlp,
        mediaLibrary.addMediaForm.isGeneratingThumb,
        mediaLibrary.addMediaForm.isLoadingYtDlpFormats,
        mediaLibrary.closeAddMediaModal,
    ]);

    return {
        isAddMediaModalLocked,
        disableLibraryPathChange,
        libraryPathChangeDisabledReason,
        disableChannelDeletion,
        channelDeletionDisabledReason,
        closeAddMediaModalSafely,
    };
}