import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HomeModals } from "./home-modals";
import { renderWithMantine } from "../../test/test-utils";
import type {
    AddMediaFormController,
    AppSettingsController,
    ChannelsController,
    DatabaseRecoveryController,
    DiagnosticsController,
    ErrorModalController,
    HomeMediaActionsController,
    HomeUiGuardsController,
    MediaLibraryController,
    MediaPlayerController,
} from "../../types/controllers";

function createAddMediaForm(): AddMediaFormController {
    return {
        sourceMode: "local",
        mediaUrl: "",
        title: "",
        mediaPath: "",
        mediaType: "video",
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
        selectedYtDlpMediaType: "video",
        setSourceMode: vi.fn().mockResolvedValue(undefined),
        setMediaUrl: vi.fn(),
        setTitle: vi.fn(),
        setPublishedAt: vi.fn(),
        setDownloadComments: vi.fn(),
        setDownloadLiveChat: vi.fn(),
        setCookiesBrowser: vi.fn(),
        setCookiesPath: vi.fn(),
        pickCookiesFileViaDialog: vi.fn().mockResolvedValue(undefined),
        clearCookiesPath: vi.fn(),
        setSelectedYtDlpFormatId: vi.fn(),
        loadYtDlpFormats: vi.fn().mockResolvedValue(undefined),
        pickMediaViaDialog: vi.fn().mockResolvedValue(undefined),
        pickThumbViaDialog: vi.fn().mockResolvedValue(undefined),
        resetForm: vi.fn().mockResolvedValue(undefined),
    };
}

function createMediaPlayer(): MediaPlayerController {
    return {
        viewMode: "library",
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
        openInYoutube: vi.fn().mockResolvedValue(undefined),
    };
}

function createChannels(): ChannelsController {
    return {
        channels: [],
        selectedChannelId: null,
        selectedChannel: null,
        createChannelOpen: true,
        setCreateChannelOpen: vi.fn(),
        newChannelName: "Canal A",
        setNewChannelName: vi.fn(),
        newYoutubeHandle: "@canala",
        setNewYoutubeHandle: vi.fn(),
        newChannelAvatarMode: "none",
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
        confirmDeleteChannelOpen: true,
        channelToDelete: null,
        isLoadingChannels: false,
        isCreatingChannel: false,
        isDeletingChannel: false,
        isUpdatingChannelAvatar: false,
        updatingChannelAvatarId: null,
        setSelectedChannelId: vi.fn(),
        createChannel: vi.fn().mockResolvedValue(undefined),
        requestDeleteChannel: vi.fn(),
        updateChannelAvatarFromFile: vi.fn().mockResolvedValue(undefined),
        updateChannelAvatarFromYouTube: vi.fn().mockResolvedValue(undefined),
        removeChannelAvatar: vi.fn().mockResolvedValue(undefined),
        confirmDeleteChannel: vi.fn().mockResolvedValue(undefined),
        closeDeleteChannelModal: vi.fn(),
    };
}

function createMedia(): MediaLibraryController {
    return {
        mediaItems: [],
        addMediaOpen: true,
        setAddMediaOpen: vi.fn(),
        closeAddMediaModal: vi.fn().mockResolvedValue(undefined),
        confirmDeleteMediaOpen: true,
        mediaToDelete: null,
        isLoadingMedia: false,
        isAddingMedia: false,
        isDeletingMedia: false,
        isUpdatingWatched: false,
        isRefreshingComments: false,
        isUpdatingTitle: false,
        isCancellingYtDlp: false,
        ytDlpLogs: [],
        isYtDlpRunning: false,
        addMediaForm: createAddMediaForm(),
        mediaPlayer: createMediaPlayer(),
        loadMedia: vi.fn().mockResolvedValue(undefined),
        addMedia: vi.fn().mockResolvedValue(undefined),
        cancelYtDlpDownload: vi.fn().mockResolvedValue(undefined),
        markAsWatched: vi.fn().mockResolvedValue(undefined),
        markAsUnwatched: vi.fn().mockResolvedValue(undefined),
        refreshComments: vi.fn().mockResolvedValue(undefined),
        editTitle: vi.fn().mockResolvedValue(undefined),
        openMediaFileLocation: vi.fn().mockResolvedValue(undefined),
        openMediaSourceInYoutube: vi.fn().mockResolvedValue(undefined),
        saveMediaProgress: vi.fn().mockResolvedValue(undefined),
        requestDeleteMedia: vi.fn(),
        confirmDeleteMedia: vi.fn().mockResolvedValue(undefined),
        closeDeleteMediaModal: vi.fn(),
        clearMediaAndPlayer: vi.fn(),
    };
}

