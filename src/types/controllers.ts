import type React from "react";
import type { DiagnosticsSummary } from "./diagnostics";
import type {
    Channel,
    ChannelAvatarMode,
    MediaRow,
    MediaSourceMode,
    MediaType,
    ViewMode,
    YtDlpFormat,
} from "./media";
import type { AppSettings, ImportMode } from "./settings";

export type AddMediaFormController = {
    sourceMode: MediaSourceMode;
    mediaUrl: string;
    title: string;
    mediaPath: string;
    mediaType: MediaType;
    thumbPath: string;
    publishedAt: string;
    downloadComments: boolean;
    downloadLiveChat: boolean;
    cookiesBrowser: string;
    cookiesPath: string;
    isDragging: boolean;
    isThumbDragging: boolean;
    isGeneratingThumb: boolean;
    ytDlpFormats: YtDlpFormat[];
    selectedYtDlpFormatId: string;
    isLoadingYtDlpFormats: boolean;
    selectedYtDlpMediaType: MediaType;
    setSourceMode: (value: MediaSourceMode) => Promise<void>;
    setMediaUrl: (value: string) => void;
    setTitle: (value: string) => void;
    setPublishedAt: (value: string) => void;
    setDownloadComments: (value: boolean) => void;
    setDownloadLiveChat: (value: boolean) => void;
    setCookiesBrowser: (value: string) => void;
    setCookiesPath: (value: string) => void;
    pickCookiesFileViaDialog: () => Promise<void>;
    clearCookiesPath: () => void;
    setSelectedYtDlpFormatId: (value: string) => void;
    loadYtDlpFormats: () => Promise<void>;
    pickMediaViaDialog: () => Promise<void>;
    pickThumbViaDialog: () => Promise<void>;
    applyDroppedMediaPath: (path: string) => Promise<void>;
    applyDroppedThumbPath: (path: string) => Promise<void>;
    onDropMedia: (event: React.DragEvent<HTMLDivElement>) => void | Promise<void>;
    onDragOverMedia: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragLeaveMedia: (event: React.DragEvent<HTMLDivElement>) => void;
    onDropThumb: (event: React.DragEvent<HTMLDivElement>) => void | Promise<void>;
    onDragOverThumb: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragLeaveThumb: (event: React.DragEvent<HTMLDivElement>) => void;
    resetForm: () => Promise<void>;
};

export type MediaPlayerController = {
    viewMode: ViewMode;
    activeMedia: MediaRow | null;
    activeIsAudio: boolean;
    activeSrc: string;
    activeThumbSrc: string;
    activeYoutubeUrl: string;
    canOpenInYoutube: boolean;
    activeIsWatched: boolean;
    openPlayer: (media: MediaRow) => void;
    setActiveMedia: (media: MediaRow | null) => void;
    closePlayer: () => void;
    openInYoutube: () => Promise<void>;
};

export type MediaLibraryController = {
    mediaItems: MediaRow[];
    addMediaOpen: boolean;
    setAddMediaOpen: React.Dispatch<React.SetStateAction<boolean>>;
    closeAddMediaModal: () => Promise<void>;
    confirmDeleteMediaOpen: boolean;
    mediaToDelete: MediaRow | null;
    isLoadingMedia: boolean;
    isAddingMedia: boolean;
    isDeletingMedia: boolean;
    isUpdatingWatched: boolean;
    isRefreshingComments: boolean;
    isUpdatingTitle: boolean;
    isCancellingYtDlp: boolean;
    ytDlpLogs: string[];
    isYtDlpRunning: boolean;
    addMediaForm: AddMediaFormController;
    mediaPlayer: MediaPlayerController;
    loadMedia: (channelId?: number | null) => Promise<void>;
    addMedia: () => Promise<void>;
    cancelYtDlpDownload: () => Promise<void>;
    markAsWatched: (mediaId: number) => Promise<void>;
    markAsUnwatched: (mediaId: number) => Promise<void>;
    refreshComments: (media: MediaRow) => Promise<void>;
    editTitle: (media: MediaRow, title: string) => Promise<void>;
    openMediaFileLocation: (media: MediaRow) => Promise<void>;
    openMediaSourceInYoutube: (media: MediaRow) => Promise<void>;
    saveMediaProgress: (mediaId: number, progressSeconds: number) => Promise<void>;
    requestDeleteMedia: (media: MediaRow) => void;
    confirmDeleteMedia: () => Promise<void>;
    closeDeleteMediaModal: () => void;
    clearMediaAndPlayer: () => void;
};

