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
import { logError } from "../utils/app-logger";

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
            commentsInFlight: new Set<number>(),
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

    it("shows the default reason when library path change is disabled without a specific reason", async () => {
        const errorState = createErrorState();

        const { result } = renderHook(() =>
            useHomeActions({
                errorState,
                settingsState: createSettingsState(),
                channelsState: createChannelsState(),
                mediaLibrary: createMediaLibrary(),
                uiGuards: createUiGuards({
                    disableLibraryPathChange: true,
                    libraryPathChangeDisabledReason: "",
                }),
            })
        );

        await act(async () => {
            await result.current.chooseLibraryPath();
        });

        expect(errorState.showError).toHaveBeenCalledWith(
            "You cannot change the library folder right now."
        );
    });

    it("logs and shows a message when choosing the library path fails", async () => {
        const error = new Error("choose failed");
        const settingsState = createSettingsState({
            chooseLibraryPath: vi.fn().mockRejectedValue(error),
        });
        const errorState = createErrorState();

        const { result } = renderHook(() =>
            useHomeActions({
                errorState,
                settingsState,
                channelsState: createChannelsState(),
                mediaLibrary: createMediaLibrary(),
                uiGuards: createUiGuards(),
            })
        );

        await act(async () => {
            await result.current.chooseLibraryPath();
        });

        expect(logError).toHaveBeenCalledWith(
            "home-actions",
            "Failed to choose library path.",
            error
        );
        expect(errorState.showError).toHaveBeenCalledWith(
            "Failed to choose library folder."
        );
    });

    it("recomputes chooseLibraryPath when guard state changes", async () => {
        const settingsState1 = createSettingsState();

        const { result, rerender } = renderHook(
            (props: Parameters<typeof useHomeActions>[0]) => useHomeActions(props),
            {
                initialProps: {
                    errorState: createErrorState(),
                    settingsState: settingsState1,
                    channelsState: createChannelsState(),
                    mediaLibrary: createMediaLibrary(),
                    uiGuards: createUiGuards(),
                },
            }
        );

        await act(async () => {
            await result.current.chooseLibraryPath();
        });

        expect(settingsState1.chooseLibraryPath).toHaveBeenCalledTimes(1);

        const errorState2 = createErrorState();
        const uiGuards2 = createUiGuards({
            disableLibraryPathChange: true,
            libraryPathChangeDisabledReason: "Blocked now",
        });

        rerender({
            errorState: errorState2,
            settingsState: createSettingsState(),
            channelsState: createChannelsState(),
            mediaLibrary: createMediaLibrary(),
            uiGuards: uiGuards2,
        });

        await act(async () => {
            await result.current.chooseLibraryPath();
        });

        expect(settingsState1.chooseLibraryPath).toHaveBeenCalledTimes(1);
        expect(errorState2.showError).toHaveBeenCalledWith("Blocked now");
    });

    it("resets the add-media UI before deleting a channel when the form is open", async () => {
        vi.mocked(executeDeleteSelectedChannel).mockImplementationOnce(
            async (options: { closeSelectedChannelUiBeforeDelete: () => Promise<void> }) => {
                await options.closeSelectedChannelUiBeforeDelete();
            }
        );

        const channelsState = createChannelsState();
        const mediaLibrary = createMediaLibrary({ addMediaOpen: true });

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

        expect(channelsState.setSelectedChannelId).toHaveBeenCalledWith(null);
        expect(mediaLibrary.clearMediaAndPlayer).toHaveBeenCalledTimes(1);
        expect(mediaLibrary.addMediaForm.resetForm).toHaveBeenCalledTimes(1);
        expect(mediaLibrary.setAddMediaOpen).toHaveBeenCalledWith(false);
    });

    it("skips resetting the add-media form before deleting a channel when it is not open", async () => {
        vi.mocked(executeDeleteSelectedChannel).mockImplementationOnce(
            async (options: { closeSelectedChannelUiBeforeDelete: () => Promise<void> }) => {
                await options.closeSelectedChannelUiBeforeDelete();
            }
        );

        const channelsState = createChannelsState();
        const mediaLibrary = createMediaLibrary({ addMediaOpen: false });

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

        expect(channelsState.setSelectedChannelId).toHaveBeenCalledWith(null);
        expect(mediaLibrary.clearMediaAndPlayer).toHaveBeenCalledTimes(1);
        expect(mediaLibrary.addMediaForm.resetForm).not.toHaveBeenCalled();
        expect(mediaLibrary.setAddMediaOpen).not.toHaveBeenCalled();
    });

    it("captures fresh channel and media state after a rerender before deleting", async () => {
        vi.mocked(executeDeleteSelectedChannel).mockImplementation(
            async (options: { closeSelectedChannelUiBeforeDelete: () => Promise<void> }) => {
                await options.closeSelectedChannelUiBeforeDelete();
            }
        );

        const channelsState1 = createChannelsState();
        const mediaLibrary1 = createMediaLibrary({ addMediaOpen: false });

        const { result, rerender } = renderHook(
            (props: Parameters<typeof useHomeActions>[0]) => useHomeActions(props),
            {
                initialProps: {
                    errorState: createErrorState(),
                    settingsState: createSettingsState(),
                    channelsState: channelsState1,
                    mediaLibrary: mediaLibrary1,
                    uiGuards: createUiGuards(),
                },
            }
        );

        const channelsState2 = createChannelsState();
        const mediaLibrary2 = createMediaLibrary({ addMediaOpen: false });

        rerender({
            errorState: createErrorState(),
            settingsState: createSettingsState(),
            channelsState: channelsState2,
            mediaLibrary: mediaLibrary2,
            uiGuards: createUiGuards(),
        });

        await act(async () => {
            await result.current.confirmDeleteChannel();
        });

        expect(channelsState2.setSelectedChannelId).toHaveBeenCalledWith(null);
        expect(channelsState1.setSelectedChannelId).not.toHaveBeenCalled();
        expect(mediaLibrary2.clearMediaAndPlayer).toHaveBeenCalledTimes(1);
        expect(mediaLibrary1.clearMediaAndPlayer).not.toHaveBeenCalled();
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

    it("shows the default reason when channel deletion is disabled without a specific reason", async () => {
        const errorState = createErrorState();

        const { result } = renderHook(() =>
            useHomeActions({
                errorState,
                settingsState: createSettingsState(),
                channelsState: createChannelsState(),
                mediaLibrary: createMediaLibrary(),
                uiGuards: createUiGuards({
                    disableChannelDeletion: true,
                    channelDeletionDisabledReason: "",
                }),
            })
        );

        await act(async () => {
            await result.current.confirmDeleteChannel();
        });

        expect(errorState.showError).toHaveBeenCalledWith(
            "You cannot delete a channel right now."
        );
    });

    it("logs and shows a message when confirming channel deletion fails", async () => {
        const error = new Error("delete failed");
        vi.mocked(executeDeleteSelectedChannel).mockRejectedValueOnce(error);

        const errorState = createErrorState();
        const channelsState = createChannelsState();

        const { result } = renderHook(() =>
            useHomeActions({
                errorState,
                settingsState: createSettingsState(),
                channelsState,
                mediaLibrary: createMediaLibrary(),
                uiGuards: createUiGuards(),
            })
        );

        await act(async () => {
            await result.current.confirmDeleteChannel();
        });

        expect(logError).toHaveBeenCalledWith(
            "home-actions",
            "Failed to confirm channel deletion.",
            error,
            {
                selectedChannelId: 10,
                channelToDeleteId: 25,
            }
        );
        expect(errorState.showError).toHaveBeenCalledWith("Failed to delete channel.");
    });

    it("logs a null channelToDeleteId when there is no channel pending deletion", async () => {
        const error = new Error("delete failed");
        vi.mocked(executeDeleteSelectedChannel).mockRejectedValueOnce(error);

        const errorState = createErrorState();
        const channelsState = createChannelsState({ channelToDelete: null });

        const { result } = renderHook(() =>
            useHomeActions({
                errorState,
                settingsState: createSettingsState(),
                channelsState,
                mediaLibrary: createMediaLibrary(),
                uiGuards: createUiGuards(),
            })
        );

        await act(async () => {
            await result.current.confirmDeleteChannel();
        });

        expect(logError).toHaveBeenCalledWith(
            "home-actions",
            "Failed to confirm channel deletion.",
            error,
            {
                selectedChannelId: 10,
                channelToDeleteId: null,
            }
        );
    });

    it("recomputes confirmDeleteChannel when guard state changes", async () => {
        vi.mocked(executeDeleteSelectedChannel).mockResolvedValue(undefined);

        const uiGuards1 = createUiGuards({ disableChannelDeletion: false });

        const { result, rerender } = renderHook(
            (props: Parameters<typeof useHomeActions>[0]) => useHomeActions(props),
            {
                initialProps: {
                    errorState: createErrorState(),
                    settingsState: createSettingsState(),
                    channelsState: createChannelsState(),
                    mediaLibrary: createMediaLibrary(),
                    uiGuards: uiGuards1,
                },
            }
        );

        await act(async () => {
            await result.current.confirmDeleteChannel();
        });

        expect(executeDeleteSelectedChannel).toHaveBeenCalledTimes(1);

        const errorState2 = createErrorState();
        const uiGuards2 = createUiGuards({
            disableChannelDeletion: true,
            channelDeletionDisabledReason: "Blocked now",
        });

        rerender({
            errorState: errorState2,
            settingsState: createSettingsState(),
            channelsState: createChannelsState(),
            mediaLibrary: createMediaLibrary(),
            uiGuards: uiGuards2,
        });

        await act(async () => {
            await result.current.confirmDeleteChannel();
        });

        expect(executeDeleteSelectedChannel).toHaveBeenCalledTimes(1);
        expect(errorState2.showError).toHaveBeenCalledWith("Blocked now");
    });
});