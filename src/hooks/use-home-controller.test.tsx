import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHomeController } from "./use-home-controller";

vi.mock("./use-error-modal", () => ({
    useErrorModal: vi.fn(),
}));

vi.mock("./use-app-bootstrap", () => ({
    useAppBootstrap: vi.fn(),
}));

vi.mock("./use-app-settings", () => ({
    useAppSettings: vi.fn(),
}));

vi.mock("./use-channels", () => ({
    useChannels: vi.fn(),
}));

vi.mock("./use-media-library", () => ({
    useMediaLibrary: vi.fn(),
}));

vi.mock("./use-diagnostics", () => ({
    useDiagnostics: vi.fn(),
}));

vi.mock("./use-home-ui-guards", () => ({
    useHomeUiGuards: vi.fn(),
}));

vi.mock("./use-home-actions", () => ({
    useHomeActions: vi.fn(),
}));

vi.mock("./use-home-media-actions", () => ({
    useHomeMediaActions: vi.fn(),
}));

vi.mock("./use-home-player-actions", () => ({
    useHomePlayerActions: vi.fn(),
}));

vi.mock("./use-home-player-panel", () => ({
    useHomePlayerPanel: vi.fn(),
}));

vi.mock("./use-home-view-state", () => ({
    useHomeViewState: vi.fn(),
}));

vi.mock("./use-home-library-panel", () => ({
    useHomeLibraryPanel: vi.fn(),
}));

import { useErrorModal } from "./use-error-modal";
import { useAppBootstrap } from "./use-app-bootstrap";
import { useAppSettings } from "./use-app-settings";
import { useChannels } from "./use-channels";
import { useMediaLibrary } from "./use-media-library";
import { useDiagnostics } from "./use-diagnostics";
import { useHomeUiGuards } from "./use-home-ui-guards";
import { useHomeActions } from "./use-home-actions";
import { useHomeMediaActions } from "./use-home-media-actions";
import { useHomePlayerActions } from "./use-home-player-actions";
import { useHomePlayerPanel } from "./use-home-player-panel";
import { useHomeViewState } from "./use-home-view-state";
import { useHomeLibraryPanel } from "./use-home-library-panel";

const mockErrorState = {
    errorOpen: true,
    errorMessage: "boom",
    errorVariant: "error" as const,
    showError: vi.fn(),
    showNotice: vi.fn(),
    closeErrorModal: vi.fn(),
};

const mockSettingsState = {
    settingsOpen: false,
    settings: {
        importMode: "copy" as const,
        libraryPath: "/library",
        loadRemoteImages: true,
        checkUpdatesOnStartup: false,
        externalBackupDir: "",
    },
    isPreparingSettings: false,
    isMigratingLibraryPath: false,
    isSavingExternalBackupDir: false,
    openSettings: vi.fn(),
    closeSettings: vi.fn(),
    setImportMode: vi.fn(),
    setLoadRemoteImages: vi.fn(),
    setCheckUpdatesOnStartup: vi.fn(),
    chooseLibraryPath: vi.fn(),
    openCurrentLibraryPath: vi.fn(),
    chooseExternalBackupDir: vi.fn(),
    clearExternalBackupDir: vi.fn(),
};

const mockChannelsState = {
    channels: [
        {
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        },
    ],
    selectedChannelId: 10,
    selectedChannel: {
        id: 10,
        name: "Canal A",
        youtube_handle: "@canala",
        avatar_path: null,
        created_at: "2026-03-31T10:00:00.000Z",
    },

    createChannelOpen: false,
    setCreateChannelOpen: vi.fn(),
    newChannelName: "Canal A",
    setNewChannelName: vi.fn(),
    newYoutubeHandle: "@canala",
    setNewYoutubeHandle: vi.fn(),

    newChannelAvatarMode: "none" as const,
    setNewChannelAvatarMode: vi.fn(),
    newChannelAvatarPath: "",
    setNewChannelAvatarPath: vi.fn(),
    pickChannelAvatarViaDialog: vi.fn().mockResolvedValue(undefined),
    clearNewChannelAvatarPath: vi.fn(),

    editChannelOpen: false,
    setEditChannelOpen: vi.fn(),
    editingChannel: null,
    editChannelName: "",
    setEditChannelName: vi.fn(),
    editYoutubeHandle: "",
    setEditYoutubeHandle: vi.fn(),
    requestEditChannel: vi.fn(),
    saveEditedChannel: vi.fn().mockResolvedValue(undefined),
    isEditingChannel: false,

    confirmDeleteChannelOpen: false,
    channelToDelete: null,

    isLoadingChannels: false,
    isCreatingChannel: false,
    isDeletingChannel: false,
    isUpdatingChannelAvatar: false,
    updatingChannelAvatarId: null,

    setSelectedChannelId: vi.fn(),
    createChannel: vi.fn(),
    requestDeleteChannel: vi.fn(),
    updateChannelAvatarFromFile: vi.fn().mockResolvedValue(undefined),
    updateChannelAvatarFromYouTube: vi.fn().mockResolvedValue(undefined),
    removeChannelAvatar: vi.fn().mockResolvedValue(undefined),
    confirmDeleteChannel: vi.fn(),
    closeDeleteChannelModal: vi.fn(),
};