function createMediaActions(): HomeMediaActionsController {
    return {
        addMedia: vi.fn().mockResolvedValue(undefined),
        confirmDeleteMedia: vi.fn().mockResolvedValue(undefined),
        confirmDeleteChannel: vi.fn().mockResolvedValue(undefined),
        markAsWatched: vi.fn().mockResolvedValue(undefined),
        markAsUnwatched: vi.fn().mockResolvedValue(undefined),
        editMediaTitle: vi.fn().mockResolvedValue(undefined),
        saveMediaProgress: vi.fn().mockResolvedValue(undefined),
    };
}

function createSettings(): AppSettingsController {
    return {
        settingsOpen: true,
        settings: { importMode: "copy", libraryPath: "/library" },
        isPreparingSettings: false,
        isMigratingLibraryPath: false,
        openSettings: vi.fn(),
        closeSettings: vi.fn(),
        setImportMode: vi.fn(),
        chooseLibraryPath: vi.fn().mockResolvedValue(undefined),
        openCurrentLibraryPath: vi.fn().mockResolvedValue(undefined),
    };
}

function createDiagnostics(): DiagnosticsController {
    return {
        diagnosticsOpen: true,
        setDiagnosticsOpen: vi.fn(),
        diagnosticsSummary: null,
        isLoadingDiagnostics: false,
        openDiagnostics: vi.fn().mockResolvedValue(undefined),
        closeDiagnostics: vi.fn(),
        reloadDiagnostics: vi.fn().mockResolvedValue(undefined),
    };
}

function createError(): ErrorModalController {
    return {
        errorOpen: true,
        errorMessage: "boom",
        errorVariant: "error",
        showError: vi.fn(),
        showNotice: vi.fn(),
        closeErrorModal: vi.fn(),
    };
}

function createUiGuards(): HomeUiGuardsController {
    return {
        disableLibraryPathChange: false,
        libraryPathChangeDisabledReason: "",
        disableChannelDeletion: false,
        channelDeletionDisabledReason: "",
        closeAddMediaModalSafely: vi.fn().mockResolvedValue(undefined),
    };
}

function createDatabaseRecovery(): DatabaseRecoveryController {
    return {
        open: false,
        backedUpAtMs: null,
        isRestoring: false,
        restoreFromBackup: vi.fn().mockResolvedValue(undefined),
        dismiss: vi.fn(),
    };
}

function createProps() {
    return {
        channels: createChannels(),
        media: createMedia(),
        mediaActions: createMediaActions(),
        settings: createSettings(),
        diagnostics: createDiagnostics(),
        error: createError(),
        databaseRecovery: createDatabaseRecovery(),
        uiGuards: createUiGuards(),
    };
}

describe("HomeModals", () => {
    it("renders mounted modal titles/messages", () => {
        renderWithMantine(<HomeModals {...createProps()} />);

        expect(screen.getByText("New channel")).toBeInTheDocument();
        expect(screen.getByText("Import media")).toBeInTheDocument();
        expect(screen.getByText("Settings")).toBeInTheDocument();
        expect(screen.getAllByText("Diagnostics").length).toBeGreaterThan(0);
        expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    });

    it("warns that deleting media permanently removes the file from disk", () => {
        renderWithMantine(<HomeModals {...createProps()} />);

        expect(
            screen.getByText(
                "This permanently deletes the media file and its thumbnail from disk. This cannot be undone."
            )
        ).toBeInTheDocument();
    });

    it("warns that deleting a channel permanently removes its files from disk", () => {
        renderWithMantine(<HomeModals {...createProps()} />);

        expect(
            screen.getByText(
                "This permanently deletes all of this channel's saved videos, audio, thumbnails and live chat replays from disk, and removes its comments. This cannot be undone."
            )
        ).toBeInTheDocument();
    });

    it("closes settings before opening diagnostics", () => {
        const props = createProps();

        renderWithMantine(<HomeModals {...props} />);

        fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));

        expect(props.settings.closeSettings).toHaveBeenCalledTimes(1);
        expect(props.diagnostics.openDiagnostics).toHaveBeenCalledTimes(1);
    });
});
