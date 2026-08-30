import { useMemo } from "react";
import { useMemoObject } from "../use-memo-object";
import type { HomeController } from "../../types/controllers";
import { useChannels } from "../channels/use-channels";
import { useMediaLibrary } from "../media/use-media-library";
import { useDiagnostics } from "../use-diagnostics";
import { useErrorModal } from "../use-error-modal";
import { useAppBootstrap } from "../use-app-bootstrap";
import { useAppSettings } from "../settings/use-app-settings";
import { useHomeUiGuards } from "./use-home-ui-guards";
import { useHomeActions } from "./use-home-actions";
import { useHomeMediaActions } from "./use-home-media-actions";
import { useHomeViewState } from "./use-home-view-state";
import { useHomePlayerActions } from "./use-home-player-actions";
import { useHomeLibraryPanel } from "./use-home-library-panel";
import { useHomePlayerPanel } from "./use-home-player-panel";
import { useStartupUpdateCheck } from "../use-startup-update-check";
import { useDatabaseIntegrityAlert } from "../use-database-integrity-alert";
import { usePendingMediaAlert } from "../use-pending-media-alert";

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

    // Opt-in passive update check. When enabled (Settings > Application update), checks once on
    // startup and surfaces a non-intrusive notice if a newer version exists. Off by default.
    useStartupUpdateCheck({
        enabled: settingsState.settings.checkUpdatesOnStartup,
        onUpdateAvailable: errorState.showNotice,
    });

    // Surfaces a proactive warning if the background full integrity check reports the database may
    // be corrupt, instead of leaving that failure only in the log file.
    useDatabaseIntegrityAlert({
        onIntegrityFailure: errorState.showError,
    });

    // The same treatment for the startup sweep giving up on a crashed media creation. Its files stay
    // in the library with nothing pointing at them, and Diagnostics is where to deal with them. A
    // notice rather than an error, since nothing is broken and nothing was lost.
    usePendingMediaAlert({
        onArtifactsAbandoned: errorState.showNotice,
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
        cancelRefreshComments: mediaLibrary.cancelRefreshComments,
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
        libraryPath,
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

    // chooseLibraryPath is orchestrated at the Home level (UI-guard checks), so it replaces the
    // raw settings-hook version while the rest of the slice passes through. Memoized so this
    // override does not allocate a new settings object (defeating useAppSettings's own
    // memoization) on every render of the controller.
    const settings = useMemo(
        () => ({
            ...settingsState,
            chooseLibraryPath: homeActions.chooseLibraryPath,
        }),
        [settingsState, homeActions.chooseLibraryPath]
    );

    // Reference-stable controller, per the hook conventions in CONTRIBUTING.md. Its identity only
    // changes when one of its (already individually memoized) slices does, rather than every render.
    return useMemoObject({
        channels: channelsState,
        media: mediaLibrary,
        settings,
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
    });
}