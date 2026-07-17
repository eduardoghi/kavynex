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
import { useStartupUpdateCheck } from "./use-startup-update-check";

export function useHomeController(): HomeController {
    const errorState = useErrorModal();

    const databaseRecovery = useAppBootstrap({
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
        onNotice: errorState.showNotice,
    });

    const diagnosticsState = useDiagnostics({
        libraryPath,
        importMode,
        onError: errorState.showError,
    });

    // Opt-in passive update check: when enabled (Settings > Application update), checks once on
    // startup and surfaces a non-intrusive notice if a newer version exists. Off by default.
    useStartupUpdateCheck({
        enabled: settingsState.settings.checkUpdatesOnStartup,
        onUpdateAvailable: errorState.showNotice,
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
        confirmDeleteChannelFlow: homeActions.confirmDeleteChannel,
    });

    const playerActions = useHomePlayerActions({
        mediaPlayer: mediaLibrary.mediaPlayer,
        homeMediaActions,
        onError: errorState.showError,
        refreshComments: mediaLibrary.refreshComments,
        commentsInFlight: mediaLibrary.commentsInFlight,
        libraryPath,
    });

    const playerPanelState = useHomePlayerPanel({
        mediaPlayer: mediaLibrary.mediaPlayer,
    });

    const viewState = useHomeViewState({
        selectedChannel: channelsState.selectedChannel,
        hasChannels: channelsState.channels.length > 0,
        isLoadingChannels: channelsState.isLoadingChannels,
        isPreparingSettings: settingsState.isPreparingSettings,
        mediaPlayer: mediaLibrary.mediaPlayer,
    });

    const libraryPanelState = useHomeLibraryPanel({
        selectedChannel: channelsState.selectedChannel,
        channelMediaTotal: mediaLibrary.channelMediaTotal,
        viewMode: mediaLibrary.mediaPlayer.viewMode,
        isLoadingMedia: mediaLibrary.isLoadingMedia,
        isAddingMedia: mediaLibrary.isAddingMedia,
        isMigratingLibraryPath: settingsState.isMigratingLibraryPath,
        libraryPath,
    });

    return {
        channels: channelsState,
        media: mediaLibrary,
        // chooseLibraryPath is orchestrated at the Home level (UI-guard checks), so it
        // replaces the raw settings-hook version while the rest of the slice passes through.
        settings: {
            ...settingsState,
            chooseLibraryPath: homeActions.chooseLibraryPath,
        },
        diagnostics: diagnosticsState,
        error: errorState,
        databaseRecovery,
        uiGuards,
        mediaActions: homeMediaActions,
        playerActions,
        playerPanelState,
        viewState,
        libraryPanelState,
        libraryPath,
    };
}