export type ChannelsController = {
    channels: Channel[];
    selectedChannelId: number | null;
    selectedChannel: Channel | null;
    createChannelOpen: boolean;
    setCreateChannelOpen: (value: boolean) => void;
    newChannelName: string;
    setNewChannelName: (value: string) => void;
    newYoutubeHandle: string;
    setNewYoutubeHandle: (value: string) => void;
    newChannelAvatarMode: ChannelAvatarMode;
    setNewChannelAvatarMode: (value: ChannelAvatarMode) => void;
    newChannelAvatarPath: string;
    setNewChannelAvatarPath: (value: string) => void;
    pickChannelAvatarViaDialog: () => Promise<void>;
    clearNewChannelAvatarPath: () => void;
    editChannelOpen: boolean;
    setEditChannelOpen: (value: boolean) => void;
    editingChannel: Channel | null;
    editChannelName: string;
    setEditChannelName: (value: string) => void;
    editYoutubeHandle: string;
    setEditYoutubeHandle: (value: string) => void;
    requestEditChannel: (channel: Channel) => void;
    saveEditedChannel: () => Promise<void>;
    isEditingChannel: boolean;
    confirmDeleteChannelOpen: boolean;
    channelToDelete: Channel | null;
    isLoadingChannels: boolean;
    isCreatingChannel: boolean;
    isDeletingChannel: boolean;
    isUpdatingChannelAvatar: boolean;
    updatingChannelAvatarId: number | null;
    setSelectedChannelId: (value: number | null) => void;
    createChannel: () => Promise<void>;
    requestDeleteChannel: (channel: Channel) => void;
    updateChannelAvatarFromFile: (channel: Channel) => Promise<void>;
    updateChannelAvatarFromYouTube: (channel: Channel) => Promise<void>;
    removeChannelAvatar: (channel: Channel) => Promise<void>;
    confirmDeleteChannel: () => Promise<void>;
    closeDeleteChannelModal: () => void;
};

export type AppSettingsController = {
    settingsOpen: boolean;
    settings: AppSettings;
    isPreparingSettings: boolean;
    isMigratingLibraryPath: boolean;
    openSettings: () => void;
    closeSettings: () => void;
    setImportMode: (mode: ImportMode) => void;
    chooseLibraryPath: () => Promise<void>;
    openCurrentLibraryPath: () => Promise<void>;
};

export type DiagnosticsController = {
    diagnosticsOpen: boolean;
    setDiagnosticsOpen: (value: boolean) => void;
    diagnosticsSummary: DiagnosticsSummary | null;
    isLoadingDiagnostics: boolean;
    openDiagnostics: () => Promise<void>;
    closeDiagnostics: () => void;
    reloadDiagnostics: () => Promise<void>;
};

export type ErrorModalController = {
    errorOpen: boolean;
    errorMessage: string;
    showError: (message: string) => void;
    closeErrorModal: () => void;
};

export type HomeUiGuardsController = {
    isAddMediaModalLocked: boolean;
    disableLibraryPathChange: boolean;
    libraryPathChangeDisabledReason: string;
    closeAddMediaModalSafely: () => Promise<void>;
};

export type HomeMediaActionsController = {
    addMedia: () => Promise<void>;
    confirmDeleteMedia: () => Promise<void>;
    confirmDeleteChannel: () => Promise<void>;
    markAsWatched: (mediaId: number) => Promise<void>;
    markAsUnwatched: (mediaId: number) => Promise<void>;
    editMediaTitle: (media: MediaRow, title: string) => Promise<void>;
    saveMediaProgress: (mediaId: number, progressSeconds: number) => Promise<void>;
};

export type HomePlayerActionsController = {
    openInYoutube: () => Promise<void>;
    markActiveAsWatched: () => Promise<void>;
    markActiveAsUnwatched: () => Promise<void>;
    closePlayer: (progressSeconds?: number) => Promise<void>;
    openFileLocation: () => Promise<void>;
    refreshComments: () => Promise<void>;
    isRefreshingComments: boolean;
};

export type HomePlayerPanelState = {
    media: MediaRow | null;
    mediaSrc: string;
    thumbnailSrc: string;
    isAudio: boolean;
    canOpenInYoutube: boolean;
    isWatched: boolean;
};

export type HomeViewState = {
    shellSurface: string;
    shellBorder: string;
    pageBackground: string;
    showLoading: boolean;
    showEmpty: boolean;
    showLibrary: boolean;
    showPlayer: boolean;
};

