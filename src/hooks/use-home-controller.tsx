import type { HomeController } from "../types/controllers";
import { useChannels } from "./use-channels";
import { useMediaLibrary } from "./use-media-library";
import { useDiagnostics } from "./use-diagnostics";
import { useErrorModal } from "./use-error-modal";
import { useAppBootstrap } from "./use-app-bootstrap";
import { useAppSettings } from "./use-app-settings";
import { useHomeUiGuards } from "./use-home-ui-guards";
import { useHomeActions } from "./use-home-actions";
import { useHomeMediaActions } from "./use-home-media-actions";
import { useHomeViewState } from "./use-home-view-state";
import { useHomePlayerActions } from "./use-home-player-actions";
import { useHomeLibraryPanel } from "./use-home-library-panel";
import { useHomePlayerPanel } from "./use-home-player-panel";

export function useHomeController(): HomeController {
    const errorState = useErrorModal();

    useAppBootstrap({
        onError: errorState.showError,
    });

    const settingsState = useAppSettings({
        onError: errorState.showError,
    });

    const libraryPath = settingsState.settings.libraryPath;
    const importMode = settingsState.settings.importMode;

    const channelsState = useChannels({
        libraryPath,
        onError: errorState.showError,
    });

    const mediaLibrary = useMediaLibrary({
        selectedChannelId: channelsState.selectedChannelId,
        importMode,
        libraryPath,
        onError: errorState.showError,
    });

    const diagnosticsState = useDiagnostics({
        libraryPath,
        importMode,
        onError: errorState.showError,
    });

    const uiGuards = useHomeUiGuards({
        settingsState,
        mediaLibrary,
        channelsState,
    });

    const homeActions = useHomeActions({
        errorState,
        settingsState,
        channelsState,
        mediaLibrary,
        uiGuards,
    });

    const homeMediaActions = useHomeMediaActions({
        diagnosticsState,
        mediaLibrary,
        channelsState,
        confirmDeleteChannelFlow: homeActions.confirmDeleteChannel,
    });

    const playerActions = useHomePlayerActions({
        mediaPlayer: mediaLibrary.mediaPlayer,
        homeMediaActions,
        onError: errorState.showError,
        onReloadMedia: mediaLibrary.loadMedia,
        libraryPath,
    });

    const playerPanelState = useHomePlayerPanel({
        mediaPlayer: mediaLibrary.mediaPlayer,
    });

    const viewState = useHomeViewState({
        selectedChannel: channelsState.selectedChannel,
        isLoadingChannels: channelsState.isLoadingChannels,
        isPreparingSettings: settingsState.isPreparingSettings,
        mediaPlayer: mediaLibrary.mediaPlayer,
    });

    const libraryPanelState = useHomeLibraryPanel({
        selectedChannel: channelsState.selectedChannel,
        mediaItems: mediaLibrary.mediaItems,
        viewMode: mediaLibrary.mediaPlayer.viewMode,
        isLoadingMedia: mediaLibrary.isLoadingMedia,
        isAddingMedia: mediaLibrary.isAddingMedia,
        isMigratingLibraryPath: settingsState.isMigratingLibraryPath,
        libraryPath,
    });

    return {
        channels: channelsState.channels,
        selectedChannelId: channelsState.selectedChannelId,
        selectedChannel: channelsState.selectedChannel,
        mediaItems: mediaLibrary.mediaItems,

        createChannelOpen: channelsState.createChannelOpen,
        setCreateChannelOpen: channelsState.setCreateChannelOpen,
        newChannelName: channelsState.newChannelName,
        setNewChannelName: channelsState.setNewChannelName,
        newYoutubeHandle: channelsState.newYoutubeHandle,
        setNewYoutubeHandle: channelsState.setNewYoutubeHandle,
        newChannelAvatarMode: channelsState.newChannelAvatarMode,
        setNewChannelAvatarMode: channelsState.setNewChannelAvatarMode,
        newChannelAvatarPath: channelsState.newChannelAvatarPath,
        setNewChannelAvatarPath: channelsState.setNewChannelAvatarPath,
        pickChannelAvatarViaDialog: channelsState.pickChannelAvatarViaDialog,
        clearNewChannelAvatarPath: channelsState.clearNewChannelAvatarPath,

        editChannelOpen: channelsState.editChannelOpen,
        setEditChannelOpen: channelsState.setEditChannelOpen,
        editingChannel: channelsState.editingChannel,
        editChannelName: channelsState.editChannelName,
        setEditChannelName: channelsState.setEditChannelName,
        editYoutubeHandle: channelsState.editYoutubeHandle,
        setEditYoutubeHandle: channelsState.setEditYoutubeHandle,
        saveEditedChannel: channelsState.saveEditedChannel,
        isEditingChannel: channelsState.isEditingChannel,

        addMediaOpen: mediaLibrary.addMediaOpen,
        setAddMediaOpen: mediaLibrary.setAddMediaOpen,
        closeAddMediaModal: uiGuards.closeAddMediaModalSafely,

        confirmDeleteMediaOpen: mediaLibrary.confirmDeleteMediaOpen,
        mediaToDelete: mediaLibrary.mediaToDelete,

        confirmDeleteChannelOpen: channelsState.confirmDeleteChannelOpen,
        channelToDelete: channelsState.channelToDelete,

        diagnosticsOpen: diagnosticsState.diagnosticsOpen,
        diagnosticsSummary: diagnosticsState.diagnosticsSummary,
        isLoadingDiagnostics: diagnosticsState.isLoadingDiagnostics,
        openDiagnostics: diagnosticsState.openDiagnostics,
        closeDiagnostics: diagnosticsState.closeDiagnostics,
        reloadDiagnostics: diagnosticsState.reloadDiagnostics,

        isLoadingChannels: channelsState.isLoadingChannels,
        isCreatingChannel: channelsState.isCreatingChannel,
        isDeletingChannel: channelsState.isDeletingChannel,
        isUpdatingChannelAvatar: channelsState.isUpdatingChannelAvatar,
        updatingChannelAvatarId: channelsState.updatingChannelAvatarId,
        isLoadingMedia: mediaLibrary.isLoadingMedia,
        isAddingMedia: mediaLibrary.isAddingMedia,
        isDeletingMedia: mediaLibrary.isDeletingMedia,
        isUpdatingWatched: mediaLibrary.isUpdatingWatched,
        isUpdatingTitle: mediaLibrary.isUpdatingTitle,
        isCancellingYtDlp: mediaLibrary.isCancellingYtDlp,

        ytDlpLogs: mediaLibrary.ytDlpLogs,
        isYtDlpRunning: mediaLibrary.isYtDlpRunning,

        errorOpen: errorState.errorOpen,
        errorMessage: errorState.errorMessage,

        addMediaForm: mediaLibrary.addMediaForm,
        mediaPlayer: mediaLibrary.mediaPlayer,
        playerActions,
        playerPanelState,
        viewState,
        libraryPanelState,

        settingsOpen: settingsState.settingsOpen,
        importMode,
        libraryPath,
        isPreparingSettings: settingsState.isPreparingSettings,
        isMigratingLibraryPath: settingsState.isMigratingLibraryPath,
        openSettings: settingsState.openSettings,
        closeSettings: settingsState.closeSettings,
        setImportMode: settingsState.setImportMode,
        chooseLibraryPath: homeActions.chooseLibraryPath,
        openCurrentLibraryPath: settingsState.openCurrentLibraryPath,
        disableLibraryPathChange: uiGuards.disableLibraryPathChange,
        libraryPathChangeDisabledReason: uiGuards.libraryPathChangeDisabledReason,

        setSelectedChannelId: channelsState.setSelectedChannelId,

        createChannel: channelsState.createChannel,
        addMedia: homeMediaActions.addMedia,
        cancelYtDlpDownload: mediaLibrary.cancelYtDlpDownload,
        markAsWatched: homeMediaActions.markAsWatched,
        markAsUnwatched: homeMediaActions.markAsUnwatched,
        editMediaTitle: homeMediaActions.editMediaTitle,
        openMediaFileLocation: mediaLibrary.openMediaFileLocation,
        openMediaSourceInYoutube: mediaLibrary.openMediaSourceInYoutube,

        requestDeleteMedia: mediaLibrary.requestDeleteMedia,
        confirmDeleteMedia: homeMediaActions.confirmDeleteMedia,
        closeDeleteMediaModal: mediaLibrary.closeDeleteMediaModal,

        requestEditChannel: channelsState.requestEditChannel,
        requestDeleteChannel: channelsState.requestDeleteChannel,
        updateChannelAvatarFromFile: channelsState.updateChannelAvatarFromFile,
        updateChannelAvatarFromYouTube: channelsState.updateChannelAvatarFromYouTube,
        removeChannelAvatar: channelsState.removeChannelAvatar,
        confirmDeleteChannel: homeMediaActions.confirmDeleteChannel,
        closeDeleteChannelModal: channelsState.closeDeleteChannelModal,

        closeErrorModal: errorState.closeErrorModal,
    };
}