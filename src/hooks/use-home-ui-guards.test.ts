import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHomeUiGuards } from "./use-home-ui-guards";

describe("useHomeUiGuards", () => {
    function createSettingsState(overrides?: Partial<any>) {
        return {
            settingsOpen: false,
            settings: {
                importMode: "copy" as const,
                libraryPath: "/library",
                loadRemoteImages: true,
                checkUpdatesOnStartup: false,
            },
            isPreparingSettings: false,
            isMigratingLibraryPath: false,
            openSettings: vi.fn(),
            closeSettings: vi.fn(),
            setImportMode: vi.fn(),
            setLoadRemoteImages: vi.fn(),
            setCheckUpdatesOnStartup: vi.fn(),
            chooseLibraryPath: vi.fn(),
            openCurrentLibraryPath: vi.fn(),
            ...overrides,
        };
    }

    function createMediaLibrary(overrides?: Partial<any>) {
        return {
            mediaItems: [],

            addMediaOpen: true,
            setAddMediaOpen: vi.fn(),
            closeAddMediaModal: vi.fn().mockResolvedValue(undefined),

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
                openInYoutube: vi.fn().mockResolvedValue(undefined),
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
            editTitle: vi.fn(),
            saveMediaProgress: vi.fn(),

            openMediaFileLocation: vi.fn(),
            openMediaSourceInYoutube: vi.fn(),

            requestDeleteMedia: vi.fn(),
            confirmDeleteMedia: vi.fn(),
            closeDeleteMediaModal: vi.fn(),

            clearMediaAndPlayer: vi.fn(),

            ...overrides,
        };
    }

    function createChannelsState(overrides?: Partial<any>) {
        return {
            isUpdatingChannelAvatar: false,
            ...overrides,
        };
    }

    it("disables library path change during migration", () => {
        const { result } = renderHook(() =>
            useHomeUiGuards({
                settingsState: createSettingsState({
                    isMigratingLibraryPath: true,
                }),
                mediaLibrary: createMediaLibrary(),
                channelsState: createChannelsState(),
            })
        );

        expect(result.current.disableLibraryPathChange).toBe(true);
        expect(result.current.libraryPathChangeDisabledReason).not.toBe("");
    });

    it("disables library path change while generating thumbnail", () => {
        const mediaLibrary = createMediaLibrary({
            addMediaForm: {
                ...createMediaLibrary().addMediaForm,
                isGeneratingThumb: true,
            },
        });

        const { result } = renderHook(() =>
            useHomeUiGuards({
                settingsState: createSettingsState(),
                mediaLibrary,
                channelsState: createChannelsState(),
            })
        );

        expect(result.current.disableLibraryPathChange).toBe(true);
        expect(result.current.libraryPathChangeDisabledReason).not.toBe("");
    });

    it("disables library path change while updating channel avatar", () => {
        const { result } = renderHook(() =>
            useHomeUiGuards({
                settingsState: createSettingsState(),
                mediaLibrary: createMediaLibrary(),
                channelsState: createChannelsState({
                    isUpdatingChannelAvatar: true,
                }),
            })
        );

        expect(result.current.disableLibraryPathChange).toBe(true);
        expect(result.current.libraryPathChangeDisabledReason).toContain("avatar");
    });

    it("does not close add media modal when locked", async () => {
        const mediaLibrary = createMediaLibrary({
            isAddingMedia: true,
        });

        const { result } = renderHook(() =>
            useHomeUiGuards({
                settingsState: createSettingsState(),
                mediaLibrary,
                channelsState: createChannelsState(),
            })
        );

        await act(async () => {
            await result.current.closeAddMediaModalSafely();
        });

        expect(mediaLibrary.closeAddMediaModal).not.toHaveBeenCalled();
    });

    it("closes add media modal when unlocked", async () => {
        const mediaLibrary = createMediaLibrary();

        const { result } = renderHook(() =>
            useHomeUiGuards({
                settingsState: createSettingsState(),
                mediaLibrary,
                channelsState: createChannelsState(),
            })
        );

        await act(async () => {
            await result.current.closeAddMediaModalSafely();
        });

        expect(mediaLibrary.closeAddMediaModal).toHaveBeenCalledTimes(1);
    });

    it("shows the migration message when migrating and a library path already exists", () => {
        const { result } = renderHook(() =>
            useHomeUiGuards({
                settingsState: createSettingsState({
                    isMigratingLibraryPath: true,
                    settings: {
                        importMode: "copy",
                        libraryPath: "/library",
                        loadRemoteImages: true,
                        checkUpdatesOnStartup: false,
                    },
                }),
                mediaLibrary: createMediaLibrary(),
                channelsState: createChannelsState(),
            })
        );

        expect(result.current.libraryPathChangeDisabledReason).toBe(
            "Library migration is in progress."
        );
    });

    it("shows the folder setup message when migrating without an existing library path", () => {
        const { result } = renderHook(() =>
            useHomeUiGuards({
                settingsState: createSettingsState({
                    isMigratingLibraryPath: true,
                    settings: {
                        importMode: "copy",
                        libraryPath: "",
                        loadRemoteImages: true,
                        checkUpdatesOnStartup: false,
                    },
                }),
                mediaLibrary: createMediaLibrary(),
                channelsState: createChannelsState(),
            })
        );

        expect(result.current.libraryPathChangeDisabledReason).toBe(
            "Library folder setup is in progress."
        );
    });

    it("treats a whitespace-only library path as not existing while migrating", () => {
        const { result } = renderHook(() =>
            useHomeUiGuards({
                settingsState: createSettingsState({
                    isMigratingLibraryPath: true,
                    settings: {
                        importMode: "copy",
                        libraryPath: "   ",
                        loadRemoteImages: true,
                        checkUpdatesOnStartup: false,
                    },
                }),
                mediaLibrary: createMediaLibrary(),
                channelsState: createChannelsState(),
            })
        );

        expect(result.current.libraryPathChangeDisabledReason).toBe(
            "Library folder setup is in progress."
        );
    });

    it("keeps the library path and channel deletion guards unblocked when nothing is busy", () => {
        const { result } = renderHook(() =>
            useHomeUiGuards({
                settingsState: createSettingsState(),
                mediaLibrary: createMediaLibrary(),
                channelsState: createChannelsState(),
            })
        );

        expect(result.current.libraryPathChangeDisabledReason).toBe("");
        expect(result.current.disableLibraryPathChange).toBe(false);
        expect(result.current.channelDeletionDisabledReason).toBe("");
        expect(result.current.disableChannelDeletion).toBe(false);
    });

    it("disables library path change when the player is open and nothing else is blocking", () => {
        const mediaLibrary = createMediaLibrary({
            mediaPlayer: {
                ...createMediaLibrary().mediaPlayer,
                viewMode: "player" as const,
            },
        });

        const { result } = renderHook(() =>
            useHomeUiGuards({
                settingsState: createSettingsState(),
                mediaLibrary,
                channelsState: createChannelsState(),
            })
        );

        expect(result.current.libraryPathChangeDisabledReason).toBe(
            "Close the player before changing the library folder."
        );
        expect(result.current.disableLibraryPathChange).toBe(true);
    });

    it("disables channel deletion while a media operation is busy", () => {
        const { result } = renderHook(() =>
            useHomeUiGuards({
                settingsState: createSettingsState(),
                mediaLibrary: createMediaLibrary({ isAddingMedia: true }),
                channelsState: createChannelsState(),
            })
        );

        expect(result.current.channelDeletionDisabledReason).toBe(
            "Wait for the media import or download to finish before deleting a channel."
        );
        expect(result.current.disableChannelDeletion).toBe(true);
    });

    it("recomputes channel deletion guard state when the media busy state changes across rerenders", () => {
        const { result, rerender } = renderHook((props: any) => useHomeUiGuards(props), {
            initialProps: {
                settingsState: createSettingsState(),
                mediaLibrary: createMediaLibrary(),
                channelsState: createChannelsState(),
            },
        });

        expect(result.current.channelDeletionDisabledReason).toBe("");
        expect(result.current.disableChannelDeletion).toBe(false);

        rerender({
            settingsState: createSettingsState(),
            mediaLibrary: createMediaLibrary({ isYtDlpRunning: true }),
            channelsState: createChannelsState(),
        });

        expect(result.current.channelDeletionDisabledReason).toBe(
            "Wait for the media import or download to finish before deleting a channel."
        );
        expect(result.current.disableChannelDeletion).toBe(true);
    });

    it("recomputes library path guard state when migration starts across rerenders", () => {
        const { result, rerender } = renderHook((props: any) => useHomeUiGuards(props), {
            initialProps: {
                settingsState: createSettingsState(),
                mediaLibrary: createMediaLibrary(),
                channelsState: createChannelsState(),
            },
        });

        expect(result.current.libraryPathChangeDisabledReason).toBe("");
        expect(result.current.disableLibraryPathChange).toBe(false);

        rerender({
            settingsState: createSettingsState({ isMigratingLibraryPath: true }),
            mediaLibrary: createMediaLibrary(),
            channelsState: createChannelsState(),
        });

        expect(result.current.libraryPathChangeDisabledReason).toBe(
            "Library migration is in progress."
        );
        expect(result.current.disableLibraryPathChange).toBe(true);
    });

    it("recomputes closeAddMediaModalSafely to reflect the latest media busy state across rerenders", async () => {
        const initialMediaLibrary = createMediaLibrary();

        const { result, rerender } = renderHook((props: any) => useHomeUiGuards(props), {
            initialProps: {
                settingsState: createSettingsState(),
                mediaLibrary: initialMediaLibrary,
                channelsState: createChannelsState(),
            },
        });

        const busyMediaLibrary = createMediaLibrary({ isAddingMedia: true });

        rerender({
            settingsState: createSettingsState(),
            mediaLibrary: busyMediaLibrary,
            channelsState: createChannelsState(),
        });

        await act(async () => {
            await result.current.closeAddMediaModalSafely();
        });

        expect(busyMediaLibrary.closeAddMediaModal).not.toHaveBeenCalled();
        expect(initialMediaLibrary.closeAddMediaModal).not.toHaveBeenCalled();
    });
});