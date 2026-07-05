import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHomeActions } from "./use-home-actions";

vi.mock("../use-cases/delete-selected-channel", () => ({
    executeDeleteSelectedChannel: vi.fn(),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

vi.mock("../utils/error-message", () => ({
    resolveErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

import { executeDeleteSelectedChannel } from "../use-cases/delete-selected-channel";

describe("useHomeActions", () => {
    function createErrorState(overrides?: Partial<any>): any {
        return {
            errorOpen: false,
            errorMessage: "",
            showError: vi.fn(),
            closeErrorModal: vi.fn(),
            ...overrides,
        };
    }

    function createSettingsState(overrides?: Partial<any>): any {
        return {
            settingsOpen: false,
            settings: {
                importMode: "copy" as const,
                libraryPath: "/library",
            },
            isPreparingSettings: false,
            isMigratingLibraryPath: false,
            openSettings: vi.fn(),
            closeSettings: vi.fn(),
            setImportMode: vi.fn(),
            chooseLibraryPath: vi.fn().mockResolvedValue(undefined),
            openCurrentLibraryPath: vi.fn(),
            ...overrides,
        };
    }

    function createChannelsState(overrides?: Partial<any>): any {
        return {
            channels: [],
            selectedChannelId: 10,
            selectedChannel: null,

            createChannelOpen: false,
            setCreateChannelOpen: vi.fn(),
            newChannelName: "",
            setNewChannelName: vi.fn(),
            newYoutubeHandle: "",
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

            confirmDeleteChannelOpen: true,
            channelToDelete: {
                id: 25,
                name: "Canal B",
                youtube_handle: "@canalb",
                avatar_path: null,
                created_at: "2026-03-31T10:00:00.000Z",
            },

            isLoadingChannels: false,
            isCreatingChannel: false,
            isDeletingChannel: false,
            isUpdatingChannelAvatar: false,
            updatingChannelAvatarId: null,

            setSelectedChannelId: vi.fn(),
            createChannel: vi.fn().mockResolvedValue(undefined),
            requestDeleteChannel: vi.fn(),
            confirmDeleteChannel: vi.fn().mockResolvedValue(undefined),
            closeDeleteChannelModal: vi.fn(),

            updateChannelAvatarFromFile: vi.fn().mockResolvedValue(undefined),
            updateChannelAvatarFromYouTube: vi.fn().mockResolvedValue(undefined),
            removeChannelAvatar: vi.fn().mockResolvedValue(undefined),

            ...overrides,
        };
    }

    function createMediaLibrary(overrides?: Partial<any>): any {
        return {
            mediaItems: [],

            addMediaOpen: true,
            setAddMediaOpen: vi.fn(),
            closeAddMediaModal: vi.fn(),

            confirmDeleteMediaOpen: false,
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
                isDragging: false,
                isThumbDragging: false,
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
                applyDroppedMediaPath: vi.fn(),
                applyDroppedThumbPath: vi.fn(),
                onDropMedia: vi.fn(),
                onDragOverMedia: vi.fn(),
                onDragLeaveMedia: vi.fn(),
                onDropThumb: vi.fn(),
                onDragOverThumb: vi.fn(),
                onDragLeaveThumb: vi.fn(),
                resetForm: vi.fn().mockResolvedValue(undefined),
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

            loadMedia: vi.fn(),
            addMedia: vi.fn(),
            cancelYtDlpDownload: vi.fn(),

            markAsWatched: vi.fn(),
            markAsUnwatched: vi.fn(),
            refreshComments: vi.fn(),
            editTitle: vi.fn(),
            openMediaFileLocation: vi.fn(),
            openMediaSourceInYoutube: vi.fn(),
            saveMediaProgress: vi.fn(),

            requestDeleteMedia: vi.fn(),
            confirmDeleteMedia: vi.fn(),
            closeDeleteMediaModal: vi.fn(),

            clearMediaAndPlayer: vi.fn(),

            ...overrides,
        };
    }

    function createUiGuards(overrides?: Partial<any>): any {
        return {
            isAddMediaModalLocked: false,
            disableLibraryPathChange: false,
            libraryPathChangeDisabledReason: "",
            disableChannelDeletion: false,
            channelDeletionDisabledReason: "",
            closeAddMediaModalSafely: vi.fn(),
            ...overrides,
        };
    }

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("delegates chooseLibraryPath when enabled", async () => {
        const settingsState = createSettingsState();

        const { result } = renderHook(() =>
            useHomeActions({
                errorState: createErrorState(),
                settingsState,
                channelsState: createChannelsState(),
                mediaLibrary: createMediaLibrary(),
                uiGuards: createUiGuards(),
            })
        );

        await act(async () => {
            await result.current.chooseLibraryPath();
        });

        expect(settingsState.chooseLibraryPath).toHaveBeenCalledTimes(1);
    });

    it("shows guard reason instead of changing library path when disabled", async () => {
        const errorState = createErrorState();

        const { result } = renderHook(() =>
            useHomeActions({
                errorState,
                settingsState: createSettingsState(),
                channelsState: createChannelsState(),
                mediaLibrary: createMediaLibrary(),
                uiGuards: createUiGuards({
                    disableLibraryPathChange: true,
                    libraryPathChangeDisabledReason: "Blocked right now",
                }),
            })
        );

        await act(async () => {
            await result.current.chooseLibraryPath();
        });

        expect(errorState.showError).toHaveBeenCalledWith("Blocked right now");
    });

    it("delegates confirmDeleteChannel through use case", async () => {
        vi.mocked(executeDeleteSelectedChannel).mockResolvedValue(undefined);

        const channelsState = createChannelsState();
        const mediaLibrary = createMediaLibrary();

        const { result } = renderHook(() =>
            useHomeActions({
                errorState: createErrorState(),
                settingsState: createSettingsState(),
                channelsState,
                mediaLibrary,
                uiGuards: createUiGuards(),
            })
        );

        await act(async () => {
            await result.current.confirmDeleteChannel();
        });

        expect(executeDeleteSelectedChannel).toHaveBeenCalledTimes(1);
        expect(executeDeleteSelectedChannel).toHaveBeenCalledWith(
            expect.objectContaining({
                selectedChannelId: 10,
                channelToDeleteId: 25,
                confirmDeleteChannel: channelsState.confirmDeleteChannel,
            })
        );
    });

    it("blocks channel deletion while a media operation is running", async () => {
        vi.mocked(executeDeleteSelectedChannel).mockResolvedValue(undefined);

        const errorState = createErrorState();

        const { result } = renderHook(() =>
            useHomeActions({
                errorState,
                settingsState: createSettingsState(),
                channelsState: createChannelsState(),
                mediaLibrary: createMediaLibrary(),
                uiGuards: createUiGuards({
                    disableChannelDeletion: true,
                    channelDeletionDisabledReason:
                        "Wait for the media import or download to finish before deleting a channel.",
                }),
            })
        );

        await act(async () => {
            await result.current.confirmDeleteChannel();
        });

        expect(executeDeleteSelectedChannel).not.toHaveBeenCalled();
        expect(errorState.showError).toHaveBeenCalledWith(
            "Wait for the media import or download to finish before deleting a channel."
        );
    });
});