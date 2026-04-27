import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useHomeMediaActions } from "./use-home-media-actions";

describe("useHomeMediaActions", () => {
    function createDiagnosticsState(overrides?: Partial<any>) {
        return {
            diagnosticsOpen: false,
            setDiagnosticsOpen: vi.fn(),
            diagnosticsSummary: null,
            isLoadingDiagnostics: false,
            openDiagnostics: vi.fn(),
            closeDiagnostics: vi.fn(),
            reloadDiagnostics: vi.fn().mockResolvedValue(undefined),
            ...overrides,
        };
    }

    function createMediaLibrary(overrides?: Partial<any>) {
        return {
            mediaItems: [],

            addMediaOpen: false,
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

            loadMedia: vi.fn(),
            addMedia: vi.fn().mockResolvedValue(undefined),
            cancelYtDlpDownload: vi.fn(),

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

            ...overrides,
        };
    }

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("adds media without reloading diagnostics when diagnostics is closed", async () => {
        const diagnosticsState = createDiagnosticsState({
            diagnosticsOpen: false,
        });
        const mediaLibrary = createMediaLibrary();

        const { result } = renderHook(() =>
            useHomeMediaActions({
                diagnosticsState,
                mediaLibrary,
                channelsState: {
                    selectedChannelId: 10,
                },
                confirmDeleteChannelFlow: vi.fn().mockResolvedValue(undefined),
            })
        );

        await act(async () => {
            await result.current.addMedia();
        });

        expect(mediaLibrary.addMedia).toHaveBeenCalledTimes(1);
        expect(diagnosticsState.reloadDiagnostics).not.toHaveBeenCalled();
    });

    it("reloads diagnostics after adding media when diagnostics is open", async () => {
        const diagnosticsState = createDiagnosticsState({
            diagnosticsOpen: true,
        });
        const mediaLibrary = createMediaLibrary();

        const { result } = renderHook(() =>
            useHomeMediaActions({
                diagnosticsState,
                mediaLibrary,
                channelsState: {
                    selectedChannelId: 10,
                },
                confirmDeleteChannelFlow: vi.fn().mockResolvedValue(undefined),
            })
        );

        await act(async () => {
            await result.current.addMedia();
        });

        expect(mediaLibrary.addMedia).toHaveBeenCalledTimes(1);
        expect(diagnosticsState.reloadDiagnostics).toHaveBeenCalledTimes(1);
    });

    it("reloads diagnostics after confirming media delete when diagnostics is open", async () => {
        const diagnosticsState = createDiagnosticsState({
            diagnosticsOpen: true,
        });
        const mediaLibrary = createMediaLibrary();

        const { result } = renderHook(() =>
            useHomeMediaActions({
                diagnosticsState,
                mediaLibrary,
                channelsState: {
                    selectedChannelId: 10,
                },
                confirmDeleteChannelFlow: vi.fn().mockResolvedValue(undefined),
            })
        );

        await act(async () => {
            await result.current.confirmDeleteMedia();
        });

        expect(mediaLibrary.confirmDeleteMedia).toHaveBeenCalledTimes(1);
        expect(diagnosticsState.reloadDiagnostics).toHaveBeenCalledTimes(1);
    });

    it("reloads diagnostics after confirming channel delete when diagnostics is open", async () => {
        const diagnosticsState = createDiagnosticsState({
            diagnosticsOpen: true,
        });
        const confirmDeleteChannelFlow = vi.fn().mockResolvedValue(undefined);

        const { result } = renderHook(() =>
            useHomeMediaActions({
                diagnosticsState,
                mediaLibrary: createMediaLibrary(),
                channelsState: {
                    selectedChannelId: 10,
                },
                confirmDeleteChannelFlow,
            })
        );

        await act(async () => {
            await result.current.confirmDeleteChannel();
        });

        expect(confirmDeleteChannelFlow).toHaveBeenCalledTimes(1);
        expect(diagnosticsState.reloadDiagnostics).toHaveBeenCalledTimes(1);
    });

    it("reloads diagnostics after marking media as watched", async () => {
        const diagnosticsState = createDiagnosticsState({
            diagnosticsOpen: true,
        });
        const mediaLibrary = createMediaLibrary();

        const { result } = renderHook(() =>
            useHomeMediaActions({
                diagnosticsState,
                mediaLibrary,
                channelsState: {
                    selectedChannelId: 10,
                },
                confirmDeleteChannelFlow: vi.fn().mockResolvedValue(undefined),
            })
        );

        await act(async () => {
            await result.current.markAsWatched(15);
        });

        expect(mediaLibrary.markAsWatched).toHaveBeenCalledWith(15);
        expect(diagnosticsState.reloadDiagnostics).toHaveBeenCalledTimes(1);
    });

    it("reloads diagnostics after marking media as unwatched", async () => {
        const diagnosticsState = createDiagnosticsState({
            diagnosticsOpen: true,
        });
        const mediaLibrary = createMediaLibrary();

        const { result } = renderHook(() =>
            useHomeMediaActions({
                diagnosticsState,
                mediaLibrary,
                channelsState: {
                    selectedChannelId: 10,
                },
                confirmDeleteChannelFlow: vi.fn().mockResolvedValue(undefined),
            })
        );

        await act(async () => {
            await result.current.markAsUnwatched(20);
        });

        expect(mediaLibrary.markAsUnwatched).toHaveBeenCalledWith(20);
        expect(diagnosticsState.reloadDiagnostics).toHaveBeenCalledTimes(1);
    });
});