const mockMediaLibrary = {
    mediaItems: [],

    addMediaOpen: false,
    setAddMediaOpen: vi.fn(),
    closeAddMediaModal: vi.fn(),

    confirmDeleteMediaOpen: false,
    mediaToDelete: null,

    isLoadingMedia: false,
    isAddingMedia: false,
    isDeletingMedia: false,
    commentsInFlight: new Set<number>(),
    watchedActionInFlight: new Set<number>(),
    isUpdatingTitle: false,
    isCancellingYtDlp: false,

    ytDlpLogs: [],
    isYtDlpRunning: false,

    addMediaForm: {
        sourceMode: "local" as const,
        mediaUrl: "",
        title: "",
        mediaPath: "",
        mediaType: "video" as const,
        thumbPath: "",
        publishedAt: "",
        downloadComments: true,
        downloadLiveChat: true,
        cookiesBrowser: "",
        cookiesPath: "",
        isGeneratingThumb: false,

        ytDlpFormats: [],
        selectedYtDlpFormatId: "",
        isLoadingYtDlpFormats: false,
        selectedYtDlpMediaType: "video" as const,

        setSourceMode: vi.fn(),
        setMediaUrl: vi.fn(),
        setTitle: vi.fn(),
        setPublishedAt: vi.fn(),
        setDownloadComments: vi.fn(),
        setDownloadLiveChat: vi.fn(),
        setCookiesBrowser: vi.fn(),
        setCookiesPath: vi.fn(),
        pickCookiesFileViaDialog: vi.fn(),
        clearCookiesPath: vi.fn(),
        setSelectedYtDlpFormatId: vi.fn(),
        loadYtDlpFormats: vi.fn(),

        pickMediaViaDialog: vi.fn(),
        pickThumbViaDialog: vi.fn(),
        resetForm: vi.fn(),
    },

    mediaPlayer: {
        viewMode: "library" as const,
        activeMedia: null,
        activeIsAudio: false,
        activeSrc: "",
        activeThumbSrc: "",
        activeYoutubeUrl: "",
        canOpenInYoutube: false,
        activeIsWatched: false,
        openPlayer: vi.fn(),
        setActiveMedia: vi.fn(),
        closePlayer: vi.fn(),
        openInYoutube: vi.fn(),
    },

    applyMediaQuery: vi.fn().mockResolvedValue(undefined),
    loadMoreMedia: vi.fn().mockResolvedValue(undefined),
    reloadMedia: vi.fn().mockResolvedValue(undefined),
    mediaTotal: 0,
    channelMediaTotal: 0,
    hasMoreMedia: false,
    isLoadingMoreMedia: false,
    addMedia: vi.fn(),
    cancelYtDlpDownload: vi.fn(),

    markAsWatched: vi.fn(),
    markAsUnwatched: vi.fn(),
    refreshComments: vi.fn(),
    cancelRefreshComments: vi.fn(),
    editTitle: vi.fn(),
    openMediaFileLocation: vi.fn(),
    openMediaSourceInYoutube: vi.fn(),
    saveMediaProgress: vi.fn(),

    requestDeleteMedia: vi.fn(),
    confirmDeleteMedia: vi.fn(),
    closeDeleteMediaModal: vi.fn(),

    clearMediaAndPlayer: vi.fn(),
};

const mockDiagnosticsState = {
    diagnosticsOpen: false,
    setDiagnosticsOpen: vi.fn(),
    diagnosticsSummary: null,
    isLoadingDiagnostics: false,
    openDiagnostics: vi.fn(),
    closeDiagnostics: vi.fn(),
    reloadDiagnostics: vi.fn(),
};

const mockUiGuards = {
    disableLibraryPathChange: false,
    libraryPathChangeDisabledReason: "",
    disableChannelDeletion: false,
    channelDeletionDisabledReason: "",
    closeAddMediaModalSafely: vi.fn(),
};

const mockHomeActions = {
    chooseLibraryPath: vi.fn(),
    confirmDeleteChannel: vi.fn(),
};

const mockHomeMediaActions = {
    addMedia: vi.fn(),
    confirmDeleteMedia: vi.fn(),
    confirmDeleteChannel: vi.fn(),
    markAsWatched: vi.fn(),
    markAsUnwatched: vi.fn(),
    watchedActionInFlight: new Set<number>(),
    editMediaTitle: vi.fn(),
    saveMediaProgress: vi.fn(),
};

const mockPlayerActions = {
    openInYoutube: vi.fn(),
    openFileLocation: vi.fn(),
    refreshComments: vi.fn(),
    cancelRefreshComments: vi.fn(),
    isRefreshingComments: false,
    isUpdatingWatchedStatus: false,
    markActiveAsWatched: vi.fn(),
    markActiveAsUnwatched: vi.fn(),
    saveProgress: vi.fn(),
    closePlayer: vi.fn(),
};