export type HomeLibraryPanelState = {
    showSelectedChannelPanel: boolean;
    itemCountLabel: string;
    disableAddMedia: boolean;
};

export type HomeController = {
    channels: Channel[];
    selectedChannelId: number | null;
    selectedChannel: Channel | null;
    mediaItems: MediaRow[];

    createChannelOpen: boolean;
    setCreateChannelOpen: (value: boolean) => void;
    newChannelName: string;
    setNewChannelName: (value: string) => void;
    newYoutubeHandle: string;
    setNewYoutubeHandle: (value: string) => void;
    newChannelAvatarMode: ChannelAvatarMode;
    setNewChannelAvatarMode: (value: ChannelAvatarMode) => void;
    newChannelAvatarPath: string;
    setNewChannelAvatarPath: (value: string) => void;
    pickChannelAvatarViaDialog: () => Promise<void>;
    clearNewChannelAvatarPath: () => void;

    editChannelOpen: boolean;
    setEditChannelOpen: (value: boolean) => void;
    editingChannel: Channel | null;
    editChannelName: string;
    setEditChannelName: (value: string) => void;
    editYoutubeHandle: string;
    setEditYoutubeHandle: (value: string) => void;
    saveEditedChannel: () => Promise<void>;

    addMediaOpen: boolean;
    setAddMediaOpen: (value: boolean) => void;
    closeAddMediaModal: () => Promise<void>;

    confirmDeleteMediaOpen: boolean;
    mediaToDelete: MediaRow | null;

    confirmDeleteChannelOpen: boolean;
    channelToDelete: Channel | null;

    diagnosticsOpen: boolean;
    diagnosticsSummary: DiagnosticsSummary | null;
    isLoadingDiagnostics: boolean;
    openDiagnostics: () => Promise<void>;
    closeDiagnostics: () => void;
    reloadDiagnostics: () => Promise<void>;

    isLoadingChannels: boolean;
    isCreatingChannel: boolean;
    isDeletingChannel: boolean;
    isUpdatingChannelAvatar: boolean;
    updatingChannelAvatarId: number | null;
    isEditingChannel: boolean;
    isLoadingMedia: boolean;
    isAddingMedia: boolean;
    isDeletingMedia: boolean;
    isUpdatingWatched: boolean;
    isUpdatingTitle: boolean;
    isCancellingYtDlp: boolean;

    ytDlpLogs: string[];
    isYtDlpRunning: boolean;

    errorOpen: boolean;
    errorMessage: string;

    addMediaForm: AddMediaFormController;
    mediaPlayer: MediaPlayerController;
    playerActions: HomePlayerActionsController;
    playerPanelState: HomePlayerPanelState;
    viewState: HomeViewState;
    libraryPanelState: HomeLibraryPanelState;

    settingsOpen: boolean;
    importMode: ImportMode;
    libraryPath: string;
    isPreparingSettings: boolean;
    isMigratingLibraryPath: boolean;
    openSettings: () => void;
    closeSettings: () => void;
    setImportMode: (mode: ImportMode) => void;
    chooseLibraryPath: () => Promise<void>;
    openCurrentLibraryPath: () => Promise<void>;
    disableLibraryPathChange: boolean;
    libraryPathChangeDisabledReason: string;

    setSelectedChannelId: (value: number | null) => void;

    createChannel: () => Promise<void>;
    addMedia: () => Promise<void>;
    cancelYtDlpDownload: () => Promise<void>;
    markAsWatched: (mediaId: number) => Promise<void>;
    markAsUnwatched: (mediaId: number) => Promise<void>;
    editMediaTitle: (media: MediaRow, title: string) => Promise<void>;
    openMediaFileLocation: (media: MediaRow) => Promise<void>;
    openMediaSourceInYoutube: (media: MediaRow) => Promise<void>;

    requestDeleteMedia: (media: MediaRow) => void;
    confirmDeleteMedia: () => Promise<void>;
    closeDeleteMediaModal: () => void;

    requestEditChannel: (channel: Channel) => void;
    requestDeleteChannel: (channel: Channel) => void;
    updateChannelAvatarFromFile: (channel: Channel) => Promise<void>;
    updateChannelAvatarFromYouTube: (channel: Channel) => Promise<void>;
    removeChannelAvatar: (channel: Channel) => Promise<void>;
    confirmDeleteChannel: () => Promise<void>;
    closeDeleteChannelModal: () => void;

    closeErrorModal: () => void;
};