import { fireEvent, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { HomeModals } from "./home-modals";
import { renderWithMantine } from "../../test/test-utils";
import type { ChannelsController } from "../../hooks/channels/use-channels";
import type { HomeMediaActionsController } from "../../hooks/home/use-home-media-actions";
import type { HomeUiGuardsController } from "../../hooks/home/use-home-ui-guards";
import type { MediaLibraryController } from "../../hooks/media/use-media-library";
import type { MediaPlayerController } from "../../hooks/media/use-media-player";
import type { AppSettingsController } from "../../hooks/settings/use-app-settings";
import type { AddMediaFormController } from "../../hooks/use-add-media-form";
import type { DatabaseRecoveryController } from "../../hooks/use-app-bootstrap";
import type { DiagnosticsController } from "../../hooks/use-diagnostics";
import type { ErrorModalController } from "../../hooks/use-error-modal";

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
        cookiesBrowserProfile: "",
        cookiesPath: "",
        isGeneratingThumb: false,
        ytDlpFormats: [],
        selectedYtDlpFormatId: "",
        isLoadingYtDlpFormats: false,
        selectedYtDlpMediaType: "video",
        // Required since AddMediaFormController stopped being a hand-kept copy of what
        // useAddMediaForm returns. The copy omitted this field, so the controller type narrowed it
        // away and this factory never had to supply it.
        resolvedYoutubeVideoId: null,
        setSourceMode: vi.fn().mockResolvedValue(undefined),
        setMediaUrl: vi.fn(),
        setTitle: vi.fn(),
        setPublishedAt: vi.fn(),
        setDownloadComments: vi.fn(),
        setDownloadLiveChat: vi.fn(),
        setCookiesBrowser: vi.fn(),
        setCookiesBrowserProfile: vi.fn(),
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
        syncActiveMediaProgress: vi.fn(),
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
        commentsInFlight: new Set<number>(),
        watchedActionInFlight: new Set<number>(),
        isUpdatingTitle: false,
        isCancellingYtDlp: false,
        ytDlpLogs: [],
        isYtDlpRunning: false,
        ytDlpProgress: null,
        addMediaForm: createAddMediaForm(),
        mediaPlayer: createMediaPlayer(),
        applyMediaQuery: vi.fn().mockResolvedValue(undefined),
        loadMoreMedia: vi.fn().mockResolvedValue(undefined),
        reloadMedia: vi.fn().mockResolvedValue(undefined),
        mediaTotal: 0,
        channelMediaTotal: 0,
        hasMoreMedia: false,
        isLoadingMoreMedia: false,
        addMedia: vi.fn().mockResolvedValue(undefined),
        cancelYtDlpDownload: vi.fn().mockResolvedValue(undefined),
        markAsWatched: vi.fn().mockResolvedValue(undefined),
        markAsUnwatched: vi.fn().mockResolvedValue(undefined),
        refreshComments: vi.fn().mockResolvedValue(undefined),
        cancelRefreshComments: vi.fn().mockResolvedValue(undefined),
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
        watchedActionInFlight: new Set<number>(),
        editMediaTitle: vi.fn().mockResolvedValue(undefined),
        saveMediaProgress: vi.fn().mockResolvedValue(undefined),
    };
}

function createSettings(): AppSettingsController {
    return {
        settingsOpen: true,
        settings: { importMode: "copy", libraryPath: "/library", loadRemoteImages: true, checkUpdatesOnStartup: false, externalBackupDir: "" },
        isPreparingSettings: false,
        isMigratingLibraryPath: false,
        isSavingExternalBackupDir: false,
        openSettings: vi.fn(),
        closeSettings: vi.fn(),
        setImportMode: vi.fn(),
        setLoadRemoteImages: vi.fn(),
        setCheckUpdatesOnStartup: vi.fn(),
        chooseLibraryPath: vi.fn().mockResolvedValue(undefined),
        openCurrentLibraryPath: vi.fn().mockResolvedValue(undefined),
        chooseExternalBackupDir: vi.fn().mockResolvedValue(undefined),
        clearExternalBackupDir: vi.fn().mockResolvedValue(undefined),
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
        openLogDirectory: vi.fn().mockResolvedValue(undefined),
        isOpeningLogDirectory: false,
        revealLibraryPath: vi.fn().mockResolvedValue(undefined),
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
        onOpenDiagnosticsMedia: vi.fn(),
    };
}

describe("HomeModals", () => {
    // `HomeModals` code-splits the settings and diagnostics modals (see its `lazy` calls), so
    // rendering it starts a dynamic `import()` whose module (and the whole dependency tree behind
    // it, which for these two is most of the app's form and chart surface) is transformed inside
    // the one-second budget `findBy*` gives the assertion below.
    //
    // On a machine running this file alone that is comfortable. Under the full suite, with 144
    // files competing for the same cores, it is not. This test failed intermittently there while
    // passing every time in isolation, which is the shape that makes a flake expensive. It reddens
    // CI for a reason unrelated to the change being tested, and the natural response is to stop
    // trusting the run.
    //
    // Importing the two modules here resolves them before any assertion is timed, so the `lazy`
    // factory settles from the module registry on its first flush rather than racing a transform.
    // Deterministic rather than a larger timeout, which would only make the race less likely.
    beforeAll(async () => {
        await Promise.all([
            import("../modals/settings-modal"),
            import("../modals/diagnostics-modal"),
        ]);
    });

    it("renders mounted modal titles/messages", async () => {
        renderWithMantine(<HomeModals {...createProps()} />);

        // The static modals are there on the first commit.
        expect(screen.getByText("New channel")).toBeInTheDocument();
        expect(screen.getByText("Import media")).toBeInTheDocument();
        expect(screen.getByText("Something went wrong")).toBeInTheDocument();

        // Settings and Diagnostics are code-split, so they arrive a microtask later. `find*`
        // rather than `get*` is what waits for their chunk. Asserting they arrive at all is the
        // point. A split that never resolved would leave both modals permanently blank, and the
        // Suspense fallback is `null`, so nothing else in the tree would say so.
        expect(await screen.findByText("Settings")).toBeInTheDocument();
        expect((await screen.findAllByText("Diagnostics")).length).toBeGreaterThan(0);
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

    it("closes settings before opening diagnostics", async () => {
        const props = createProps();

        renderWithMantine(<HomeModals {...props} />);

        // The button lives inside the code-split settings modal, so wait for its chunk before
        // clicking rather than querying a tree that has not mounted yet.
        fireEvent.click(await screen.findByRole("button", { name: "Diagnostics" }));

        expect(props.settings.closeSettings).toHaveBeenCalledTimes(1);
        expect(props.diagnostics.openDiagnostics).toHaveBeenCalledTimes(1);
    });
});