const mockPlayerPanelState = {
    media: null,
    mediaSrc: "",
    thumbnailSrc: "",
    isAudio: false,
    canOpenInYoutube: false,
    isWatched: false,
};

const mockViewState = {
    shellSurface: "#111",
    shellBorder: "#222",
    pageBackground: "#000",
    showLoading: false,
    showEmpty: false,
    showSelectChannelPrompt: false,
    showLibrary: true,
    showPlayer: false,
};

const mockLibraryPanelState = {
    showSelectedChannelPanel: true,
    itemCountLabel: "0 itens",
    disableAddMedia: false,
};

describe("useHomeController", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        vi.mocked(useErrorModal).mockReturnValue(mockErrorState);
        vi.mocked(useAppSettings).mockReturnValue(mockSettingsState);
        vi.mocked(useChannels).mockReturnValue(mockChannelsState);
        vi.mocked(useMediaLibrary).mockReturnValue(mockMediaLibrary);
        vi.mocked(useDiagnostics).mockReturnValue(mockDiagnosticsState);
        vi.mocked(useHomeUiGuards).mockReturnValue(mockUiGuards);
        vi.mocked(useHomeActions).mockReturnValue(mockHomeActions);
        vi.mocked(useHomeMediaActions).mockReturnValue(mockHomeMediaActions);
        vi.mocked(useHomePlayerActions).mockReturnValue(mockPlayerActions);
        vi.mocked(useHomePlayerPanel).mockReturnValue(mockPlayerPanelState);
        vi.mocked(useHomeViewState).mockReturnValue(mockViewState);
        vi.mocked(useHomeLibraryPanel).mockReturnValue(mockLibraryPanelState);
        vi.mocked(useAppBootstrap).mockReturnValue({
            open: false,
            backedUpAtMs: null,
            isRestoring: false,
            restoreFromBackup: vi.fn().mockResolvedValue(undefined),
            dismiss: vi.fn(),
        });
    });

    it("wires bootstrap with error callback", () => {
        renderHook(() => useHomeController());

        expect(useAppBootstrap).toHaveBeenCalledWith({
            onError: mockErrorState.showError,
        });
    });

    it("passes library path and import mode to dependent hooks", () => {
        renderHook(() => useHomeController());

        expect(useChannels).toHaveBeenCalledWith({
            libraryPath: "/library",
            onError: mockErrorState.showError,
        });

        expect(useMediaLibrary).toHaveBeenCalledWith({
            selectedChannelId: 10,
            importMode: "copy",
            libraryPath: "/library",
            onError: mockErrorState.showError,
            onNotice: mockErrorState.showNotice,
        });

        expect(useDiagnostics).toHaveBeenCalledWith({
            libraryPath: "/library",
            importMode: "copy",
            onError: mockErrorState.showError,
        });
    });

    it("passes the correct props to useHomeLibraryPanel", () => {
        renderHook(() => useHomeController());

        expect(useHomeLibraryPanel).toHaveBeenCalledWith({
            selectedChannel: mockChannelsState.selectedChannel,
            channelMediaTotal: mockMediaLibrary.channelMediaTotal,
            viewMode: mockMediaLibrary.mediaPlayer.viewMode,
            isLoadingMedia: mockMediaLibrary.isLoadingMedia,
            isAddingMedia: mockMediaLibrary.isAddingMedia,
            isMigratingLibraryPath: mockSettingsState.isMigratingLibraryPath,
            libraryPath: mockSettingsState.settings.libraryPath,
        });
    });

    it("returns combined controller shape", () => {
        const { result } = renderHook(() => useHomeController());

        expect(result.current.channels).toBe(mockChannelsState);
        expect(result.current.media).toBe(mockMediaLibrary);
        expect(result.current.playerActions).toBe(mockPlayerActions);
        expect(result.current.playerPanelState).toBe(mockPlayerPanelState);
        expect(result.current.viewState).toBe(mockViewState);
        expect(result.current.libraryPanelState).toBe(mockLibraryPanelState);
        expect(result.current.libraryPath).toBe("/library");
        expect(result.current.databaseRecovery.open).toBe(false);
        expect(result.current.channels.selectedChannel?.name).toBe("Canal A");
        expect(result.current.settings.settings.importMode).toBe("copy");
    });

    it("delegates media actions from composed hooks", () => {
        const { result } = renderHook(() => useHomeController());

        expect(result.current.mediaActions).toBe(mockHomeMediaActions);
    });

    it("uses guarded close add media modal and custom choose library path action", () => {
        const { result } = renderHook(() => useHomeController());

        expect(result.current.uiGuards).toBe(mockUiGuards);
        expect(result.current.settings.chooseLibraryPath).toBe(mockHomeActions.chooseLibraryPath);
    });

    it("exposes error state from error modal hook", () => {
        const { result } = renderHook(() => useHomeController());

        expect(result.current.error).toBe(mockErrorState);
        expect(result.current.error.errorOpen).toBe(true);
        expect(result.current.error.errorMessage).toBe("boom");
    });
});