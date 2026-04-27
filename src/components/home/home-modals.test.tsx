import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HomeModals } from "./home-modals";
import { renderWithMantine } from "../../test/test-utils";
import type { HomeController } from "../../types/controllers";

function createController(): HomeController {
    return {
        channels: [],
        selectedChannelId: null,
        selectedChannel: null,
        mediaItems: [],

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
        saveEditedChannel: vi.fn().mockResolvedValue(undefined),
        isEditingChannel: false,

        addMediaOpen: true,
        setAddMediaOpen: vi.fn(),
        closeAddMediaModal: vi.fn().mockResolvedValue(undefined),

        confirmDeleteMediaOpen: true,
        mediaToDelete: null,

        confirmDeleteChannelOpen: true,
        channelToDelete: null,

        diagnosticsOpen: true,
        diagnosticsSummary: null,
        isLoadingDiagnostics: false,
        openDiagnostics: vi.fn().mockResolvedValue(undefined),
        closeDiagnostics: vi.fn(),
        reloadDiagnostics: vi.fn().mockResolvedValue(undefined),

        isLoadingChannels: false,
        isCreatingChannel: false,
        isDeletingChannel: false,
        isUpdatingChannelAvatar: false,
        updatingChannelAvatarId: null,
        isLoadingMedia: false,
        isAddingMedia: false,
        isDeletingMedia: false,
        isUpdatingWatched: false,
        isUpdatingTitle: false,
        isCancellingYtDlp: false,

        ytDlpLogs: [],
        isYtDlpRunning: false,

        errorOpen: true,
        errorMessage: "boom",

        addMediaForm: {
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
            isDragging: false,
            isThumbDragging: false,
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
            applyDroppedMediaPath: vi.fn().mockResolvedValue(undefined),
            applyDroppedThumbPath: vi.fn().mockResolvedValue(undefined),
            onDropMedia: vi.fn(),
            onDragOverMedia: vi.fn(),
            onDragLeaveMedia: vi.fn(),
            onDropThumb: vi.fn(),
            onDragOverThumb: vi.fn(),
            onDragLeaveThumb: vi.fn(),
            resetForm: vi.fn().mockResolvedValue(undefined),
        },

        mediaPlayer: {
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
        },

        playerActions: {
            openInYoutube: vi.fn().mockResolvedValue(undefined),
            openFileLocation: vi.fn().mockResolvedValue(undefined),
            refreshComments: vi.fn().mockResolvedValue(undefined),
            isRefreshingComments: false,
            markActiveAsWatched: vi.fn().mockResolvedValue(undefined),
            markActiveAsUnwatched: vi.fn().mockResolvedValue(undefined),
            closePlayer: vi.fn().mockResolvedValue(undefined),
        },

        playerPanelState: {
            media: null,
            mediaSrc: "",
            thumbnailSrc: "",
            isAudio: false,
            canOpenInYoutube: false,
            isWatched: false,
        },

        viewState: {
            shellSurface: "rgba(255,255,255,0.03)",
            shellBorder: "rgba(255,255,255,0.1)",
            pageBackground: "#070A12",
            showLoading: false,
            showEmpty: false,
            showLibrary: true,
            showPlayer: false,
        },

        libraryPanelState: {
            showSelectedChannelPanel: false,
            itemCountLabel: "0 item(s)",
            disableAddMedia: false,
        },

        settingsOpen: true,
        importMode: "copy",
        libraryPath: "/library",
        isPreparingSettings: false,
        isMigratingLibraryPath: false,
        openSettings: vi.fn(),
        closeSettings: vi.fn(),
        setImportMode: vi.fn(),
        chooseLibraryPath: vi.fn().mockResolvedValue(undefined),
        openCurrentLibraryPath: vi.fn().mockResolvedValue(undefined),
        disableLibraryPathChange: false,
        libraryPathChangeDisabledReason: "",

        setSelectedChannelId: vi.fn(),

        createChannel: vi.fn().mockResolvedValue(undefined),
        updateChannelAvatarFromFile: vi.fn().mockResolvedValue(undefined),
        updateChannelAvatarFromYouTube: vi.fn().mockResolvedValue(undefined),
        removeChannelAvatar: vi.fn().mockResolvedValue(undefined),

        addMedia: vi.fn().mockResolvedValue(undefined),
        cancelYtDlpDownload: vi.fn().mockResolvedValue(undefined),
        markAsWatched: vi.fn().mockResolvedValue(undefined),
        markAsUnwatched: vi.fn().mockResolvedValue(undefined),
        editMediaTitle: vi.fn().mockResolvedValue(undefined),
        openMediaFileLocation: vi.fn().mockResolvedValue(undefined),
        openMediaSourceInYoutube: vi.fn().mockResolvedValue(undefined),

        requestDeleteMedia: vi.fn(),
        confirmDeleteMedia: vi.fn().mockResolvedValue(undefined),
        closeDeleteMediaModal: vi.fn(),

        requestEditChannel: vi.fn(),
        requestDeleteChannel: vi.fn(),
        confirmDeleteChannel: vi.fn().mockResolvedValue(undefined),
        closeDeleteChannelModal: vi.fn(),

        closeErrorModal: vi.fn(),
    };
}

describe("HomeModals", () => {
    it("renders mounted modal titles/messages", () => {
        renderWithMantine(<HomeModals controller={createController()} />);

        expect(screen.getByText("New channel")).toBeInTheDocument();
        expect(screen.getByText("Import media")).toBeInTheDocument();
        expect(screen.getByText("Settings")).toBeInTheDocument();
        expect(screen.getAllByText("Diagnostics").length).toBeGreaterThan(0);
        expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    });

    it("closes settings before opening diagnostics", () => {
        const controller = createController();

        renderWithMantine(<HomeModals controller={controller} />);

        fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));

        expect(controller.closeSettings).toHaveBeenCalledTimes(1);
        expect(controller.openDiagnostics).toHaveBeenCalledTimes(1);
    });
});