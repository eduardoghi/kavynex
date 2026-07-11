import { useCallback, useMemo } from "react";
import type {
    AppSettingsController,
    ChannelsController,
    HomeUiGuardsController,
    MediaLibraryController,
    MediaPlayerController,
} from "../types/controllers";
import type { MediaPreparationState } from "../utils/media-operation-busy";
import {
    isMediaOperationBusy,
    resolveMediaOperationBusyReason,
} from "../utils/media-operation-busy";

type UseHomeUiGuardsOptions = {
    settingsState: AppSettingsController;
    mediaLibrary: MediaLibraryController;
    channelsState: Pick<ChannelsController, "isUpdatingChannelAvatar">;
};

type LibraryPathChangeGuardInput = {
    libraryPath: string;
    isMigratingLibraryPath: boolean;
    isUpdatingChannelAvatar: boolean;
    mediaPreparationState: MediaPreparationState;
    playerViewMode: MediaPlayerController["viewMode"];
};

function resolveLibraryPathChangeDisabledReason({
    libraryPath,
    isMigratingLibraryPath,
    isUpdatingChannelAvatar,
    mediaPreparationState,
    playerViewMode,
}: LibraryPathChangeGuardInput): string {
    const hasExistingLibraryPath = libraryPath.trim() !== "";

    if (isMigratingLibraryPath) {
        return hasExistingLibraryPath
            ? "Library migration is in progress."
            : "Library folder setup is in progress.";
    }

    if (isUpdatingChannelAvatar) {
        return "Wait for the channel avatar update to finish before changing the library folder.";
    }

    const mediaOperationReason = resolveMediaOperationBusyReason(mediaPreparationState);

    if (mediaOperationReason) {
        return mediaOperationReason;
    }

    if (playerViewMode === "player") {
        return "Close the player before changing the library folder.";
    }

    return "";
}

export function useHomeUiGuards({
    settingsState,
    mediaLibrary,
    channelsState,
}: UseHomeUiGuardsOptions): HomeUiGuardsController {
    // Destructure the stable fields off the per-render controller objects so the memos and
    // callback below can depend on them directly, instead of passing the whole per-render
    // objects into helper functions called from inside them. This keeps the dependency arrays
    // honest (no eslint-disable) while the computed values stay identical.
    const { isAddingMedia, isYtDlpRunning, isCancellingYtDlp, closeAddMediaModal } = mediaLibrary;
    const { isGeneratingThumb, isLoadingYtDlpFormats } = mediaLibrary.addMediaForm;
    const { viewMode: playerViewMode } = mediaLibrary.mediaPlayer;
    const { settings, isMigratingLibraryPath } = settingsState;
    const { libraryPath: settingsLibraryPath } = settings;
    const { isUpdatingChannelAvatar } = channelsState;

    const mediaPreparationState = useMemo<MediaPreparationState>(
        () => ({
            isAddingMedia,
            isYtDlpRunning,
            isCancellingYtDlp,
            isGeneratingThumb,
            isLoadingYtDlpFormats,
        }),
        [isAddingMedia, isYtDlpRunning, isCancellingYtDlp, isGeneratingThumb, isLoadingYtDlpFormats]
    );

    // Deleting a channel while a download for it is in flight would make the pending
    // insert fail against a missing channel and waste the whole download.
    const channelDeletionDisabledReason = useMemo(() => {
        if (isMediaOperationBusy(mediaPreparationState)) {
            return "Wait for the media import or download to finish before deleting a channel.";
        }

        return "";
    }, [mediaPreparationState]);

    const disableChannelDeletion = useMemo(() => {
        return !!channelDeletionDisabledReason;
    }, [channelDeletionDisabledReason]);

    const libraryPathChangeDisabledReason = useMemo(() => {
        return resolveLibraryPathChangeDisabledReason({
            libraryPath: settingsLibraryPath,
            isMigratingLibraryPath,
            isUpdatingChannelAvatar,
            mediaPreparationState,
            playerViewMode,
        });
    }, [
        settingsLibraryPath,
        isMigratingLibraryPath,
        isUpdatingChannelAvatar,
        mediaPreparationState,
        playerViewMode,
    ]);

    const disableLibraryPathChange = useMemo(() => {
        return !!libraryPathChangeDisabledReason;
    }, [libraryPathChangeDisabledReason]);

    const closeAddMediaModalSafely = useCallback(async (): Promise<void> => {
        if (isMediaOperationBusy(mediaPreparationState)) {
            return;
        }

        await closeAddMediaModal();
    }, [mediaPreparationState, closeAddMediaModal]);

    return {
        disableLibraryPathChange,
        libraryPathChangeDisabledReason,
        disableChannelDeletion,
        channelDeletionDisabledReason,
        closeAddMediaModalSafely,
    };
}
